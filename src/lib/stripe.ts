import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { accounts, agents, idempotencyKeys } from '@/db/schema';
import { ApiError } from './http';
import { topUp } from './ledger';

// Credits + Stripe keeps the MVP inside Stripe's rails: humans top up via
// Checkout, credits live in the internal double-entry ledger, withdrawals
// are manual. See README for the money-transmission note.

let stripeClient: Stripe | undefined;

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ApiError('stripe_not_configured', 'Stripe is not configured', 503);
  if (!stripeClient) stripeClient = new Stripe(key);
  return stripeClient;
}

/** 1 credit = 1 cent (USD) at MVP. */
export const CENTS_PER_CREDIT = 1;

export async function createTopupCheckout(
  db: Db,
  args: { agentId: string; credits: number; successUrl: string; cancelUrl: string },
): Promise<{ url: string; sessionId: string }> {
  const stripe = getStripe();
  const rows = await db
    .select({ agent: agents, account: accounts })
    .from(agents)
    .innerJoin(accounts, eq(agents.accountId, accounts.id))
    .where(eq(agents.id, args.agentId));
  const row = rows[0];
  if (!row) throw new ApiError('not_found', 'Agent not found', 404);

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      customer: row.account.stripeCustomerId ?? undefined,
      customer_email: row.account.stripeCustomerId ? undefined : row.account.email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: CENTS_PER_CREDIT,
            product_data: { name: 'Clearing credits' },
          },
          quantity: args.credits,
        },
      ],
      metadata: { agent_id: args.agentId, credits: String(args.credits) },
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    },
    // Idempotent create: retrying the same agent+credits within a session
    // burst can't double-create.
    { idempotencyKey: `topup_${args.agentId}_${args.credits}_${Date.now() >> 13}` },
  );
  if (!session.url) throw new ApiError('stripe_error', 'Checkout session has no URL', 502);
  return { url: session.url, sessionId: session.id };
}

/**
 * Fulfill a completed Checkout session: credit the agent exactly once per
 * Stripe event, keyed by event id in idempotency_keys.
 */
export async function fulfillTopup(
  db: Db,
  args: { eventId: string; agentId: string; credits: number },
): Promise<{ credited: boolean }> {
  const key = `stripe_evt_${args.eventId}`;
  try {
    await db.insert(idempotencyKeys).values({
      key,
      agentId: args.agentId,
      requestHash: `${args.agentId}:${args.credits}`,
      response: { credits: args.credits },
    });
  } catch {
    return { credited: false }; // duplicate delivery — already fulfilled
  }
  await topUp(db, args.agentId, BigInt(args.credits));
  return { credited: true };
}
