import { and, desc, eq, or } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { listings, orders, quotes } from '@/db/schema';
import { ApiError } from './http';
import { newId } from './ids';
import { emitWebhookEvent } from './webhooks';

// RFQ flow: buyer requests a quote (freezing the listing's criteria version),
// seller prices it, buyer accepts → an order at the quoted terms, paid
// through the exact same x402 402→pay flow as fixed-price orders.

const QUOTE_TTL_MS =
  Number.parseInt(process.env.QUOTE_TTL_SECONDS ?? String(72 * 3600), 10) * 1000;

const MAX_QUOTE_PRICE = 100_000_000n; // $1M — sanity cap, matches listings

export async function requestQuote(
  db: Db,
  args: { buyerAgentId: string; listingId: string; inputPayload: unknown; message?: string },
): Promise<{ quoteId: string; sellerAgentId: string; expiresAt: Date }> {
  const listingRows = await db
    .select({
      id: listings.id,
      sellerAgentId: listings.sellerAgentId,
      status: listings.status,
      version: listings.version,
    })
    .from(listings)
    .where(eq(listings.id, args.listingId));
  const listing = listingRows[0];
  if (!listing) throw new ApiError('not_found', 'Listing not found', 404);
  if (listing.status !== 'active') {
    throw new ApiError('listing_not_active', 'Listing is not active', 409);
  }
  if (listing.sellerAgentId === args.buyerAgentId) {
    throw new ApiError('self_dealing', 'An agent cannot quote its own listing', 409);
  }

  const quoteId = newId('qot');
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS);
  await db.insert(quotes).values({
    id: quoteId,
    listingId: listing.id,
    listingVersion: listing.version,
    buyerAgentId: args.buyerAgentId,
    sellerAgentId: listing.sellerAgentId,
    inputPayload: args.inputPayload,
    message: args.message ?? '',
    expiresAt,
  });
  emitWebhookEvent(db, {
    event: 'quote.requested',
    agentIds: [listing.sellerAgentId],
    payload: { quote_id: quoteId, listing_id: listing.id },
  });
  return { quoteId, sellerAgentId: listing.sellerAgentId, expiresAt };
}

export async function respondToQuote(
  db: Db,
  args: {
    quoteId: string;
    sellerAgentId: string;
    priceCredits: bigint;
    turnaroundSeconds: number;
    message?: string;
  },
): Promise<void> {
  if (args.priceCredits <= 0n || args.priceCredits > MAX_QUOTE_PRICE) {
    throw new ApiError('invalid_price', 'Quoted price out of range', 422);
  }
  await db.transaction(async (tx) => {
    const rows = await tx.select().from(quotes).where(eq(quotes.id, args.quoteId)).for('update');
    const quote = rows[0];
    if (!quote || quote.sellerAgentId !== args.sellerAgentId) {
      throw new ApiError('not_found', 'Quote not found', 404);
    }
    if (quote.status !== 'pending') {
      throw new ApiError('bad_state', `Quote is ${quote.status}`, 409);
    }
    if (quote.expiresAt < new Date()) throw new ApiError('expired', 'Quote request expired', 409);
    await tx
      .update(quotes)
      .set({
        status: 'quoted',
        quotedPriceCredits: args.priceCredits,
        quotedTurnaroundSeconds: args.turnaroundSeconds,
        sellerMessage: args.message ?? null,
        respondedAt: new Date(),
      })
      .where(eq(quotes.id, args.quoteId));
  });
  const buyer = (await db.select().from(quotes).where(eq(quotes.id, args.quoteId)))[0];
  if (buyer) {
    emitWebhookEvent(db, {
      event: 'quote.responded',
      agentIds: [buyer.buyerAgentId],
      payload: { quote_id: args.quoteId, price_credits: Number(args.priceCredits) },
    });
  }
}

/** Buyer accepts → order in `created` at the quoted terms; pay via x402. */
export async function acceptQuote(
  db: Db,
  args: { quoteId: string; buyerAgentId: string },
): Promise<{ orderId: string; priceCredits: bigint }> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(quotes).where(eq(quotes.id, args.quoteId)).for('update');
    const quote = rows[0];
    if (!quote || quote.buyerAgentId !== args.buyerAgentId) {
      throw new ApiError('not_found', 'Quote not found', 404);
    }
    if (quote.status !== 'quoted') throw new ApiError('bad_state', `Quote is ${quote.status}`, 409);
    if (quote.expiresAt < new Date()) {
      await tx.update(quotes).set({ status: 'expired' }).where(eq(quotes.id, quote.id));
      throw new ApiError('expired', 'Quote expired before acceptance', 409);
    }
    const price = quote.quotedPriceCredits;
    const turnaround = quote.quotedTurnaroundSeconds;
    if (price === null || turnaround === null) {
      throw new ApiError('bad_state', 'Quote has no price', 409);
    }

    const orderId = newId('ord');
    await tx.insert(orders).values({
      id: orderId,
      listingId: quote.listingId,
      listingVersion: quote.listingVersion, // criteria frozen at request time
      buyerAgentId: quote.buyerAgentId,
      state: 'created',
      priceCredits: price,
      quoteId: quote.id,
      inputPayload: quote.inputPayload,
      deadlineAt: new Date(Date.now() + turnaround * 1000),
    });
    await tx.update(quotes).set({ status: 'accepted', orderId }).where(eq(quotes.id, quote.id));
    return { orderId, priceCredits: price };
  });
}

export async function declineQuote(
  db: Db,
  args: { quoteId: string; agentId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.select().from(quotes).where(eq(quotes.id, args.quoteId)).for('update');
    const quote = rows[0];
    if (!quote || (quote.buyerAgentId !== args.agentId && quote.sellerAgentId !== args.agentId)) {
      throw new ApiError('not_found', 'Quote not found', 404);
    }
    if (quote.status !== 'pending' && quote.status !== 'quoted') {
      throw new ApiError('bad_state', `Quote is ${quote.status}`, 409);
    }
    await tx.update(quotes).set({ status: 'declined' }).where(eq(quotes.id, quote.id));
  });
}

export async function listQuotes(db: Db, agentId: string) {
  const rows = await db
    .select({ quote: quotes, listingTitle: listings.title })
    .from(quotes)
    .innerJoin(listings, eq(quotes.listingId, listings.id))
    .where(or(eq(quotes.buyerAgentId, agentId), eq(quotes.sellerAgentId, agentId)))
    .orderBy(desc(quotes.createdAt))
    .limit(100);
  return rows.map(({ quote, listingTitle }) => ({
    id: quote.id,
    listing_id: quote.listingId,
    listing_title: listingTitle,
    role: quote.buyerAgentId === agentId ? 'buyer' : 'seller',
    status: quote.status,
    input_payload: quote.inputPayload,
    message: quote.message,
    quoted_price_credits: quote.quotedPriceCredits,
    quoted_turnaround_seconds: quote.quotedTurnaroundSeconds,
    seller_message: quote.sellerMessage,
    order_id: quote.orderId,
    expires_at: quote.expiresAt.toISOString(),
    created_at: quote.createdAt.toISOString(),
  }));
}

/** Read guard shared by the get-quote route. */
export async function getQuoteFor(db: Db, quoteId: string, agentId: string) {
  const rows = await db
    .select()
    .from(quotes)
    .where(
      and(
        eq(quotes.id, quoteId),
        or(eq(quotes.buyerAgentId, agentId), eq(quotes.sellerAgentId, agentId)),
      ),
    );
  const quote = rows[0];
  if (!quote) throw new ApiError('not_found', 'Quote not found', 404);
  return quote;
}
