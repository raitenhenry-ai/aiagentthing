import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  deliveries,
  disputes,
  ledgerEntries,
  listings,
  listingVersions,
  orders,
  reputationEvents,
  verifications,
} from '@/db/schema';
import { authenticateAgent } from '@/lib/auth';
import { ApiError, json, route } from '@/lib/http';

// The evidence pack: a complete, exportable audit log for one order — the
// contract version purchased against, delivery artifacts + receipts, every
// verification record (reasoning hashed), dispute history, and every ledger
// movement. Available to the order's parties and to admins (x-app-secret).
export const GET = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();

  const rows = await db
    .select({ order: orders, sellerAgentId: listings.sellerAgentId })
    .from(orders)
    .innerJoin(listings, eq(orders.listingId, listings.id))
    .where(eq(orders.id, ctx.params.id));
  const row = rows[0];
  if (!row) throw new ApiError('not_found', 'Order not found', 404);
  const { order, sellerAgentId } = row;

  const isAdmin = req.headers.get('x-app-secret') !== null;
  if (isAdmin) {
    const { requireAppSecret } = await import('@/lib/auth');
    requireAppSecret(req);
  } else {
    const agent = await authenticateAgent(db, req);
    if (agent.id !== order.buyerAgentId && agent.id !== sellerAgentId) {
      throw new ApiError('not_found', 'Order not found', 404);
    }
  }

  const [version, deliveryRows, verificationRows, disputeRows, ledgerRows, repRows] =
    await Promise.all([
      db
        .select()
        .from(listingVersions)
        .where(eq(listingVersions.listingId, order.listingId))
        .then((vs) => vs.find((v) => v.version === order.listingVersion)),
      db.select().from(deliveries).where(eq(deliveries.orderId, order.id)),
      db.select().from(verifications).where(eq(verifications.orderId, order.id)),
      db.select().from(disputes).where(eq(disputes.orderId, order.id)),
      db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.orderId, order.id))
        .orderBy(asc(ledgerEntries.createdAt)),
      db.select().from(reputationEvents).where(eq(reputationEvents.orderId, order.id)),
    ]);

  return json({
    order,
    contract: version ?? null,
    deliveries: deliveryRows,
    verifications: verificationRows,
    disputes: disputeRows,
    ledger_entries: ledgerRows,
    reputation_events: repRows,
    exported_at: new Date().toISOString(),
  });
});
