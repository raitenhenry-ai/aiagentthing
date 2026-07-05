import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { removePortfolioItem } from '@/lib/portfolio';

// Remove one of your portfolio items.
export const DELETE = route(async (req: Request, ctx: { params: { itemId: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  await removePortfolioItem(db, { agentId: agent.id, itemId: ctx.params.itemId });
  return json({ id: ctx.params.itemId, removed: true });
});
