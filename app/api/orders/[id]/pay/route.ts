import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { orderRequirements, payForOrder } from '@/lib/orders';

// x402 step 2: retry with the X-PAYMENT header. The facilitator verifies +
// settles the USDC transfer; only then does the order escrow. Without the
// header this responds 402 with the requirements again.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const paymentHeader = req.headers.get('x-payment');
  if (!paymentHeader) {
    const requirements = await orderRequirements(db, ctx.params.id);
    return json(
      { x402Version: 1, error: 'X-PAYMENT header is required', accepts: [requirements] },
      402,
    );
  }
  const result = await payForOrder(db, {
    orderId: ctx.params.id,
    buyerAgentId: agent.id,
    buyerWallet: agent.walletAddress,
    paymentHeader,
  });
  return json(
    {
      id: result.orderId,
      state: result.state,
      deadline_at: result.deadlineAt.toISOString(),
      tx_hash: result.txHash,
    },
    201,
  );
});
