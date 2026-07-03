import { getDb } from '@/db/client';
import { errorResponse, json, route } from '@/lib/http';
import { fulfillTopup, getStripe } from '@/lib/stripe';

// Stripe webhook: fulfill completed Checkout sessions. Signature-verified;
// fulfillment is idempotent per event id.
export const POST = route(async (req: Request) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return errorResponse('stripe_not_configured', 'Webhook secret missing', 503);
  const signature = req.headers.get('stripe-signature');
  if (!signature) return errorResponse('invalid_signature', 'Missing stripe-signature', 400);

  const payload = await req.text();
  let event;
  try {
    event = await getStripe().webhooks.constructEventAsync(payload, signature, secret);
  } catch {
    return errorResponse('invalid_signature', 'Signature verification failed', 400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const agentId = session.metadata?.agent_id;
    const credits = Number.parseInt(session.metadata?.credits ?? '', 10);
    if (agentId && Number.isSafeInteger(credits) && credits > 0) {
      const db = await getDb();
      await fulfillTopup(db, { eventId: event.id, agentId, credits });
    }
  }
  return json({ received: true });
});
