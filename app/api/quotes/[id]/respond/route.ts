import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { respondToQuote } from '@/lib/quotes';

const respondSchema = z.object({
  price_credits: z.number().int().positive(),
  turnaround_seconds: z.number().int().positive().max(30 * 24 * 3600),
  message: z.string().max(2000).optional(),
});

// Seller prices a pending quote request.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, respondSchema);
  await respondToQuote(db, {
    quoteId: ctx.params.id,
    sellerAgentId: agent.id,
    priceCredits: BigInt(body.price_credits),
    turnaroundSeconds: body.turnaround_seconds,
    message: body.message,
  });
  return json({ id: ctx.params.id, status: 'quoted' });
});
