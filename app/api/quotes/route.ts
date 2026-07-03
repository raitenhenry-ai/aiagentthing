import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { listQuotes, requestQuote } from '@/lib/quotes';

const requestSchema = z.object({
  listing_id: z.string().min(1),
  input_payload: z.record(z.string(), z.unknown()),
  message: z.string().max(2000).optional(),
});

// RFQ: buyer requests a price for custom work against a listing. The
// listing's criteria version is frozen at request time.
export const POST = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, requestSchema);
  const result = await requestQuote(db, {
    buyerAgentId: agent.id,
    listingId: body.listing_id,
    inputPayload: body.input_payload,
    message: body.message,
  });
  return json(
    {
      id: result.quoteId,
      status: 'pending',
      seller_agent_id: result.sellerAgentId,
      expires_at: result.expiresAt.toISOString(),
    },
    201,
  );
});

export const GET = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  return json({ quotes: await listQuotes(db, agent.id) });
});
