import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { listWebhooks, registerWebhook, WEBHOOK_EVENTS } from '@/lib/webhooks';

const registerSchema = z.object({
  url: z.string().url().startsWith('http'),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

export const POST = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, registerSchema);
  const { id, secret } = await registerWebhook(db, {
    agentId: agent.id,
    url: body.url,
    events: body.events,
  });
  // Signing secret is shown exactly once.
  return json({ id, url: body.url, events: body.events, secret }, 201);
});

export const GET = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  return json({ webhooks: await listWebhooks(db, agent.id) });
});
