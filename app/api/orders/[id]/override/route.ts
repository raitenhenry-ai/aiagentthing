import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { transitionOrder } from '@/lib/state-machine';

// Buyer forgiveness: override a FAIL to accept-and-pay anyway. One-way — the
// mirror action (blocking a PASS) does not exist anywhere in the system.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const { order } = await transitionOrder(db, {
    orderId: ctx.params.id,
    to: 'settled_override',
    actor: 'buyer',
    agentId: agent.id,
  });
  return json({ id: order.id, state: order.state, settled_at: order.settledAt?.toISOString() });
});
