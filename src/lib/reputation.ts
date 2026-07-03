import { and, eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { agents, deliveries, disputes, listings, orders } from '@/db/schema';

// The reputation engine. Server-side only, computed exclusively from ledger/
// order/verification-derived data — never self-reported. Rolling score:
// pass rate, override-needed rate, dispute losses, on-time rate,
// volume-weighted, recency-decayed.

export interface ReputationComponents {
  score: number; // 0-100
  seller_settled_count: number;
  buyer_settled_count: number;
  pass_rate: number | null; // recency-weighted, sellers only
  on_time_rate: number | null;
  override_needed_rate: number | null;
  dispute_loss_rate: number | null;
}

const HALF_LIFE_DAYS = 30;
const VOLUME_SATURATION = 20; // full confidence in the signal after ~20 orders
const BASELINE = 0.5; // a brand-new agent sits at 50

function decay(settledAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - settledAt.getTime()) / 86_400_000);
  return 2 ** (-ageDays / HALF_LIFE_DAYS);
}

export async function computeReputation(
  db: Db | Tx,
  agentId: string,
  now = new Date(),
): Promise<ReputationComponents> {
  const SETTLED = ['settled_released', 'settled_refund', 'settled_override'] as const;

  // --- as seller -----------------------------------------------------------
  const sellerOrders = await db
    .select({
      id: orders.id,
      state: orders.state,
      settledAt: orders.settledAt,
      deadlineAt: orders.deadlineAt,
    })
    .from(orders)
    .innerJoin(listings, eq(orders.listingId, listings.id))
    .where(and(eq(listings.sellerAgentId, agentId), inArray(orders.state, [...SETTLED])));

  const orderIds = sellerOrders.map((o) => o.id);
  const deliveredAt = new Map<string, Date>();
  if (orderIds.length > 0) {
    const deliveryRows = await db
      .select({ orderId: deliveries.orderId, submittedAt: deliveries.submittedAt })
      .from(deliveries)
      .where(inArray(deliveries.orderId, orderIds));
    for (const d of deliveryRows) {
      const existing = deliveredAt.get(d.orderId);
      if (!existing || d.submittedAt < existing) deliveredAt.set(d.orderId, d.submittedAt);
    }
  }

  const disputeRows =
    orderIds.length > 0
      ? await db
          .select({ orderId: disputes.orderId, resolution: disputes.resolution, state: disputes.state })
          .from(disputes)
          .where(inArray(disputes.orderId, orderIds))
      : [];
  const disputeLost = new Set(
    disputeRows
      .filter(
        (d) =>
          d.state === 'resolved' &&
          (d.resolution as { verdict?: string } | null)?.verdict === 'FAIL',
      )
      .map((d) => d.orderId),
  );

  let wSum = 0;
  let passW = 0;
  let onTimeW = 0;
  let onTimeDen = 0;
  let overrideW = 0;
  let disputeLossW = 0;
  for (const o of sellerOrders) {
    const w = decay(o.settledAt ?? now, now);
    wSum += w;
    // outcome value: clean pass 1.0, buyer-forgiven fail 0.5, refund 0.
    if (o.state === 'settled_released') passW += w;
    else if (o.state === 'settled_override') passW += 0.5 * w;
    if (o.state === 'settled_override') overrideW += w;
    if (disputeLost.has(o.id)) disputeLossW += w;
    const delivered = deliveredAt.get(o.id);
    if (delivered) {
      onTimeDen += w;
      if (delivered <= o.deadlineAt) onTimeW += w;
    }
  }

  // --- as buyer ------------------------------------------------------------
  const buyerOrders = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.buyerAgentId, agentId), inArray(orders.state, [...SETTLED])));

  const n = sellerOrders.length + buyerOrders.length;
  const passRate = wSum > 0 ? passW / wSum : null;
  const onTimeRate = onTimeDen > 0 ? onTimeW / onTimeDen : null;
  const overrideRate = wSum > 0 ? overrideW / wSum : null;
  const disputeLossRate = wSum > 0 ? disputeLossW / wSum : null;

  // Blend: sellers are scored on outcomes; pure buyers drift up slowly with
  // settled volume (they demonstrate they pay and don't game).
  let quality: number;
  if (passRate !== null) {
    quality =
      0.65 * passRate +
      0.2 * (onTimeRate ?? passRate) +
      0.15 * (1 - (disputeLossRate ?? 0));
  } else {
    quality = 0.75; // buyers with settled history, no seller record
  }

  // Volume confidence: the score only moves away from baseline as evidence
  // accumulates; saturates around VOLUME_SATURATION settled orders.
  const volume = Math.min(1, Math.log1p(n) / Math.log1p(VOLUME_SATURATION));
  const score = Math.round(100 * (BASELINE + volume * (quality - BASELINE)));

  return {
    score: Math.max(0, Math.min(100, score)),
    seller_settled_count: sellerOrders.length,
    buyer_settled_count: buyerOrders.length,
    pass_rate: passRate,
    on_time_rate: onTimeRate,
    override_needed_rate: overrideRate,
    dispute_loss_rate: disputeLossRate,
  };
}

/** Recompute and persist an agent's score (called after every settlement). */
export async function recomputeAndStore(db: Db | Tx, agentId: string): Promise<number> {
  const components = await computeReputation(db, agentId);
  await db
    .update(agents)
    .set({ reputationScore: components.score })
    .where(eq(agents.id, agentId));
  return components.score;
}
