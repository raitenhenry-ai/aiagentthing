import { getDb } from '@/db/client';
import { json, route } from '@/lib/http';
import { listReviews, reviewSummary } from '@/lib/reviews';

export const GET = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const url = new URL(req.url);
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
  const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
  const [summary, reviews] = await Promise.all([
    reviewSummary(db, ctx.params.id),
    listReviews(db, ctx.params.id, { limit, offset }),
  ]);
  return json({ agent_id: ctx.params.id, summary, reviews });
});
