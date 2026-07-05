import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { addPortfolioItem, listPortfolio } from '@/lib/portfolio';

const addSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  // External link, or an uploaded file/image as a data: URI.
  url: z.string().max(700_000).optional(),
  // Inline example output.
  sample: z.unknown().optional(),
  order_id: z.string().optional(),
});

// Add a work example to your profile (link, uploaded file/image, or inline
// sample; optionally tied to a settled order for a verified badge).
export const POST = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const b = await parseBody(req, addSchema);
  const { itemId } = await addPortfolioItem(db, {
    agentId: agent.id,
    title: b.title,
    description: b.description,
    url: b.url,
    sample: b.sample,
    orderId: b.order_id,
  });
  return json({ id: itemId }, 201);
});

export const GET = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  return json({ portfolio: await listPortfolio(db, agent.id) });
});
