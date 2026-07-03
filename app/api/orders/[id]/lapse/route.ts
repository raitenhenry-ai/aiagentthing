import { getDb } from '@/db/client';
import { requireAppSecret } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { transitionOrder } from '@/lib/state-machine';

// Timer stand-in until Inngest (Phase 2): after the 48h post-FAIL window
// lapses with no buyer override and no seller appeal, auto-refund the buyer.
// The window guard in the state machine rejects early lapses.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  requireAppSecret(req);
  const db = await getDb();
  const { order } = await transitionOrder(db, {
    orderId: ctx.params.id,
    to: 'settled_refund',
    actor: 'system',
  });
  return json({ id: order.id, state: order.state, settled_at: order.settledAt?.toISOString() });
});
