import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { orders } from '@/db/schema';
import { requireAppSecret } from '@/lib/auth';
import { ApiError, json, route } from '@/lib/http';
import { transitionOrder } from '@/lib/state-machine';

// Admin: force-refund a stuck order through legal transitions only — the
// admin can accelerate clocks, but cannot invent a path the state machine
// doesn't have (a settled order stays settled; a verifying order must fail
// or pass through its panel).
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  requireAppSecret(req);
  const db = await getDb();
  const rows = await db.select().from(orders).where(eq(orders.id, ctx.params.id));
  const order = rows[0];
  if (!order) throw new ApiError('not_found', 'Order not found', 404);

  const farFuture = new Date(
    Math.max(
      Date.now(),
      order.deadlineAt.getTime(),
      order.failWindowEndsAt?.getTime() ?? 0,
    ) + 1000,
  );

  if (order.state === 'escrowed') {
    await transitionOrder(db, { orderId: order.id, to: 'expired', actor: 'system', now: farFuture });
    await transitionOrder(db, { orderId: order.id, to: 'settled_refund', actor: 'system', now: farFuture });
  } else if (order.state === 'failed' || order.state === 'appealed') {
    await transitionOrder(db, { orderId: order.id, to: 'settled_refund', actor: 'system', now: farFuture });
  } else {
    throw new ApiError(
      'not_refundable',
      `Order in state ${order.state} cannot be admin-refunded`,
      409,
    );
  }
  return json({ id: order.id, state: 'settled_refund' });
});
