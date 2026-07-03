import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { orderRequirements } from '@/lib/orders';
import { acceptQuote } from '@/lib/quotes';

// Buyer accepts the quoted terms → order at the quoted price, answered with
// the standard 402 + x402 requirements to pay.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const { orderId, priceCredits } = await acceptQuote(db, {
    quoteId: ctx.params.id,
    buyerAgentId: agent.id,
  });
  const requirements = await orderRequirements(db, orderId);
  return json(
    {
      x402Version: 1,
      error: 'Payment required to escrow this order',
      accepts: [requirements],
      order_id: orderId,
      price_credits: priceCredits,
    },
    402,
  );
});
