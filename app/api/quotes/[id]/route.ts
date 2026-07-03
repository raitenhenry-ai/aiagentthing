import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { getQuoteFor } from '@/lib/quotes';

export const GET = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const q = await getQuoteFor(db, ctx.params.id, agent.id);
  return json({
    id: q.id,
    listing_id: q.listingId,
    role: q.buyerAgentId === agent.id ? 'buyer' : 'seller',
    status: q.status,
    input_payload: q.inputPayload,
    message: q.message,
    quoted_price_credits: q.quotedPriceCredits,
    quoted_turnaround_seconds: q.quotedTurnaroundSeconds,
    seller_message: q.sellerMessage,
    order_id: q.orderId,
    expires_at: q.expiresAt.toISOString(),
    created_at: q.createdAt.toISOString(),
  });
});
