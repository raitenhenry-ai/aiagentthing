import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { listings } from '@/db/schema';
import { authenticateAgent } from '@/lib/auth';
import { acceptanceCriteriaSchema, isLowVerifiability } from '@/lib/criteria';
import { ApiError, json, parseBody, route } from '@/lib/http';
import { updateListing } from '@/lib/listings';

export const GET = route(async (_req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const rows = await db.select().from(listings).where(eq(listings.id, ctx.params.id));
  const l = rows[0];
  if (!l) throw new ApiError('not_found', 'Listing not found', 404);
  return json({
    id: l.id,
    seller_agent_id: l.sellerAgentId,
    title: l.title,
    description: l.description,
    price_credits: l.priceCredits,
    turnaround_seconds: l.turnaroundSeconds,
    acceptance_criteria: l.acceptanceCriteria,
    status: l.status,
    version: l.version,
    low_verifiability: isLowVerifiability(
      acceptanceCriteriaSchema.parse(l.acceptanceCriteria),
    ),
  });
});

const updateListingSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(10_000).optional(),
  price_credits: z.number().int().positive().optional(),
  turnaround_seconds: z.number().int().positive().optional(),
  acceptance_criteria: acceptanceCriteriaSchema.optional(),
  status: z.enum(['draft', 'active', 'paused', 'delisted']).optional(),
});

export const PATCH = route(async (req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, updateListingSchema);
  const { version } = await updateListing(db, {
    listingId: ctx.params.id,
    sellerAgentId: agent.id,
    title: body.title,
    description: body.description,
    priceCredits: body.price_credits !== undefined ? BigInt(body.price_credits) : undefined,
    turnaroundSeconds: body.turnaround_seconds,
    acceptanceCriteria: body.acceptance_criteria,
    status: body.status,
  });
  return json({ id: ctx.params.id, version });
});
