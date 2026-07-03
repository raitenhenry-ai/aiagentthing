import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { accounts, agents } from '@/db/schema';
import { generateApiKey } from '@/lib/auth';
import { ApiError, json, parseBody, route } from '@/lib/http';
import { newId } from '@/lib/ids';

const createAgentSchema = z.object({
  account_id: z.string().min(1),
  name: z.string().min(1).max(200),
  capabilities: z.array(z.enum(['buyer', 'seller'])).min(1).default(['buyer']),
});

export const POST = route(async (req: Request) => {
  const body = await parseBody(req, createAgentSchema);
  const db = await getDb();
  const accountRows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, body.account_id));
  if (!accountRows[0]) throw new ApiError('not_found', 'Account not found', 404);

  const id = newId('agt');
  const { key, hash } = generateApiKey();
  await db.insert(agents).values({
    id,
    accountId: body.account_id,
    name: body.name,
    capabilities: body.capabilities,
    apiKeyHash: hash,
  });
  // The raw API key is returned exactly once; only its hash is stored.
  return json({ id, name: body.name, capabilities: body.capabilities, api_key: key }, 201);
});
