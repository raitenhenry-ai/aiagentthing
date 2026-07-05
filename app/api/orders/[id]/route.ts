import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { listings, orders, verifications } from '@/db/schema';
import { authenticateAgent } from '@/lib/auth';
import { ApiError, json, route } from '@/lib/http';
import { authorizationFor, buyerDeliverableVisible } from '@/lib/payments/authorizations';
import type { CriterionResult, JudgeVerdict } from '@/lib/verification/judge';
import type { VerificationRecord } from '@/lib/verification/run';

export const GET = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);

  const rows = await db
    .select({
      order: orders,
      sellerAgentId: listings.sellerAgentId,
    })
    .from(orders)
    .innerJoin(listings, eq(orders.listingId, listings.id))
    .where(eq(orders.id, ctx.params.id));
  const row = rows[0];
  if (!row) throw new ApiError('not_found', 'Order not found', 404);
  const { order, sellerAgentId } = row;

  const isBuyer = agent.id === order.buyerAgentId;
  const isSeller = agent.id === sellerAgentId;
  if (!isBuyer && !isSeller) throw new ApiError('not_found', 'Order not found', 404);

  const verificationRows = await db
    .select()
    .from(verifications)
    .where(eq(verifications.orderId, order.id))
    .orderBy(desc(verifications.completedAt))
    .limit(1);
  const verification = verificationRows[0];

  // Sellers get per-criterion results only — never judge reasoning (which is
  // stored hashed anyway) and never raw confidence per judge.
  const verificationView = verification
    ? {
        verdict: verification.aggregateVerdict,
        confidence: verification.aggregateConfidence,
        tier: verification.tier,
        completed_at: verification.completedAt.toISOString(),
        criteria_results: summarizeRecord(
          verification.judgeVerdicts as unknown as VerificationRecord,
        ),
      }
    : null;

  // Non-custodial orders: tell the buyer whether the deliverable is
  // readable yet (locked until their payment actually executes; a FAILed
  // verification unlocks it since no money moves).
  let settlement: Record<string, unknown> = { mode: order.settlementMode };
  if (order.settlementMode === 'authorization') {
    const auth = await authorizationFor(db, order.id);
    settlement = {
      mode: 'authorization',
      payment_status: auth?.status ?? 'none',
      payment_tx_hash: auth?.txHash ?? null,
      deliverable_visible_to_buyer: buyerDeliverableVisible(order, auth),
    };
  }

  return json({
    id: order.id,
    listing_id: order.listingId,
    listing_version: order.listingVersion,
    buyer_agent_id: order.buyerAgentId,
    seller_agent_id: sellerAgentId,
    role: isBuyer ? 'buyer' : 'seller',
    state: order.state,
    price_credits: order.priceCredits,
    input_payload: order.inputPayload,
    created_at: order.createdAt.toISOString(),
    deadline_at: order.deadlineAt.toISOString(),
    fail_window_ends_at: order.failWindowEndsAt?.toISOString() ?? null,
    settled_at: order.settledAt?.toISOString() ?? null,
    settlement,
    verification: verificationView,
  });
});

// Parties see per-criterion outcomes only — never judge reasoning (stored
// hashed) and never individual judge identities/verdicts.
function summarizeRecord(record: VerificationRecord): CriterionResult[] {
  const machine: CriterionResult[] = (record.machine_results ?? []).map((r) => ({
    criterionId: r.criterionId,
    verdict: r.verdict,
    confidence: r.confidence,
  }));
  const lastRun = record.runs?.[record.runs.length - 1] ?? [];
  return [...machine, ...summarizeCriteria(lastRun)];
}

function summarizeCriteria(verdicts: JudgeVerdict[]): CriterionResult[] {
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
    verdict: agg.pass * 2 > agg.total ? 'PASS' : 'FAIL',
    confidence: agg.confidence / agg.total,
  }));
}
