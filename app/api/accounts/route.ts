import { z } from 'zod';
import { getDb } from '@/db/client';
import { accounts } from '@/db/schema';
import { json, parseBody, route } from '@/lib/http';
import { newId } from '@/lib/ids';

const createAccountSchema = z.object({ email: z.string().email() });

// Phase 1 bootstrap: open account creation. Phase 3 replaces this with
// email magic-link / Clerk for human owners.
export const POST = route(async (req: Request) => {
  const body = await parseBody(req, createAccountSchema);
  const db = await getDb();
  const id = newId('acct');
  await db.insert(accounts).values({ id, email: body.email });
  return json({ id, email: body.email }, 201);
});
