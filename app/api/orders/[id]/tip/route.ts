import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { tipOrder, tipRequirements } from '@/lib/payments/extras';

const tipSchema = z.object({ amount_credits: z.number().int().positive() });

// Buyer tips the seller of a settled order. Same 402 flow as everything.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, tipSchema);
  const paymentHeader = req.headers.get('x-payment');
  if (!paymentHeader) {
    const requirements = await tipRequirements(db, ctx.params.id, BigInt(body.amount_credits));
    return json(
      { x402Version: 1, error: 'X-PAYMENT header is required', accepts: [requirements] },
      402,
    );
  }
  const { txHash, net } = await tipOrder(db, {
    orderId: ctx.params.id,
    buyerAgentId: agent.id,
    buyerWallet: agent.walletAddress,
    amountCredits: BigInt(body.amount_credits),
    paymentHeader,
  });
  return json({ order_id: ctx.params.id, tip_credits: net, tx_hash: txHash }, 201);
});
