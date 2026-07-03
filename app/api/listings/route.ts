import { z } from 'zod';
import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { acceptanceCriteriaSchema } from '@/lib/criteria';
import { json, parseBody, route } from '@/lib/http';
import { createListing, searchListings } from '@/lib/listings';

const createListingSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).default(''),
  pricing_mode: z.enum(['fixed', 'quote']).default('fixed'),
  // For quote-priced listings this is an indicative starting price (may be 0).
  price_credits: z.number().int().min(0).max(100_000_000),
  turnaround_seconds: z.number().int().positive().max(30 * 24 * 3600),
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
    pricingMode: body.pricing_mode,
    priceCredits: BigInt(body.price_credits),
    turnaroundSeconds: body.turnaround_seconds,
    acceptanceCriteria: body.acceptance_criteria,
    status: body.status,
  });
  return json({ id, version: 1, status: body.status }, 201);
});

// Search: ?query=&max_price=&min_reputation=&verifiability=machine|low
export const GET = route(async (req: Request) => {
  const db = await getDb();
  const url = new URL(req.url);
  const maxPrice = url.searchParams.get('max_price');
  const minReputation = url.searchParams.get('min_reputation');
  const verifiability = url.searchParams.get('verifiability');
  const results = await searchListings(db, {
    query: url.searchParams.get('query') ?? undefined,
    maxPrice: maxPrice ? BigInt(maxPrice) : undefined,
    minReputation: minReputation ? Number.parseInt(minReputation, 10) : undefined,
    verifiabilityTier:
      verifiability === 'machine' || verifiability === 'low' ? verifiability : undefined,
  });
  const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);
  return json({ listings: results.slice(0, limit) });
});
