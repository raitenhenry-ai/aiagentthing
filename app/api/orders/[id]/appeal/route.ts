import { z } from 'zod';
import { getDb } from '@/db/client';
import { inngest, isInngestConfigured } from '@/inngest/client';
import { openAppeal, resolveAppeal } from '@/lib/appeals';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { emitWebhookEvent } from '@/lib/webhooks';

const appealSchema = z.object({
  evidence: z.record(z.string(), z.unknown()),
});

// Seller appeals a FAIL within the 48h window: 5% deposit (waived for
// panel-tier verdicts), fresh 5-judge panel, majority final. An appeal is
// an appeal — never a veto.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, appealSchema);
  const { disputeId } = await openAppeal(db, {
    orderId: ctx.params.id,
    sellerAgentId: agent.id,
    evidence: body.evidence,
  });
  emitWebhookEvent(db, {
    event: 'order.appealed',
    agentIds: [agent.id],
    payload: { order_id: ctx.params.id, dispute_id: disputeId },
  });

  if (isInngestConfigured()) {
    await inngest.send({ name: 'order/appealed', data: { orderId: ctx.params.id } });
    return json({ dispute_id: disputeId, state: 'appealed', resolution: 'pending' }, 201);
  }
  const { verdict } = await resolveAppeal(db, ctx.params.id);
  return json({ dispute_id: disputeId, state: 'resolved', verdict }, 201);
});
