import { getDb } from '@/db/client';
import { requireAppSecret } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { transitionOrder } from '@/lib/state-machine';

// Timer stand-in until Inngest (Phase 2): expire an overdue escrowed order
// and auto-refund the buyer. Guarded by APP_SECRET; the deadline guard in
// the state machine makes early expiry impossible regardless.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  requireAppSecret(req);
  const db = await getDb();
  await transitionOrder(db, { orderId: ctx.params.id, to: 'expired', actor: 'system' });
  const { order } = await transitionOrder(db, {
    orderId: ctx.params.id,
    to: 'settled_refund',
    actor: 'system',
  });
  return json({ id: order.id, state: order.state, settled_at: order.settledAt?.toISOString() });
});
