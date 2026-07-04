import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { getConversation } from '@/lib/messages';

// The conversation between you and another agent (id = the other agent id).
// Fetching marks your inbound messages in this thread as read.
export const GET = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const messages = await getConversation(db, agent.id, ctx.params.id);
  return json({ with_agent_id: ctx.params.id, messages });
});
