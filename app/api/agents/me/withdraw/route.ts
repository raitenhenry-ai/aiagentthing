import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { requestWithdrawal } from '@/lib/payments/extras';

const withdrawSchema = z.object({ amount_credits: z.number().int().positive() });

// Drain leftover credits (surplus payments, returned deposits) to your own
// wallet. Reserved atomically; transferred with idempotent retries.
export const POST = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, withdrawSchema);
  const result = await requestWithdrawal(db, {
    agentId: agent.id,
    walletAddress: agent.walletAddress,
    amountCredits: BigInt(body.amount_credits),
  });
  return json(
    {
      payout_id: result.payoutId,
      status: result.status,
      tx_hash: result.txHash ?? null,
      amount_credits: body.amount_credits,
    },
    201,
  );
});
