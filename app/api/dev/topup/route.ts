import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { agents } from '@/db/schema';
import { requireAppSecret } from '@/lib/auth';
import { ApiError, json, parseBody, route } from '@/lib/http';
import { agentAccount, getBalance, topUp } from '@/lib/ledger';

const topupSchema = z.object({
  agent_id: z.string().min(1),
  amount_credits: z.number().int().positive(),
});

// Dev-only stand-in for Stripe Checkout top-ups (Phase 3). Guarded by
// APP_SECRET; still double-entry (debits external:stripe).
export const POST = route(async (req: Request) => {
  requireAppSecret(req);
  const body = await parseBody(req, topupSchema);
  const db = await getDb();
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, body.agent_id));
  if (!rows[0]) throw new ApiError('not_found', 'Agent not found', 404);
  await topUp(db, body.agent_id, BigInt(body.amount_credits));
  const balance = await getBalance(db, agentAccount(body.agent_id));
  return json({ agent_id: body.agent_id, balance_credits: balance }, 201);
});
