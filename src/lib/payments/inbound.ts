import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { idempotencyKeys } from '@/db/schema';
import { getRail } from './index';
import { PaymentError, type InboundSettlement, type PaymentRequirements } from './rail';

// Inbound x402 settlement with end-to-end idempotency. The dangerous window
// is between on-chain settlement and our database finalization: a crash or
// dropped response there must NOT strand funds or double-charge on retry.
//
// Protocol per unique X-PAYMENT header:
//   1. take a lease row keyed by the payment hash (INSERT, response = null)
//   2. settle on-chain via the facilitator
//   3. record the settlement result on the lease
// A retry with the same header finds the lease: finished → reuse the stored
// settlement (no second charge); in-flight and fresh → 409; in-flight but
// stale (crashed mid-settle) → surface for admin, never blind-retry a
// possibly-settled payment.

const LEASE_STALE_MS = 5 * 60 * 1000;

export function paymentKey(paymentHeader: string): string {
  return `xpay_${createHash('sha256').update(paymentHeader).digest('hex')}`;
}

export async function settleInboundIdempotent(
  db: Db,
  args: {
    paymentHeader: string;
    requirements: PaymentRequirements;
    /** Authenticated agent — must be the payer. */
    agentId: string;
    /** The authenticated agent's wallet. Checked by the rail BEFORE any
     * funds move; a payment from any other wallet is rejected with no
     * on-chain effect. */
    expectedPayer: string;
    /** What this payment is for, e.g. `order:{id}` — a header can never be
     * reused across contexts. */
    context: string;
  },
): Promise<InboundSettlement> {
  const key = paymentKey(args.paymentHeader);

  const inserted = await db
    .insert(idempotencyKeys)
    .values({ key, agentId: args.agentId, requestHash: args.context })
    .onConflictDoNothing({ target: idempotencyKeys.key })
    .returning({ key: idempotencyKeys.key });

  if (inserted.length === 0) {
    // Someone (possibly a previous attempt of ours) holds this payment.
    const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    const existing = rows[0];
    if (!existing) throw new PaymentError('payment_conflict', 'Payment lease vanished; retry');
    if (existing.requestHash !== args.context || existing.agentId !== args.agentId) {
      throw new PaymentError(
        'payment_reused',
        'This X-PAYMENT payload was already used for a different purchase',
      );
    }
    const settled = existing.response as InboundSettlement | null;
    if (settled) return { ...settled, amountAtomic: BigInt(settled.amountAtomic) };
    if (Date.now() - existing.createdAt.getTime() < LEASE_STALE_MS) {
      throw new PaymentError('payment_in_progress', 'This payment is already being processed');
    }
    // Stale lease: a prior attempt died between settle and record. The chain
    // state is unknown — do not blind-retry a possibly-settled payment.
    throw new PaymentError(
      'payment_state_unknown',
      'A previous attempt for this payment did not complete; contact the operator with this payment reference',
    );
  }

  try {
    const settlement = await getRail().settleInbound(
      args.paymentHeader,
      args.requirements,
      args.expectedPayer,
    );
    await db
      .update(idempotencyKeys)
      .set({
        response: {
          payer: settlement.payer,
          txHash: settlement.txHash,
          amountAtomic: settlement.amountAtomic.toString(),
        } as unknown as Record<string, unknown>,
      })
      .where(eq(idempotencyKeys.key, key));
    return settlement;
  } catch (e) {
    // Settlement never happened — release the lease so the agent can retry.
    if (e instanceof PaymentError && e.code !== 'settlement_failed') {
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    }
    throw e;
  }
}

/** Prune expired auth nonces + old leases (called opportunistically). */
export async function pruneExpired(db: Db): Promise<void> {
  await db.execute(sql`DELETE FROM auth_nonces WHERE expires_at < now()`);
  await db.execute(sql`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);
}
