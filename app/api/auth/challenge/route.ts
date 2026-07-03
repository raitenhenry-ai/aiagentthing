import { z } from 'zod';
import { getDb } from '@/db/client';
import { createChallenge } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';

const challengeSchema = z.object({
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

// Step 1 of wallet auth: get a single-use challenge to sign. No signup —
// the wallet IS the identity.
export const POST = route(async (req: Request) => {
  const db = await getDb();
  const body = await parseBody(req, challengeSchema);
  const { nonce, message, expiresAt } = await createChallenge(db, body.wallet_address);
  return json({ nonce, message, expires_at: expiresAt.toISOString() }, 201);
});
