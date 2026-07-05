import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { listings, orders } from '@/db/schema';
import { authenticateAgent } from '@/lib/auth';
import { ApiError, json, parseBody, route } from '@/lib/http';
import { sendMessage } from '@/lib/messages';
import { createOrderQuote } from '@/lib/orders';
import type { OrderState } from '@/lib/state-machine';

const attachmentSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().max(700_000), // https:// link or an uploaded file as data: URI
});

const createOrderSchema = z.object({
  listing_id: z.string().min(1),
  input_payload: z.unknown(),
  // Optional note to the seller, with optional uploaded files/links — lands
  // on the order's message thread so the seller has context before working.
  message: z.string().max(4000).optional(),
  attachments: z.array(attachmentSchema).max(4).optional(),
});

// x402 step 1: POST the order intent, get HTTP 402 with payment
// requirements. Pay by re-POSTing /api/orders/{id}/pay with X-PAYMENT.
export const POST = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, createOrderSchema);
  const quote = await createOrderQuote(db, {
    buyerAgentId: agent.id,
    listingId: body.listing_id,
    inputPayload: body.input_payload ?? {},
  });

  // Deliver the buyer's note (plus any uploads) to the seller, pinned to the
  // new order. Message failures never break order creation.
  if (body.message || (body.attachments?.length ?? 0) > 0) {
    const sellerRows = await db
      .select({ seller: listings.sellerAgentId })
      .from(listings)
      .where(eq(listings.id, body.listing_id));
    const sellerId = sellerRows[0]?.seller;
    if (sellerId && sellerId !== agent.id) {
      await sendMessage(db, {
        senderAgentId: agent.id,
        recipientAgentId: sellerId,
        body: body.message?.trim() || '(files attached)',
        orderId: quote.orderId,
        attachments: body.attachments,
      }).catch((e) => console.error('order note delivery failed:', e));
    }
  }

  return json(
    {
      x402Version: 1,
      error: 'Payment required to escrow this order',
      accepts: [quote.requirements],
      order_id: quote.orderId,
      price_credits: quote.priceCredits,
    },
    402,
  );
});

const ORDER_STATES: [OrderState, ...OrderState[]] = [
  'created',
  'escrowed',
  'delivered',
  'verifying',
  'passed',
  'failed',
  'expired',
  'appealed',
  'settled_released',
  'settled_refund',
  'settled_override',
];

export const GET = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const url = new URL(req.url);
  const stateParam = url.searchParams.get('state');
  let state: OrderState | undefined;
  if (stateParam !== null) {
    const parsed = z.enum(ORDER_STATES).safeParse(stateParam);
    if (!parsed.success) {
      throw new ApiError('validation_error', `Unknown order state: ${stateParam}`, 422);
    }
    state = parsed.data;
  }

  // Orders where the agent is buyer, or seller via one of its listings.
  const sellerListingIds = (
    await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.sellerAgentId, agent.id))
  ).map((r) => r.id);

  const partyFilter = or(
    eq(orders.buyerAgentId, agent.id),
    sellerListingIds.length > 0 ? inArray(orders.listingId, sellerListingIds) : undefined,
  );
  const rows = await db
    .select()
    .from(orders)
    .where(state ? and(partyFilter, eq(orders.state, state)) : partyFilter)
    .orderBy(desc(orders.createdAt));

  const filtered = rows;
  return json({
    orders: filtered.map((o) => ({
      id: o.id,
      listing_id: o.listingId,
      listing_version: o.listingVersion,
      buyer_agent_id: o.buyerAgentId,
      state: o.state,
      price_credits: o.priceCredits,
      created_at: o.createdAt.toISOString(),
      deadline_at: o.deadlineAt.toISOString(),
      settled_at: o.settledAt?.toISOString() ?? null,
    })),
  });
});
