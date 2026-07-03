import { desc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { disputes, orders, verifications } from '@/db/schema';
import { appealDepositBps } from './env';
import { ApiError } from './http';
import { feeFor } from './ledger';
import { newId } from './ids';
import { transitionOrder } from './state-machine';
import type { Judge, Verdict } from './verification/judge';
import { AnthropicJudge, GeminiJudge, OpenAiJudge } from './verification/llm-judge';
import { judgeMaterials, loadOrderMaterials } from './verification/run';
import { StubJudge } from './verification/stub-judge';

/**
 * Appeal panel: 5 judges — the three providers plus a second Claude and a
 * second GPT pinned to *different* rubric wrappers for prompt diversity.
 * Previous verdicts are never provided; majority wins, final. Falls back to
 * stubs when no provider keys are configured (local dev).
 */
export function appealPanel(): Judge[] {
  const judges: Judge[] = [];
  if (process.env.ANTHROPIC_API_KEY) {
    judges.push(new AnthropicJudge({ wrapperIndex: 0 }), new AnthropicJudge({ wrapperIndex: 1 }));
  }
  if (process.env.OPENAI_API_KEY) {
    judges.push(new OpenAiJudge({ wrapperIndex: 2 }), new OpenAiJudge({ wrapperIndex: 0 }));
  }
  if (process.env.GOOGLE_API_KEY) judges.push(new GeminiJudge({ wrapperIndex: 1 }));
  if (judges.length === 0) {
    return Array.from({ length: 5 }, (_, i) => new StubJudge({ model: `stub-appeal-${i}` }));
  }
  return judges.slice(0, 5);
}

/** The x402 deposit quote for appealing an order's FAIL verdict. */
export async function appealDepositFor(
  db: Db,
  orderId: string,
): Promise<{ amountCredits: bigint; freeAppeal: boolean }> {
  const orderRows = await db
    .select({ priceCredits: orders.priceCredits })
    .from(orders)
    .where(eq(orders.id, orderId));
  const order = orderRows[0];
  if (!order) throw new ApiError('not_found', 'Order not found', 404);
  const tierRows = await db
    .select({ tier: verifications.tier })
    .from(verifications)
    .where(eq(verifications.orderId, orderId))
    .orderBy(desc(verifications.completedAt))
    .limit(1);
  // Split/low-confidence (`panel` tier) verdicts are appealable at no fee.
  const freeAppeal = tierRows[0]?.tier === 'panel';
  return {
    amountCredits: freeAppeal ? 0n : feeFor(order.priceCredits, appealDepositBps()),
    freeAppeal,
  };
}

/**
 * Seller appeals a FAIL within the 48h window. Holds the 5% deposit (waived
 * for `panel`-tier verdicts) via the state machine and opens a dispute.
 * An appeal is an appeal, not a veto — resolution can still refund the buyer.
 */
export async function openAppeal(
  db: Db,
  args: { orderId: string; sellerAgentId: string; evidence: unknown },
): Promise<{ disputeId: string }> {
  if (
    args.evidence === undefined ||
    args.evidence === null ||
    (typeof args.evidence === 'object' && Object.keys(args.evidence as object).length === 0)
  ) {
    throw new ApiError('evidence_required', 'Appeals must attach evidence', 422);
  }
  const disputeId = newId('dsp');
  await db.transaction(async (tx) => {
    await transitionOrder(tx, {
      orderId: args.orderId,
      to: 'appealed',
      actor: 'seller',
      agentId: args.sellerAgentId,
    });
    await tx.insert(disputes).values({
      id: disputeId,
      orderId: args.orderId,
      openedBy: args.sellerAgentId,
      evidence: args.evidence,
      state: 'open',
    });
  });
  return { disputeId };
}

/**
 * Resolve an appeal: fresh 5-judge panel over the same materials, previous
 * verdicts hidden, majority final. PASS → release to seller + deposit back;
 * FAIL → refund buyer + deposit forfeited. (Deposit movements happen inside
 * the settling transition.)
 */
export async function resolveAppeal(
  db: Db,
  orderId: string,
  panel: Judge[] = appealPanel(),
): Promise<{ verdict: Verdict }> {
  const disputeRows = await db
    .select()
    .from(disputes)
    .where(eq(disputes.orderId, orderId))
    .orderBy(desc(disputes.id))
    .limit(1);
  const dispute = disputeRows[0];
  if (!dispute || dispute.state !== 'open') {
    throw new ApiError('no_open_dispute', 'No open dispute for this order', 409);
  }

  const materials = await loadOrderMaterials(db, orderId);
  const outcome = await judgeMaterials(materials, panel);

  await db.insert(verifications).values({
    id: newId('vrf'),
    orderId,
    judgeVerdicts: outcome.record,
    aggregateVerdict: outcome.verdict,
    aggregateConfidence: outcome.confidence,
    tier: 'dispute',
  });

  await transitionOrder(db, {
    orderId,
    to: outcome.verdict === 'PASS' ? 'settled_released' : 'settled_refund',
    actor: 'system',
  });

  await db
    .update(disputes)
    .set({
      state: 'resolved',
      resolution: {
        verdict: outcome.verdict,
        confidence: outcome.confidence,
        panel_size: panel.length,
      },
      resolvedAt: new Date(),
    })
    .where(eq(disputes.id, dispute.id));

  return { verdict: outcome.verdict };
}
