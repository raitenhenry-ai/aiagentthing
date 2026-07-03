import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { agents, listings, orders, reviews } from '@/db/schema';
import { ApiError } from './http';
import { newId } from './ids';
import { isSettled, type OrderState } from './state-machine';
import { emitWebhookEvent } from './webhooks';

// Peer reviews: the subjective counterpart to the objective reputation
// engine. Hard rules that keep them meaningful:
//  - only parties to a SETTLED order may review, and only their counterparty
//  - one review per order per side, immutable once posted
//  - the subject is derived server-side, never chosen by the reviewer

export async function submitReview(
  db: Db,
  args: { orderId: string; reviewerAgentId: string; rating: number; comment?: string },
): Promise<{ reviewId: string; subjectAgentId: string }> {
  if (!Number.isInteger(args.rating) || args.rating < 1 || args.rating > 5) {
    throw new ApiError('invalid_rating', 'Rating must be an integer 1-5', 422);
  }
  const comment = (args.comment ?? '').slice(0, 2000);

  const rows = await db
    .select({
      id: orders.id,
      state: orders.state,
      buyerAgentId: orders.buyerAgentId,
      sellerAgentId: listings.sellerAgentId,
    })
    .from(orders)
    .innerJoin(listings, eq(orders.listingId, listings.id))
    .where(eq(orders.id, args.orderId));
  const order = rows[0];
  if (!order) throw new ApiError('not_found', 'Order not found', 404);

  const isBuyer = args.reviewerAgentId === order.buyerAgentId;
  const isSeller = args.reviewerAgentId === order.sellerAgentId;
  if (!isBuyer && !isSeller) throw new ApiError('not_found', 'Order not found', 404);
  if (!isSettled(order.state as OrderState)) {
    throw new ApiError('not_settled', 'Only settled orders can be reviewed', 409);
  }

  const subjectAgentId = isBuyer ? order.sellerAgentId : order.buyerAgentId;
  const reviewId = newId('rev');
  try {
    await db.insert(reviews).values({
      id: reviewId,
      orderId: order.id,
      reviewerAgentId: args.reviewerAgentId,
      subjectAgentId,
      role: isBuyer ? 'buyer_on_seller' : 'seller_on_buyer',
      rating: args.rating,
      comment,
    });
  } catch (e) {
    const text = `${String(e)} ${String((e as { cause?: unknown }).cause ?? '')}`;
    if (text.includes('reviews_order_reviewer_idx') || text.includes('duplicate key')) {
      throw new ApiError('already_reviewed', 'You already reviewed this order', 409);
    }
    throw e;
  }
  emitWebhookEvent(db, {
    event: 'review.received',
    agentIds: [subjectAgentId],
    payload: { order_id: order.id, rating: args.rating },
  });
  return { reviewId, subjectAgentId };
}

export interface ReviewSummary {
  average_rating: number | null;
  review_count: number;
  rating_histogram: Record<'1' | '2' | '3' | '4' | '5', number>;
}

export async function reviewSummary(db: Db, agentId: string): Promise<ReviewSummary> {
  const rows = await db
    .select({
      rating: reviews.rating,
      count: sql<string>`COUNT(*)`,
    })
    .from(reviews)
    .where(eq(reviews.subjectAgentId, agentId))
    .groupBy(reviews.rating);
  const histogram: ReviewSummary['rating_histogram'] = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let total = 0;
  let weighted = 0;
  for (const row of rows) {
    const count = Number(row.count);
    histogram[String(row.rating) as keyof typeof histogram] = count;
    total += count;
    weighted += row.rating * count;
  }
  return {
    average_rating: total > 0 ? Math.round((weighted / total) * 100) / 100 : null,
    review_count: total,
    rating_histogram: histogram,
  };
}

export async function listReviews(
  db: Db,
  agentId: string,
  opts: { limit?: number; offset?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await db
    .select({ review: reviews, reviewerName: agents.name })
    .from(reviews)
    .innerJoin(agents, eq(reviews.reviewerAgentId, agents.id))
    .where(eq(reviews.subjectAgentId, agentId))
    .orderBy(desc(reviews.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map(({ review, reviewerName }) => ({
    id: review.id,
    order_id: review.orderId,
    reviewer_agent_id: review.reviewerAgentId,
    reviewer_name: reviewerName,
    role: review.role,
    rating: review.rating,
    comment: review.comment,
    created_at: review.createdAt.toISOString(),
  }));
}
