import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { listings, orders, portfolioItems } from '@/db/schema';
import { ApiError } from './http';
import { newId } from './ids';

// Portfolio = an agent's showcased examples of work. An item may carry an
// external link OR an uploaded file/image (a data: URI), an inline sample
// deliverable, and optionally an order_id linking it to a real settled order
// (which the profile surfaces as a verified proof-of-work badge).

const MAX_ITEMS = 16;
const MAX_TITLE = 200;
const MAX_DESC = 2000;
const MAX_URL = 700_000; // ~500KB file as a data: URI
const MAX_SAMPLE_BYTES = 32_000;

export interface PortfolioInput {
  agentId: string;
  title: string;
  description?: string;
  /** External link, or an uploaded file/image as a `data:` URI. */
  url?: string;
  /** Inline example output (JSON/text). */
  sample?: unknown;
  /** A settled order this example came from — shown as verified. */
  orderId?: string;
}

function byteLen(v: unknown): number {
  return Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? ''), 'utf8');
}

export async function addPortfolioItem(
  db: Db,
  input: PortfolioInput,
): Promise<{ itemId: string }> {
  const title = input.title.trim();
  if (!title) throw new ApiError('invalid_item', 'Title is required', 422);
  if (title.length > MAX_TITLE) throw new ApiError('invalid_item', 'Title too long', 422);
  if ((input.description ?? '').length > MAX_DESC) {
    throw new ApiError('invalid_item', 'Description too long', 422);
  }
  if (!input.url && input.sample === undefined) {
    throw new ApiError('invalid_item', 'Provide a url (link or uploaded file) or a sample', 422);
  }
  if (input.url) {
    if (input.url.length > MAX_URL) {
      throw new ApiError('file_too_large', 'Uploaded file/link exceeds the size limit (~500KB)', 413);
    }
    if (!/^(https?:\/\/|data:)/i.test(input.url)) {
      throw new ApiError('invalid_url', 'url must be an http(s) link or a data: URI', 422);
    }
  }
  if (input.sample !== undefined && byteLen(input.sample) > MAX_SAMPLE_BYTES) {
    throw new ApiError('sample_too_large', 'Inline sample exceeds 32KB', 413);
  }

  // A proof-linked example must be one of the agent's own settled orders.
  if (input.orderId) {
    const rows = await db
      .select({ state: orders.state, buyer: orders.buyerAgentId, seller: listings.sellerAgentId })
      .from(orders)
      .innerJoin(listings, eq(orders.listingId, listings.id))
      .where(eq(orders.id, input.orderId));
    const o = rows[0];
    if (!o) throw new ApiError('not_found', 'Order not found', 404);
    if (o.buyer !== input.agentId && o.seller !== input.agentId) {
      throw new ApiError('forbidden', 'You can only showcase your own orders', 403);
    }
    if (!o.state.startsWith('settled')) {
      throw new ApiError('not_settled', 'Only settled orders can be showcased', 409);
    }
  }

  const existing = await db
    .select({ id: portfolioItems.id })
    .from(portfolioItems)
    .where(eq(portfolioItems.agentId, input.agentId));
  if (existing.length >= MAX_ITEMS) {
    throw new ApiError('too_many_items', `Portfolio is capped at ${MAX_ITEMS} items`, 409);
  }

  const itemId = newId('pfl');
  await db.insert(portfolioItems).values({
    id: itemId,
    agentId: input.agentId,
    title,
    description: input.description?.trim() ?? '',
    url: input.url,
    sample: input.sample ?? null,
    orderId: input.orderId,
    position: existing.length,
  });
  return { itemId };
}

export interface PortfolioItemView {
  id: string;
  title: string;
  description: string;
  url: string | null;
  is_image: boolean;
  sample: unknown;
  order_id: string | null;
  verified: boolean;
  created_at: string;
}

export async function listPortfolio(db: Db, agentId: string): Promise<PortfolioItemView[]> {
  const rows = await db
    .select()
    .from(portfolioItems)
    .where(eq(portfolioItems.agentId, agentId))
    .orderBy(asc(portfolioItems.position), asc(portfolioItems.createdAt));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    url: r.url,
    is_image: !!r.url && /^data:image\/|\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(r.url),
    sample: r.sample,
    order_id: r.orderId,
    verified: !!r.orderId,
    created_at: r.createdAt.toISOString(),
  }));
}

export async function removePortfolioItem(
  db: Db,
  args: { agentId: string; itemId: string },
): Promise<void> {
  const res = await db
    .delete(portfolioItems)
    .where(and(eq(portfolioItems.id, args.itemId), eq(portfolioItems.agentId, args.agentId)))
    .returning({ id: portfolioItems.id });
  if (res.length === 0) throw new ApiError('not_found', 'Portfolio item not found', 404);
}
