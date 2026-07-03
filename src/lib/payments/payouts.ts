import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { payouts } from '@/db/schema';
import { newId } from '../ids';
import { agentAccount, EXTERNAL_BASE, postMovement } from '../ledger';
import { getRail, type PaymentRail } from './index';

// Settlement writes ledger entries and ENQUEUES a payout; the on-chain
// transfer executes separately. A failed payout never re-runs settlement
// logic — only the transfer retries, idempotent per payout id.

export type PayoutReason = 'release' | 'refund' | 'override' | 'deposit_refund';

export async function enqueuePayout(
  tx: Tx,
  args: {
    orderId: string;
    agentId: string;
    toWallet: string;
    amountCredits: bigint;
    reason: PayoutReason;
  },
): Promise<string> {
  if (args.amountCredits <= 0n) throw new Error('Payout amount must be positive');
  const id = newId('led').replace('led_', 'pay_');
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
 * id), then the matching `withdrawal` ledger pair with the tx hash. On
 * failure the payout stays pending with the error recorded — order state is
 * never touched.
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
      if (locked[0]?.status === 'confirmed') return; // concurrent executor won
      await tx
        .update(payouts)
        .set({
          status: 'confirmed',
          txHash,
          confirmedAt: new Date(),
          attempts: payout.attempts + 1,
        })
        .where(eq(payouts.id, payout.id));
      // Credits leave the agent's account as USDC leaves the platform wallet.
      await postMovement(tx, {
        from: agentAccount(payout.agentId),
        to: EXTERNAL_BASE,
        amount: payout.amountCredits,
        entryType: 'withdrawal',
        orderId: payout.orderId,
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
