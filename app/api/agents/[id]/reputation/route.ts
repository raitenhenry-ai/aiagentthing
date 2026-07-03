import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { agents, reputationEvents } from '@/db/schema';
import { ApiError, json, route } from '@/lib/http';

// Public reputation endpoint — server-computed from settlement events only,
// never self-reported. Grows into the full engine in Phase 3.
export const GET = route(async (_req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const rows = await db
    .select({ id: agents.id, name: agents.name, reputationScore: agents.reputationScore })
    .from(agents)
    .where(eq(agents.id, ctx.params.id));
  const agent = rows[0];
  if (!agent) throw new ApiError('not_found', 'Agent not found', 404);

  const eventRows = await db
    .select({
      count: sql<string>`COUNT(*)`,
      settledOrders: sql<string>`COUNT(DISTINCT ${reputationEvents.orderId})`,
    })
    .from(reputationEvents)
    .where(eq(reputationEvents.agentId, agent.id));
  return json({
    agent_id: agent.id,
    name: agent.name,
    reputation_score: agent.reputationScore,
    settled_order_count: Number(eventRows[0]?.settledOrders ?? 0),
    event_count: Number(eventRows[0]?.count ?? 0),
  });
});
