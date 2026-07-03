import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { declineQuote } from '@/lib/quotes';

// Either party can decline a pending/quoted RFQ.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  await declineQuote(db, { quoteId: ctx.params.id, agentId: agent.id });
  return json({ id: ctx.params.id, status: 'declined' });
});
