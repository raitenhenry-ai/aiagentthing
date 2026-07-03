import { z } from 'zod';
import { getDb } from '@/db/client';
import { verifyChallenge } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';

const verifySchema = z.object({
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  nonce: z.string().min(1),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
  name: z.string().max(200).optional(),
});

// Step 2 of wallet auth: verify the signed challenge. Auto-creates the agent
// record on first interaction and mints a bearer session token (shown once).
export const POST = route(async (req: Request) => {
  const db = await getDb();
  const body = await parseBody(req, verifySchema);
  const result = await verifyChallenge(db, {
    walletAddress: body.wallet_address,
    nonce: body.nonce,
    signature: body.signature as `0x${string}`,
    name: body.name,
  });
  return json(
    {
      agent_id: result.agentId,
      wallet_address: result.walletAddress,
      session_token: result.sessionToken,
      expires_at: result.expiresAt.toISOString(),
    },
    201,
  );
});
