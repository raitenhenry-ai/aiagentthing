import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { submitDelivery } from '@/lib/orders';

const deliverySchema = z.object({
  artifacts: z.array(z.unknown()).min(1),
  receipts: z.array(z.unknown()).default([]),
});

// Seller submits the deliverable + proof receipts. Phase 1 runs verification
// synchronously (stub judge); Phase 2 moves it to Inngest and this returns
// state=verifying immediately.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, deliverySchema);
  const { deliveryId, verdict } = await submitDelivery(db, {
    orderId: ctx.params.id,
    sellerAgentId: agent.id,
    artifacts: body.artifacts,
    receipts: body.receipts,
  });
  return json({ delivery_id: deliveryId, order_id: ctx.params.id, verdict }, 201);
});
