import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { deliveries, listings, listingVersions, orders } from '@/db/schema';
import { inngest, isInngestConfigured } from '@/inngest/client';
import { ApiError } from './http';
import { newId } from './ids';
import { holdEscrow } from './ledger';
import { transitionOrder, type OrderState } from './state-machine';
import { runVerification } from './verification/run';
import { emitWebhookEvent } from './webhooks';

/**
 * Create an order against the listing's current version and escrow the
 * buyer's credits atomically. If the buyer can't cover the price the whole
 * transaction rolls back — a rejected order is never persisted.
 */
export async function createOrder(
  db: Db,
  args: { buyerAgentId: string; listingId: string; inputPayload: unknown },
): Promise<{ orderId: string; state: OrderState; deadlineAt: Date; priceCredits: bigint }> {
  return db.transaction(async (tx) => {
    const listingRows = await tx
      .select({
        id: listings.id,
        sellerAgentId: listings.sellerAgentId,
        status: listings.status,
        version: listings.version,
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

    // The purchase contract is the immutable version snapshot, not the
    // mutable listing row.
    const versionRows = await tx
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
    const deadlineAt = new Date(now.getTime() + version.turnaroundSeconds * 1000);
    await tx.insert(orders).values({
      id: orderId,
      listingId: listing.id,
      listingVersion: listing.version,
      buyerAgentId: args.buyerAgentId,
      state: 'created',
      priceCredits: version.priceCredits,
      inputPayload: args.inputPayload,
      deadlineAt,
    });

    const escrowEntryId = await holdEscrow(tx, {
      orderId,
      buyerAgentId: args.buyerAgentId,
      amount: version.priceCredits,
    });
    await tx.update(orders).set({ escrowEntryId }).where(eq(orders.id, orderId));
    await transitionOrder(tx, { orderId, to: 'escrowed', actor: 'system' });

    return {
      orderId,
      state: 'escrowed' as const,
      deadlineAt,
      priceCredits: version.priceCredits,
      sellerAgentId: listing.sellerAgentId,
    };
  }).then((result) => {
    // Post-commit side effects: the expiry timer and party notifications.
    if (isInngestConfigured()) {
      void inngest
        .send({
          name: 'order/escrowed',
          data: { orderId: result.orderId, deadlineAt: result.deadlineAt.toISOString() },
        })
        .catch((e) => console.error('inngest send failed:', e));
    }
    emitWebhookEvent(db, {
      event: 'order.escrowed',
      agentIds: [args.buyerAgentId, result.sellerAgentId],
      payload: { order_id: result.orderId, state: 'escrowed' },
    });
    return result;
  });
}

/**
 * Seller submits deliverable artifacts + proof receipts, then verification
 * runs (synchronously in Phase 1).
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

  // Verification runs on Inngest when configured; inline otherwise (dev).
  if (isInngestConfigured()) {
    await inngest.send({ name: 'order/delivered', data: { orderId: args.orderId } });
    return { deliveryId, verdict: 'PENDING' };
  }
  const { verdict } = await runVerification(db, args.orderId);
  return { deliveryId, verdict };
}
