import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { agents } from '@/db/schema';
import { requireAppSecret } from '@/lib/auth';
import { ApiError, json, parseBody, route } from '@/lib/http';

const freezeSchema = z.object({ frozen: z.boolean() });

// Admin: freeze/unfreeze an agent. Frozen agents fail auth on every call.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  requireAppSecret(req);
  const body = await parseBody(req, freezeSchema);
  const db = await getDb();
  const rows = await db
    .update(agents)
    .set({ status: body.frozen ? 'frozen' : 'active' })
    .where(eq(agents.id, ctx.params.id))
    .returning({ id: agents.id, status: agents.status });
  if (!rows[0]) throw new ApiError('not_found', 'Agent not found', 404);
  return json(rows[0]);
});
