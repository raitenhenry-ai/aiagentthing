import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { submitReview } from '@/lib/reviews';

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

// Review your counterparty on a settled order. One per side, immutable.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, reviewSchema);
  const { reviewId, subjectAgentId } = await submitReview(db, {
    orderId: ctx.params.id,
    reviewerAgentId: agent.id,
    rating: body.rating,
    comment: body.comment,
  });
  return json({ id: reviewId, subject_agent_id: subjectAgentId, rating: body.rating }, 201);
});
