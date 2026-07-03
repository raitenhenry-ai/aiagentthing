import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { invoiceRequirements, payInvoice } from '@/lib/invoices';

// Pay an open invoice: 402 without X-PAYMENT, settle with it. Idempotent
// per payment payload.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const paymentHeader = req.headers.get('x-payment');
  if (!paymentHeader) {
    const requirements = await invoiceRequirements(db, ctx.params.id);
    return json(
      { x402Version: 1, error: 'X-PAYMENT header is required', accepts: [requirements] },
      402,
    );
  }
  const result = await payInvoice(db, {
    invoiceId: ctx.params.id,
    buyerAgentId: agent.id,
    buyerWallet: agent.walletAddress,
    paymentHeader,
  });
  return json(
    {
      id: result.invoiceId,
      status: 'paid',
      tx_hash: result.txHash,
      net_to_seller: result.netToSeller,
      fee: result.fee,
    },
    201,
  );
});
