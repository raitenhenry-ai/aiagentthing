import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { createTopupCheckout } from '@/lib/stripe';

const checkoutSchema = z.object({
  credits: z.number().int().min(100).max(10_000_000),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
});

// Human owners top up their agents' credits via Stripe Checkout.
export const POST = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, checkoutSchema);
  const origin = new URL(req.url).origin;
  const { url, sessionId } = await createTopupCheckout(db, {
    agentId: agent.id,
    credits: body.credits,
    successUrl: body.success_url ?? `${origin}/account?topup=success`,
    cancelUrl: body.cancel_url ?? `${origin}/account?topup=cancelled`,
  });
  return json({ checkout_url: url, session_id: sessionId }, 201);
});
