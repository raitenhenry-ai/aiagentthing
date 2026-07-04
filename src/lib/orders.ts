import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { deliveries, ledgerEntries, listings, listingVersions, orders } from '@/db/schema';
import { inngest, isInngestConfigured } from '@/inngest/client';
import { ApiError } from './http';
import { newId } from './ids';
import { holdEscrow, topUp } from './ledger';
import { getRail, PaymentError, type PaymentRequirements } from './payments';
import { settleInboundIdempotent } from './payments/inbound';
import { transitionOrder } from './state-machine';
import { runVerification } from './verification/run';
import { emitWebhookEvent } from './webhooks';

// x402 purchase flow:
//   1. buyer POSTs the order intent → order row in `created`, HTTP 402 with
//      payment requirements (exact USDC amount, platform escrow wallet).
//   2. buyer retries with an X-PAYMENT header → facilitator verifies and
//      settles on-chain → inbound credits + escrow hold + `escrowed`, all
//      atomic. No confirmed inbound payment, no escrow — ever.

export interface OrderQuote {
  orderId: string;
  priceCredits: bigint;
  requirements: PaymentRequirements;
}

export async function createOrderQuote(
  db: Db,
  args: { buyerAgentId: string; listingId: string; inputPayload: unknown },
): Promise<OrderQuote> {
  const listingRows = await db
    .select({
      id: listings.id,
      sellerAgentId: listings.sellerAgentId,
      status: listings.status,
      version: listings.version,
      title: listings.title,
      pricingMode: listings.pricingMode,
    })
    .from(listings)
    .where(eq(listings.id, args.listingId));
  const listing = listingRows[0];
  if (!listing) throw new ApiError('not_found', 'Listing not found', 404);
  if (listing.status !== 'active') {
    throw new ApiError('listing_not_active', 'Listing is not active', 409);
  }
  if (listing.sellerAgentId === args.buyerAgentId) {
    throw new ApiError('self_dealing', 'An agent cannot buy its own listing', 409);
  }
  if (listing.pricingMode === 'quote') {
    throw new ApiError(
      'quote_required',
      'This listing is quote-priced: request a quote first (POST /api/quotes)',
      409,
    );
  }

  // The purchase contract is the immutable version snapshot.
  const versionRows = await db
    .select({
      priceCredits: listingVersions.priceCredits,
      turnaroundSeconds: listingVersions.turnaroundSeconds,
    })
    .from(listingVersions)
    .where(
      and(
        eq(listingVersions.listingId, listing.id),
        eq(listingVersions.version, listing.version),
      ),
    );
  const version = versionRows[0];
  if (!version) throw new ApiError('not_found', 'Listing version snapshot missing', 500);

  const orderId = newId('ord');
  const now = new Date();
  await db.insert(orders).values({
    id: orderId,
    listingId: listing.id,
    listingVersion: listing.version,
    buyerAgentId: args.buyerAgentId,
    state: 'created',
    priceCredits: version.priceCredits,
    inputPayload: args.inputPayload,
    // Provisional; reset from payment time when escrow lands so sellers
    // never lose turnaround time to buyer payment delays.
    deadlineAt: new Date(now.getTime() + version.turnaroundSeconds * 1000),
  });

  return {
    orderId,
    priceCredits: version.priceCredits,
    requirements: await orderRequirements(db, orderId),
  };
}

/** Rebuild the (deterministic) x402 requirements for an unpaid order. */
export async function orderRequirements(
  db: Db,
  orderId: string,
): Promise<PaymentRequirements> {
  const rows = await db
    .select({
      id: orders.id,
      priceCredits: orders.priceCredits,
      state: orders.state,
      title: listings.title,
    })
    .from(orders)
    .innerJoin(listings, eq(orders.listingId, listings.id))
    .where(eq(orders.id, orderId));
  const order = rows[0];
  if (!order) throw new ApiError('not_found', 'Order not found', 404);
  return getRail().buildRequirements({
    amountCredits: order.priceCredits,
    resource: `/api/orders/${order.id}/pay`,
    description: `Clearing order ${order.id}: ${order.title}`,
    extra: { order_id: order.id },
  });
}

const ORDER_QUOTE_TTL_MS =
  Number.parseInt(process.env.ORDER_QUOTE_TTL_SECONDS ?? '86400', 10) * 1000;

/**
 * Settle the buyer's x402 payment and escrow the order atomically. The payer
 * wallet must be the authenticated buyer's wallet.
 *
 * Idempotent per X-PAYMENT header: retries after a dropped response neither
 * double-charge nor strand funds — the recorded settlement is reused and
 * finalization resumes. If a second, DIFFERENT payment races in for the same
 * order, the loser's funds land as withdrawable credits, never vanish.
 */
export async function payForOrder(
  db: Db,
  args: {
    orderId: string;
    buyerAgentId: string;
    buyerWallet: string;
    paymentHeader: string;
  },
): Promise<{ orderId: string; state: 'escrowed'; deadlineAt: Date; txHash: string }> {
  const rows = await db
    .select({
      id: orders.id,
      state: orders.state,
      buyerAgentId: orders.buyerAgentId,
      priceCredits: orders.priceCredits,
      listingId: orders.listingId,
      listingVersion: orders.listingVersion,
      createdAt: orders.createdAt,
      deadlineAt: orders.deadlineAt,
    })
    .from(orders)
    .where(eq(orders.id, args.orderId));
  const order = rows[0];
  if (!order || order.buyerAgentId !== args.buyerAgentId) {
    throw new ApiError('not_found', 'Order not found', 404);
  }
  if (order.state !== 'created') {
    throw new ApiError('already_paid', `Order is already ${order.state}`, 409);
  }
  if (Date.now() - order.createdAt.getTime() > ORDER_QUOTE_TTL_MS) {
    throw new ApiError('quote_expired', 'This order quote expired — create a new order', 409);
  }

  const requirements = await orderRequirements(db, args.orderId);
  const settlement = await settleInboundIdempotent(db, {
    paymentHeader: args.paymentHeader,
    requirements,
    agentId: args.buyerAgentId,
    expectedPayer: args.buyerWallet,
    context: `order:${order.id}`,
  });
  // Defense in depth: the rail already refused a mismatched payer before
  // moving funds, so this should never fire — but never settle if it does.
  if (settlement.payer !== args.buyerWallet.toLowerCase()) {
    throw new PaymentError('payer_mismatch', 'Payment came from a different wallet');
  }

  const versionRows = await db
    .select({ turnaroundSeconds: listingVersions.turnaroundSeconds })
    .from(listingVersions)
    .where(
      and(
        eq(listingVersions.listingId, order.listingId),
        eq(listingVersions.version, order.listingVersion),
      ),
    );
  const turnaround = versionRows[0]?.turnaroundSeconds ?? 3600;
  const deadlineAt = new Date(Date.now() + turnaround * 1000);

  // Phase A: credit the inbound funds exactly once (keyed by tx hash).
  await db.transaction(async (tx) => {
    const already = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.txHash, settlement.txHash), eq(ledgerEntries.entryType, 'topup')));
    if (already.length === 0) {
      await topUp(tx, args.buyerAgentId, order.priceCredits, settlement.txHash, order.id);
    }
  });

  // Phase B: escrow + transition under the order row lock. If a concurrent
  // payment already escrowed the order, this settles as a no-op success and
  // the surplus credits stay withdrawable on the buyer's balance.
  const finalDeadline = await db.transaction(async (tx) => {
    const locked = await tx
      .select({ state: orders.state, deadlineAt: orders.deadlineAt })
      .from(orders)
      .where(eq(orders.id, order.id))
      .for('update');
    const current = locked[0];
    if (!current) throw new ApiError('not_found', 'Order not found', 404);
    if (current.state !== 'created') return current.deadlineAt;
    const escrowEntryId = await holdEscrow(tx, {
      orderId: order.id,
      buyerAgentId: args.buyerAgentId,
      amount: order.priceCredits,
    });
    await tx.update(orders).set({ escrowEntryId, deadlineAt }).where(eq(orders.id, order.id));
    await transitionOrder(tx, { orderId: order.id, to: 'escrowed', actor: 'system' });
    return deadlineAt;
  });

  const sellerRows = await db
    .select({ sellerAgentId: listings.sellerAgentId })
    .from(listings)
    .where(eq(listings.id, order.listingId));
  const sellerAgentId = sellerRows[0]?.sellerAgentId;

  if (isInngestConfigured()) {
    void inngest
      .send({
        name: 'order/escrowed',
        data: { orderId: order.id, deadlineAt: finalDeadline.toISOString() },
      })
      .catch((e) => console.error('inngest send failed:', e));
  }
  emitWebhookEvent(db, {
    event: 'order.escrowed',
    agentIds: [args.buyerAgentId, ...(sellerAgentId ? [sellerAgentId] : [])],
    payload: { order_id: order.id, state: 'escrowed', tx_hash: settlement.txHash },
  });
  return { orderId: order.id, state: 'escrowed', deadlineAt: finalDeadline, txHash: settlement.txHash };
}

/**
 * Seller submits deliverable artifacts + proof receipts, then verification
 * runs (inline in dev, on Inngest in prod).
 */
export async function submitDelivery(
  db: Db,
  args: {
    orderId: string;
    sellerAgentId: string;
    artifacts: unknown[];
    receipts: unknown[];
  },
): Promise<{ deliveryId: string; verdict: 'PASS' | 'FAIL' | 'PENDING' }> {
  const deliveryId = newId('dlv');
  const { order } = await db.transaction(async (tx) => {
    const result = await transitionOrder(tx, {
      orderId: args.orderId,
      to: 'delivered',
      actor: 'seller',
      agentId: args.sellerAgentId,
    });
    await tx.insert(deliveries).values({
      id: deliveryId,
      orderId: args.orderId,
      artifacts: args.artifacts,
      receipts: args.receipts,
    });
    return result;
  });
  emitWebhookEvent(db, {
    event: 'order.delivered',
    agentIds: [order.buyerAgentId],
    payload: { order_id: args.orderId, state: 'delivered' },
  });

  if (isInngestConfigured()) {
    await inngest.send({ name: 'order/delivered', data: { orderId: args.orderId } });
    return { deliveryId, verdict: 'PENDING' };
  }
  const { verdict } = await runVerification(db, args.orderId);
  return { deliveryId, verdict };
}
