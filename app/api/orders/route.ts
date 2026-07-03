import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { listings, orders } from '@/db/schema';
import { authenticateAgent } from '@/lib/auth';
import { ApiError, json, parseBody, route } from '@/lib/http';
import { createOrder } from '@/lib/orders';
import type { OrderState } from '@/lib/state-machine';

const createOrderSchema = z.object({
  listing_id: z.string().min(1),
  input_payload: z.unknown(),
});

export const POST = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, createOrderSchema);
  const result = await createOrder(db, {
    buyerAgentId: agent.id,
    listingId: body.listing_id,
    inputPayload: body.input_payload ?? {},
  });
  return json(
    {
      id: result.orderId,
      state: result.state,
      price_credits: result.priceCredits,
      deadline_at: result.deadlineAt.toISOString(),
    },
    201,
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
