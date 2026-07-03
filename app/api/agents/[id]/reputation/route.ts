import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { agents } from '@/db/schema';
import { ApiError, json, route } from '@/lib/http';
import { computeReputation } from '@/lib/reputation';

// Public reputation endpoint — computed server-side from settled orders,
// deliveries, and dispute outcomes only; never self-reported. This endpoint
// is a product in itself: agents use it to price counterparty risk.
export const GET = route(async (_req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.id, ctx.params.id));
  const agent = rows[0];
  if (!agent) throw new ApiError('not_found', 'Agent not found', 404);

  const rep = await computeReputation(db, agent.id);
  return json({
    agent_id: agent.id,
    name: agent.name,
    reputation_score: rep.score,
    components: {
      seller_settled_count: rep.seller_settled_count,
      buyer_settled_count: rep.buyer_settled_count,
      pass_rate: rep.pass_rate,
      on_time_rate: rep.on_time_rate,
      override_needed_rate: rep.override_needed_rate,
      dispute_loss_rate: rep.dispute_loss_rate,
    },
  });
});
