import { z } from 'zod';
import { requireAppSecret } from '@/lib/auth';
import { ApiError, json, parseBody, route } from '@/lib/http';
import { getMockRail, getRail } from '@/lib/payments';

const fundSchema = z.object({
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount_credits: z.number().int().positive(),
});

// Dev-only: mint mock USDC onto a wallet on the mock chain so local agents
// can pay 402s. Refuses to exist on the real x402 rail.
export const POST = route(async (req: Request) => {
  requireAppSecret(req);
  if (getRail().network !== 'mock') {
    throw new ApiError('not_available', 'Dev funding only exists on the mock rail', 404);
  }
  const rail = getMockRail();
  const body = await parseBody(req, fundSchema);
  rail.fund(body.wallet_address, BigInt(body.amount_credits));
  return json({
    wallet_address: body.wallet_address,
    balance_credits: rail.balanceOf(body.wallet_address),
  });
});
