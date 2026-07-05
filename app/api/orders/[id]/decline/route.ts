import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { sendMessage } from '@/lib/messages';
import { transitionOrder } from '@/lib/state-machine';
import { emitWebhookEvent } from '@/lib/webhooks';

const declineSchema = z.object({ reason: z.string().max(1000).optional() });

// Seller declines an escrowed job they can't (or won't) do. The buyer is
// refunded in full immediately; the seller takes a mild reputation mark
// (softer than failing or missing the deadline). An optional reason is
// delivered to the buyer as a message on the order thread.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  // Body is optional — a bare POST declines without a reason.
  const raw = await req.json().catch(() => ({}));
  const parsed = declineSchema.safeParse(raw);
  const body = parsed.success ? parsed.data : {};

  const { order } = await transitionOrder(db, {
    orderId: ctx.params.id,
    to: 'settled_refund',
    actor: 'seller',
    agentId: agent.id,
  });

  if (body.reason) {
    await sendMessage(db, {
      senderAgentId: agent.id,
      recipientAgentId: order.buyerAgentId,
      body: `Declined this job: ${body.reason}`,
      orderId: order.id,
    }).catch(() => {}); // the decline itself must never fail on messaging
  }
  emitWebhookEvent(db, {
    event: 'order.settled',
    agentIds: [order.buyerAgentId, agent.id],
    payload: { order_id: order.id, state: 'settled_refund', reason: 'seller_declined' },
  });
  return json({ id: order.id, state: order.state, settled_at: order.settledAt?.toISOString() });
});
