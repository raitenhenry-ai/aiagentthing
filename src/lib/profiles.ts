import { and, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { agents, listings } from '@/db/schema';
import { ApiError } from './http';
import { computeReputation } from './reputation';
import { reviewSummary } from './reviews';

// Public agent profiles: self-described identity (name, bio, tags, links)
// layered over server-computed trust (reputation + reviews). Wallets stay
// visible — that's the identity.

export const profileUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  bio: z.string().max(2000).optional(),
  avatar_url: z.string().url().max(500).startsWith('http').nullable().optional(),
  website: z.string().url().max(500).startsWith('http').nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  capabilities: z.array(z.enum(['buyer', 'seller'])).min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function updateProfile(
  db: Db,
  agentId: string,
  patch: z.infer<typeof profileUpdateSchema>,
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.bio !== undefined) update.bio = patch.bio;
  if (patch.avatar_url !== undefined) update.avatarUrl = patch.avatar_url;
  if (patch.website !== undefined) update.website = patch.website;
  if (patch.tags !== undefined) update.tags = patch.tags.map((t) => t.toLowerCase());
  if (patch.capabilities !== undefined) update.capabilities = patch.capabilities;
  if (patch.metadata !== undefined) {
    if (JSON.stringify(patch.metadata).length > 10_000) {
      throw new ApiError('metadata_too_large', 'Profile metadata exceeds 10KB', 422);
    }
    update.metadata = patch.metadata;
  }
  if (Object.keys(update).length === 0) return;
  await db.update(agents).set(update).where(eq(agents.id, agentId));
}

export async function getProfile(db: Db, agentId: string) {
  const rows = await db.select().from(agents).where(eq(agents.id, agentId));
  const agent = rows[0];
  if (!agent) throw new ApiError('not_found', 'Agent not found', 404);

  const [reputation, reviews, activeListings] = await Promise.all([
    computeReputation(db, agent.id),
    reviewSummary(db, agent.id),
    db
      .select({ n: count() })
      .from(listings)
      .where(and(eq(listings.sellerAgentId, agent.id), eq(listings.status, 'active'))),
  ]);

  return {
    agent_id: agent.id,
    wallet_address: agent.walletAddress,
    name: agent.name,
    bio: agent.bio,
    avatar_url: agent.avatarUrl,
    website: agent.website,
    tags: agent.tags,
    capabilities: agent.capabilities,
    metadata: agent.metadata,
    status: agent.status,
    member_since: agent.createdAt.toISOString(),
    active_listing_count: Number(activeListings[0]?.n ?? 0),
    reputation: {
      score: reputation.score,
      seller_settled_count: reputation.seller_settled_count,
      buyer_settled_count: reputation.buyer_settled_count,
      pass_rate: reputation.pass_rate,
      on_time_rate: reputation.on_time_rate,
      override_needed_rate: reputation.override_needed_rate,
      dispute_loss_rate: reputation.dispute_loss_rate,
    },
    reviews,
  };
}
