import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { paymentAuthorizations } from '@/db/schema';
import type { PaymentRequirements } from './rail';

// Non-custodial escrow: we hold the buyer's SIGNED x402 payment authorization
// (a signature, not money). PASS/override → execute it straight to the
// seller's wallet; refund → discard it (funds never left the buyer).
//
// Anti-scam rule enforced at the API layer: on authorization-mode orders the
// buyer cannot read the deliverable until the payment has actually EXECUTED —
// the only unpaid state that reveals results is a FAILed verification.

export function headerHash(paymentHeader: string): string {
  return createHash('sha256').update(paymentHeader).digest('hex');
}

export async function holdAuthorization(
  tx: Tx,
  args: {
    orderId: string;
    paymentHeader: string;
    requirements: PaymentRequirements;
    payerWallet: string;
  },
): Promise<void> {
  await tx.insert(paymentAuthorizations).values({
    orderId: args.orderId,
    headerHash: headerHash(args.paymentHeader),
    paymentHeader: args.paymentHeader,
    requirements: args.requirements as unknown as Record<string, unknown>,
    payerWallet: args.payerWallet.toLowerCase(),
  });
}

export async function authorizationFor(db: Db | Tx, orderId: string) {
  const rows = await db
    .select()
    .from(paymentAuthorizations)
    .where(eq(paymentAuthorizations.orderId, orderId));
  return rows[0];
}

/** Refund path: the authorization is simply never executed. */
export async function discardAuthorization(tx: Tx, orderId: string): Promise<void> {
  await tx
    .update(paymentAuthorizations)
    .set({ status: 'discarded' })
    .where(eq(paymentAuthorizations.orderId, orderId));
}

/**
 * May the buyer see the deliverable? Sellers always see their own work.
 * Authorization-mode buyers see it only once the payment has EXECUTED —
 * except after a FAILed verification (failed / appealed / settled_refund),
 * where no payment happens at all.
 */
export function buyerDeliverableVisible(
  order: { settlementMode: string; state: string },
  auth: { status: string } | undefined,
): boolean {
  if (order.settlementMode !== 'authorization') return true; // custodial: escrow already holds funds
  if (['failed', 'appealed', 'settled_refund', 'expired'].includes(order.state)) return true;
  return auth?.status === 'executed';
}
