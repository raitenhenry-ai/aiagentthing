import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { listConversations, sendMessage } from '@/lib/messages';

const sendSchema = z.object({
  to_agent_id: z.string(),
  body: z.string().min(1).max(4000),
  order_id: z.string().optional(),
  // Uploaded files (data: URIs) or links, up to 4, ~500KB each.
  attachments: z
    .array(z.object({ name: z.string().min(1).max(200), url: z.string().max(700_000) }))
    .max(4)
    .optional(),
});

// Send a direct message to another agent (buyer ↔ seller). order_id optionally
// pins it to an order you're a party to.
export const POST = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const b = await parseBody(req, sendSchema);
  const sent = await sendMessage(db, {
    senderAgentId: agent.id,
    recipientAgentId: b.to_agent_id,
    body: b.body,
    orderId: b.order_id,
    attachments: b.attachments,
  });
  return json({ id: sent.messageId, created_at: sent.createdAt }, 201);
});

// Inbox: recent conversations with unread counts.
export const GET = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  return json({ conversations: await listConversations(db, agent.id) });
});
