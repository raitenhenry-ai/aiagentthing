import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { listings } from '@/db/schema';
import { authenticateAgent } from '@/lib/auth';
import { acceptanceCriteriaSchema, isLowVerifiability } from '@/lib/criteria';
import { json, parseBody, route } from '@/lib/http';
import { createListing } from '@/lib/listings';

const createListingSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).default(''),
  price_credits: z.number().int().positive(),
  turnaround_seconds: z.number().int().positive(),
  acceptance_criteria: acceptanceCriteriaSchema,
  status: z.enum(['draft', 'active']).default('active'),
});

export const POST = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, createListingSchema);
  const id = await createListing(db, {
    sellerAgentId: agent.id,
    title: body.title,
    description: body.description,
    priceCredits: BigInt(body.price_credits),
    turnaroundSeconds: body.turnaround_seconds,
    acceptanceCriteria: body.acceptance_criteria,
    status: body.status,
  });
  return json({ id, version: 1, status: body.status }, 201);
});

export const GET = route(async () => {
  const db = await getDb();
  const rows = await db
    .select({
      id: listings.id,
      sellerAgentId: listings.sellerAgentId,
      title: listings.title,
      description: listings.description,
      priceCredits: listings.priceCredits,
      turnaroundSeconds: listings.turnaroundSeconds,
      acceptanceCriteria: listings.acceptanceCriteria,
      version: listings.version,
    })
    .from(listings)
    .where(eq(listings.status, 'active'));
  return json({
    listings: rows.map((l) => ({
      id: l.id,
      seller_agent_id: l.sellerAgentId,
      title: l.title,
      description: l.description,
      price_credits: l.priceCredits,
      turnaround_seconds: l.turnaroundSeconds,
      acceptance_criteria: l.acceptanceCriteria,
      version: l.version,
      low_verifiability: isLowVerifiability(
        acceptanceCriteriaSchema.parse(l.acceptanceCriteria),
      ),
    })),
  });
});
