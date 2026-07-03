import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { payouts } from '@/db/schema';
import { newId } from '../ids';
import { refundReservedPayout, reserveForPayout, settleReservedPayout } from '../ledger';
import { getRail, type PaymentRail } from './index';

// Settlement (or a withdrawal request) RESERVES the credits and enqueues a
// payout in one transaction; the on-chain transfer executes separately with
// idempotency + retries. A failed transfer never re-runs settlement logic,
// and reserved credits can never be double-spent while a transfer is in
// flight.

export type PayoutReason =
  | 'release'
  | 'refund'
  | 'override'
  | 'deposit_refund'
  | 'withdrawal'
  | 'invoice'
  | 'tip';

/** Reserve credits and enqueue the transfer. Call inside the transaction
 * that credited the agent. */
export async function enqueuePayout(
  tx: Tx,
  args: {
    orderId?: string;
    agentId: string;
    toWallet: string;
    amountCredits: bigint;
    reason: PayoutReason;
  },
): Promise<string> {
  if (args.amountCredits <= 0n) throw new Error('Payout amount must be positive');
  await reserveForPayout(tx, {
    agentId: args.agentId,
    amount: args.amountCredits,
    orderId: args.orderId,
  });
  const id = newId('pay');
  await tx.insert(payouts).values({
    id,
    orderId: args.orderId,
    agentId: args.agentId,
    toWallet: args.toWallet,
    amountCredits: args.amountCredits,
    reason: args.reason,
  });
  return id;
}

/**
 * Execute one pending payout: on-chain USDC transfer (idempotent by payout
 * id), then the reserved credits settle to `external:base` with the tx hash.
 * On failure the payout stays pending with the error recorded — order state
 * and ledger are never touched.
 */
export async function executePayout(
  db: Db,
  payoutId: string,
  rail: PaymentRail = getRail(),
): Promise<{ status: 'confirmed' | 'pending'; txHash?: string }> {
  const rows = await db.select().from(payouts).where(eq(payouts.id, payoutId));
  const payout = rows[0];
  if (!payout) throw new Error(`Payout ${payoutId} not found`);
  if (payout.status === 'confirmed') {
    return { status: 'confirmed', txHash: payout.txHash ?? undefined };
  }
  if (payout.status === 'failed') return { status: 'pending' }; // cancelled

  try {
    const { txHash } = await rail.payout({
      to: payout.toWallet,
      amountCredits: payout.amountCredits,
      idempotencyKey: payout.id,
    });
    await db.transaction(async (tx) => {
      const locked = await tx
        .select({ status: payouts.status })
        .from(payouts)
        .where(eq(payouts.id, payout.id))
        .for('update');
      if (locked[0]?.status !== 'pending') return; // concurrent executor won
      await tx
        .update(payouts)
        .set({
          status: 'confirmed',
          txHash,
          confirmedAt: new Date(),
          attempts: payout.attempts + 1,
        })
        .where(eq(payouts.id, payout.id));
      await settleReservedPayout(tx, {
        amount: payout.amountCredits,
        orderId: payout.orderId ?? undefined,
        txHash,
      });
    });
    return { status: 'confirmed', txHash };
  } catch (e) {
    await db
      .update(payouts)
      .set({ attempts: payout.attempts + 1, lastError: String(e).slice(0, 500) })
      .where(eq(payouts.id, payout.id));
    return { status: 'pending' };
  }
}

/** Admin: cancel a stuck pending payout, returning the reserve to the agent. */
export async function cancelPayout(db: Db, payoutId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.select().from(payouts).where(eq(payouts.id, payoutId)).for('update');
    const payout = rows[0];
    if (!payout) throw new Error(`Payout ${payoutId} not found`);
    if (payout.status !== 'pending') throw new Error(`Payout ${payoutId} is ${payout.status}`);
    await tx.update(payouts).set({ status: 'failed' }).where(eq(payouts.id, payoutId));
    await refundReservedPayout(tx, {
      agentId: payout.agentId,
      amount: payout.amountCredits,
      orderId: payout.orderId ?? undefined,
    });
  });
}

/** Run every pending payout for an order (post-settlement, and on retries). */
export async function processPayoutsForOrder(
  db: Db,
  orderId: string,
  rail: PaymentRail = getRail(),
): Promise<Array<{ payoutId: string; status: 'confirmed' | 'pending' }>> {
  const rows = await db.select().from(payouts).where(eq(payouts.orderId, orderId));
  const results: Array<{ payoutId: string; status: 'confirmed' | 'pending' }> = [];
  for (const p of rows) {
    if (p.status === 'confirmed') {
      results.push({ payoutId: p.id, status: 'confirmed' });
      continue;
    }
    const r = await executePayout(db, p.id, rail);
    results.push({ payoutId: p.id, status: r.status });
  }
  return results;
}
