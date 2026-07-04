import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { deliveries, listings, listingVersions, orders, verifications } from '@/db/schema';
import { inngest, isInngestConfigured } from '@/inngest/client';
import { emitWebhookEvent } from '../webhooks';
import { acceptanceCriteriaSchema, isLowVerifiability, type AcceptanceCriteria } from '../criteria';
import { newId } from '../ids';
import { transitionOrder } from '../state-machine';
import { runMachineCriterion, type CheckResult } from './checkers';
import { scanForInjection, type InjectionScan } from './injection';
import {
  aggregateVerdicts,
  type CriterionResult,
  type Judge,
  type JudgeVerdict,
  type Verdict,
} from './judge';
import { realJudges } from './llm-judge';
import { StubJudge } from './stub-judge';
import { requireRealJudges } from '../env';

/**
 * The active panel: the real Claude/GPT/Grok judges when provider keys are
 * configured, otherwise a single always-PASS stub so local dev runs without
 * any provider account.
 */
export function defaultPanel(): Judge[] {
  const judges = realJudges();
  return judges.length > 0 ? judges : [new StubJudge()];
}

export interface VerificationRecord {
  machine_results: CheckResult[];
  runs: JudgeVerdict[][];
  injection: InjectionScan;
  low_verifiability: boolean;
  short_circuited: boolean;
  /** True when judged criteria could not be evaluated because no real judge
   * was configured — the order failed closed to protect the buyer. */
  no_judge_configured?: boolean;
}

interface OrderMaterials {
  orderId: string;
  criteria: AcceptanceCriteria;
  inputPayload: unknown;
  artifacts: unknown[];
  receipts: unknown[];
}

export async function loadOrderMaterials(db: Db, orderId: string): Promise<OrderMaterials> {
  const orderRows = await db
    .select({
      id: orders.id,
      listingId: orders.listingId,
      listingVersion: orders.listingVersion,
      inputPayload: orders.inputPayload,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  const order = orderRows[0];
  if (!order) throw new Error(`Order ${orderId} not found`);

  const versionRows = await db
    .select({ acceptanceCriteria: listingVersions.acceptanceCriteria })
    .from(listingVersions)
    .where(
      and(
        eq(listingVersions.listingId, order.listingId),
        eq(listingVersions.version, order.listingVersion),
      ),
    );
  const version = versionRows[0];
  if (!version) {
    throw new Error(`Listing version ${order.listingId}@${order.listingVersion} not found`);
  }

  const deliveryRows = await db
    .select({ artifacts: deliveries.artifacts, receipts: deliveries.receipts })
    .from(deliveries)
    .where(eq(deliveries.orderId, orderId))
    .orderBy(desc(deliveries.submittedAt))
    .limit(1);
  const delivery = deliveryRows[0];
  if (!delivery) throw new Error(`No delivery found for order ${orderId}`);

  return {
    orderId,
    criteria: acceptanceCriteriaSchema.parse(version.acceptanceCriteria),
    inputPayload: order.inputPayload,
    artifacts: (delivery.artifacts as unknown[]) ?? [],
    receipts: (delivery.receipts as unknown[]) ?? [],
  };
}

/** MVP convention: the primary payload is artifacts[0].inline (or artifacts[0]). */
export function primaryPayload(artifacts: unknown[]): unknown {
  const first = artifacts[0];
  if (first && typeof first === 'object' && 'inline' in (first as Record<string, unknown>)) {
    return (first as Record<string, unknown>).inline;
  }
  return first;
}

function parsePassRule(rule: string): (results: CriterionResult[]) => Verdict {
  if (rule.startsWith('weighted:')) {
    const threshold = Number.parseFloat(rule.slice('weighted:'.length));
    return (results) => {
      const passed = results.filter((r) => r.verdict === 'PASS').length;
      return passed / Math.max(results.length, 1) >= threshold ? 'PASS' : 'FAIL';
    };
  }
  return (results) => (results.every((r) => r.verdict === 'PASS') ? 'PASS' : 'FAIL');
}

/** Majority per criterion across the panel's individual verdicts. */
function judgedCriteriaConsensus(verdicts: JudgeVerdict[]): CriterionResult[] {
  const byId = new Map<string, { pass: number; total: number; confidence: number }>();
  for (const v of verdicts) {
    for (const cr of v.criteriaResults) {
      const agg = byId.get(cr.criterionId) ?? { pass: 0, total: 0, confidence: 0 };
      agg.pass += cr.verdict === 'PASS' ? 1 : 0;
      agg.total += 1;
      agg.confidence += cr.confidence;
      byId.set(cr.criterionId, agg);
    }
  }
  return [...byId.entries()].map(([criterionId, agg]) => ({
    criterionId,
    verdict: agg.pass * 2 > agg.total ? 'PASS' : ('FAIL' as Verdict),
    confidence: agg.confidence / Math.max(agg.total, 1),
  }));
}

export interface PanelOutcome {
  verdict: Verdict;
  confidence: number;
  tier: 'auto' | 'panel' | 'dispute';
  criteriaResults: CriterionResult[];
  record: VerificationRecord;
}

/**
 * Judge a delivered order's materials without touching order state:
 * machine criteria first (free, deterministic, can short-circuit), then the
 * judge panel for `judged` criteria, with one fresh re-run on splits or low
 * confidence before the verdict is downgraded to the appealable `panel` tier.
 */
export async function judgeMaterials(
  materials: OrderMaterials,
  panel: Judge[],
): Promise<PanelOutcome> {
  const { criteria } = materials;
  const payload = primaryPayload(materials.artifacts);
  const checkCtx = {
    payload,
    artifacts: materials.artifacts,
    receipts: materials.receipts,
    inputPayload: materials.inputPayload,
  };

  const injection = scanForInjection([materials.artifacts, materials.receipts]);
  const lowVerifiability = isLowVerifiability(criteria);
  const passRule = parsePassRule(criteria.pass_rule);

  const machineCriteria = criteria.criteria.filter((c) => c.type !== 'judged');
  const judgedCriteria = criteria.criteria.filter((c) => c.type === 'judged');

  const machineResults: CheckResult[] = [];
  for (const criterion of machineCriteria) {
    machineResults.push(await runMachineCriterion(criterion, checkCtx));
  }

  // Short-circuit: under pass_rule "all", any deterministic FAIL is final —
  // no judge spend on work that provably broke its contract.
  const machineFailed = machineResults.some((r) => r.verdict === 'FAIL');
  if (criteria.pass_rule === 'all' && machineFailed) {
    return {
      verdict: 'FAIL',
      confidence: 1,
      tier: 'auto',
      criteriaResults: machineResults,
      record: {
        machine_results: machineResults,
        runs: [],
        injection,
        low_verifiability: lowVerifiability,
        short_circuited: true,
      },
    };
  }

  const runs: JudgeVerdict[][] = [];
  let judgedResults: CriterionResult[] = [];
  let panelUnanimousHighConf = true;

  if (judgedCriteria.length > 0) {
    const judgeInput = {
      criteria: { ...criteria, criteria: judgedCriteria },
      inputPayload: materials.inputPayload,
      artifacts: materials.artifacts,
      receipts: materials.receipts,
    };
    // Judges run independently: same inputs, no seller identity, no sight of
    // each other's verdicts.
    let verdicts = await Promise.all(panel.map((j) => j.evaluate(judgeInput)));
    runs.push(verdicts);
    let agg = aggregateVerdicts(verdicts);

    if (agg.tier !== 'auto' && panel.length > 1) {
      // Split or low confidence → one re-run with fresh sampling (and a
      // freshly rotated rubric wrapper) before conceding to panel tier.
      verdicts = await Promise.all(panel.map((j) => j.evaluate(judgeInput)));
      runs.push(verdicts);
      agg = aggregateVerdicts(verdicts);
    }
    panelUnanimousHighConf = agg.tier === 'auto';
    judgedResults = judgedCriteriaConsensus(verdicts);
  }

  const criteriaResults = [...machineResults, ...judgedResults];
  const verdict = passRule(criteriaResults);
  const confidence =
    criteriaResults.reduce((s, c) => s + c.confidence, 0) / Math.max(criteriaResults.length, 1);

  // Tier routing: pure machine verification is auto; any judged involvement
  // requires unanimity + high confidence for auto; listings with zero
  // machine-checkable criteria always route to panel tier.
  const tier: PanelOutcome['tier'] =
    judgedCriteria.length === 0
      ? 'auto'
      : lowVerifiability || !panelUnanimousHighConf
        ? 'panel'
        : 'auto';

  return {
    verdict,
    confidence,
    tier,
    criteriaResults,
    record: {
      machine_results: machineResults,
      runs,
      injection,
      low_verifiability: lowVerifiability,
      short_circuited: false,
    },
  };
}

/**
 * Fail-closed outcome for an order whose acceptance criteria include a
 * `judged` requirement when no real judge provider is configured. The
 * always-PASS dev stub must not settle real money, so we run the machine
 * criteria for the record, mark the judged criteria unverified (FAIL), and
 * route to `dispute` tier — funds stay in escrow for the buyer (who may still
 * `override_accept` to pay) instead of auto-releasing to the seller.
 */
async function unverifiedJudgedOutcome(materials: OrderMaterials): Promise<PanelOutcome> {
  const payload = primaryPayload(materials.artifacts);
  const checkCtx = {
    payload,
    artifacts: materials.artifacts,
    receipts: materials.receipts,
    inputPayload: materials.inputPayload,
  };
  const injection = scanForInjection([materials.artifacts, materials.receipts]);
  const machineCriteria = materials.criteria.criteria.filter((c) => c.type !== 'judged');
  const judgedCriteria = materials.criteria.criteria.filter((c) => c.type === 'judged');
  const machineResults: CheckResult[] = [];
  for (const criterion of machineCriteria) {
    machineResults.push(await runMachineCriterion(criterion, checkCtx));
  }
  const judgedResults: CriterionResult[] = judgedCriteria.map((c) => ({
    criterionId: c.id,
    verdict: 'FAIL',
    confidence: 0,
  }));
  return {
    verdict: 'FAIL',
    confidence: 0,
    tier: 'dispute',
    criteriaResults: [...machineResults, ...judgedResults],
    record: {
      machine_results: machineResults,
      runs: [],
      injection,
      low_verifiability: isLowVerifiability(materials.criteria),
      short_circuited: false,
      no_judge_configured: true,
    },
  };
}

/**
 * Full verification for a delivered order: delivered → verifying → panel →
 * passed/failed, and on PASS straight through to settlement. Phase 1 ran the
 * stub synchronously; Phase 2 keeps the same entry point and adds the real
 * pipeline (Inngest calls this from a background job when configured).
 */
export async function runVerification(
  db: Db,
  orderId: string,
  panel?: Judge[],
): Promise<{ verdict: Verdict; verificationId: string }> {
  // An explicit panel (tests, or a deployment injecting real judges) is
  // trusted as given. Only the default fallback can degrade to the stub, and
  // only that path is guarded below.
  const usingDefaultPanel = panel === undefined;
  const activePanel = panel ?? defaultPanel();
  // Idempotent entry: safe to retry after judge/provider failures. An order
  // already past verification returns its recorded verdict; one stuck in
  // `verifying` (a crashed prior run) resumes without a state transition.
  const stateRows = await db
    .select({ state: orders.state })
    .from(orders)
    .where(eq(orders.id, orderId));
  const state = stateRows[0]?.state;
  if (!state) throw new Error(`Order ${orderId} not found`);
  if (state !== 'delivered' && state !== 'verifying') {
    const existing = await db
      .select({ id: verifications.id, verdict: verifications.aggregateVerdict })
      .from(verifications)
      .where(eq(verifications.orderId, orderId))
      .orderBy(desc(verifications.completedAt))
      .limit(1);
    if (existing[0]) return { verdict: existing[0].verdict, verificationId: existing[0].id };
    throw new Error(`Order ${orderId} is ${state} with no verification record`);
  }
  if (state === 'delivered') {
    await transitionOrder(db, { orderId, to: 'verifying', actor: 'system' });
  }
  const materials = await loadOrderMaterials(db, orderId);
  const hasJudged = materials.criteria.criteria.some((c) => c.type === 'judged');
  const panelIsAuthoritative = activePanel.some((j) => j.authoritative !== false);

  // Fail closed: on the default panel, if judged criteria are present but no
  // real judge is configured (only the always-PASS stub), do NOT settle. An
  // explicitly-passed panel (tests, injected real judges) is trusted as given.
  const outcome =
    usingDefaultPanel && hasJudged && !panelIsAuthoritative && requireRealJudges()
      ? await unverifiedJudgedOutcome(materials)
      : await judgeMaterials(materials, activePanel);
  if (outcome.record.no_judge_configured) {
    console.warn(
      `[verification] order ${orderId}: judged criteria present but no real judge configured — ` +
        `failing closed, funds held for the buyer. Configure a judge provider key ` +
        `(ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY), or set REQUIRE_REAL_JUDGES=false ` +
        `to allow the dev stub to auto-pass.`,
    );
  }

  const verificationId = newId('vrf');
  await db.insert(verifications).values({
    id: verificationId,
    orderId,
    judgeVerdicts: outcome.record,
    aggregateVerdict: outcome.verdict,
    aggregateConfidence: outcome.confidence,
    tier: outcome.tier,
  });

  const parties = await orderParties(db, orderId);
  if (outcome.verdict === 'PASS') {
    await transitionOrder(db, { orderId, to: 'passed', actor: 'panel' });
    await transitionOrder(db, { orderId, to: 'settled_released', actor: 'system' });
    emitWebhookEvent(db, {
      event: 'order.settled',
      agentIds: parties,
      payload: { order_id: orderId, state: 'settled_released', verdict: 'PASS', tier: outcome.tier },
    });
  } else {
    const { order } = await transitionOrder(db, { orderId, to: 'failed', actor: 'panel' });
    emitWebhookEvent(db, {
      event: 'order.failed',
      agentIds: parties,
      payload: {
        order_id: orderId,
        state: 'failed',
        verdict: 'FAIL',
        tier: outcome.tier,
        fail_window_ends_at: order.failWindowEndsAt?.toISOString(),
      },
    });
    if (isInngestConfigured() && order.failWindowEndsAt) {
      await inngest.send({
        name: 'order/failed',
        data: { orderId, failWindowEndsAt: order.failWindowEndsAt.toISOString() },
      });
    }
  }
  return { verdict: outcome.verdict, verificationId };
}

async function orderParties(db: Db, orderId: string): Promise<string[]> {
  const rows = await db
    .select({ buyer: orders.buyerAgentId, seller: listings.sellerAgentId })
    .from(orders)
    .innerJoin(listings, eq(orders.listingId, listings.id))
    .where(eq(orders.id, orderId));
  const row = rows[0];
  return row ? [row.buyer, row.seller] : [];
}
