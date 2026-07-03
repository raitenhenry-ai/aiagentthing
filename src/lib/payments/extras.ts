import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { agents, listings, orders } from '@/db/schema';
import { ApiError } from '../http';
import { agentAccount, feeFor, PLATFORM_FEES, postMovement, topUp } from '../ledger';
import { isSettled, type OrderState } from '../state-machine';
import { emitWebhookEvent } from '../webhooks';
import { getRail } from './index';
import { settleInboundIdempotent } from './inbound';
import { enqueuePayout, executePayout } from './payouts';
import { PaymentError, type PaymentRequirements } from './rail';

// The remaining payment forms: tips (buyer bonus on a settled order) and
// withdrawals (drain leftover credits — surplus payments, stranded deposits —
// back to the agent's wallet).

function tipFeeBps(): number {
  return Number.parseInt(process.env.TIP_FEE_BPS ?? '0', 10);
}

const MAX_TIP = 10_000_000n; // $100k sanity cap
const MIN_WITHDRAWAL = () =>
  BigInt(process.env.WITHDRAWAL_MIN_CREDITS ?? '100');

export async function tipRequirements(
  db: Db,
  orderId: string,
  amountCredits: bigint,
): Promise<PaymentRequirements> {
  if (amountCredits <= 0n || amountCredits > MAX_TIP) {
    throw new ApiError('invalid_amount', 'Tip amount out of range', 422);
  }
  return getRail().buildRequirements({
    amountCredits,
    resource: `/api/orders/${orderId}/tip`,
    description: `Clearing tip on order ${orderId}`,
    extra: { order_id: orderId, kind: 'tip', amount: amountCredits.toString() },
  });
}

/** Buyer tips the seller of a settled order — direct payment, tiny/no fee. */
export async function tipOrder(
  db: Db,
  args: {
    orderId: string;
    buyerAgentId: string;
    buyerWallet: string;
    amountCredits: bigint;
    paymentHeader: string;
  },
): Promise<{ txHash: string; net: bigint }> {
  const rows = await db
    .select({
      id: orders.id,
      state: orders.state,
      buyerAgentId: orders.buyerAgentId,
      sellerAgentId: listings.sellerAgentId,
    })
    .from(orders)
    .innerJoin(listings, eq(orders.listingId, listings.id))
    .where(eq(orders.id, args.orderId));
  const order = rows[0];
  if (!order || order.buyerAgentId !== args.buyerAgentId) {
    throw new ApiError('not_found', 'Order not found', 404);
  }
  if (!isSettled(order.state as OrderState)) {
    throw new ApiError('not_settled', 'Only settled orders can be tipped', 409);
  }

  const requirements = await tipRequirements(db, order.id, args.amountCredits);
  const settlement = await settleInboundIdempotent(db, {
    paymentHeader: args.paymentHeader,
    requirements,
    agentId: args.buyerAgentId,
    context: `tip:${order.id}:${args.amountCredits}`,
  });
  if (settlement.payer !== args.buyerWallet.toLowerCase()) {
    throw new PaymentError('payer_mismatch', 'Payment came from a different wallet');
  }

  const sellerRows = await db
    .select({ wallet: agents.walletAddress })
    .from(agents)
    .where(eq(agents.id, order.sellerAgentId));
  const sellerWallet = sellerRows[0]?.wallet;
  if (!sellerWallet) throw new ApiError('not_found', 'Seller not found', 404);

  const fee = feeFor(args.amountCredits, tipFeeBps());
  const net = args.amountCredits - fee;

  let payoutId: string | undefined;
  await db.transaction(async (tx) => {
    const { ledgerEntries } = await import('@/db/schema');
    const { and, eq: eq2 } = await import('drizzle-orm');
    const already = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(and(eq2(ledgerEntries.txHash, settlement.txHash), eq2(ledgerEntries.entryType, 'topup')));
    if (already.length > 0) return; // retry after commit — done already
    await topUp(tx, args.buyerAgentId, args.amountCredits, settlement.txHash, order.id);
    await postMovement(tx, {
      from: agentAccount(args.buyerAgentId),
      to: agentAccount(order.sellerAgentId),
      amount: net,
      entryType: 'tip',
      orderId: order.id,
    });
    if (fee > 0n) {
      await postMovement(tx, {
        from: agentAccount(args.buyerAgentId),
        to: PLATFORM_FEES,
        amount: fee,
        entryType: 'fee',
        orderId: order.id,
      });
    }
    payoutId = await enqueuePayout(tx, {
      orderId: order.id,
      agentId: order.sellerAgentId,
      toWallet: sellerWallet,
      amountCredits: net,
      reason: 'tip',
    });
  });
  if (payoutId) await executePayout(db, payoutId).catch(() => undefined);

  emitWebhookEvent(db, {
    event: 'tip.received',
    agentIds: [order.sellerAgentId],
    payload: { order_id: order.id, amount_credits: Number(net), tx_hash: settlement.txHash },
  });
  return { txHash: settlement.txHash, net };
}

/**
 * Withdraw leftover credits (surplus payments, returned deposits) to the
 * agent's own wallet. Reserves atomically; transfers with idempotent retry.
 */
export async function requestWithdrawal(
  db: Db,
  args: { agentId: string; walletAddress: string; amountCredits: bigint },
): Promise<{ payoutId: string; status: 'confirmed' | 'pending'; txHash?: string }> {
  if (args.amountCredits < MIN_WITHDRAWAL()) {
    throw new ApiError(
      'below_minimum',
      `Minimum withdrawal is ${MIN_WITHDRAWAL()} credits`,
      422,
    );
  }
  let payoutId = '';
  await db.transaction(async (tx) => {
    payoutId = await enqueuePayout(tx, {
      agentId: args.agentId,
      toWallet: args.walletAddress,
      amountCredits: args.amountCredits,
      reason: 'withdrawal',
    });
  });
  const result = await executePayout(db, payoutId);
  return { payoutId, ...result };
}
