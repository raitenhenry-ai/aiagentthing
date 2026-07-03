import { and, eq, gte, ilike, lte, or, type SQL } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { agents, listings, listingVersions } from '@/db/schema';
import {
  acceptanceCriteriaSchema,
  isLowVerifiability,
  type AcceptanceCriteria,
} from './criteria';
import { ApiError } from './http';
import { newId } from './ids';

export interface SearchFilters {
  query?: string;
  maxPrice?: bigint;
  minReputation?: number;
  /** 'machine' → at least one machine-checkable criterion; 'low' → judged-only. */
  verifiabilityTier?: 'machine' | 'low';
}

export interface ListingView {
  id: string;
  seller_agent_id: string;
  seller_reputation: number;
  title: string;
  description: string;
  price_credits: bigint;
  turnaround_seconds: number;
  acceptance_criteria: AcceptanceCriteria;
  version: number;
  low_verifiability: boolean;
}

/** Search active listings. Never restricted by category — the marketplace is
 * horizontal; verifiability tiers do the sorting. */
export async function searchListings(db: Db, f: SearchFilters = {}): Promise<ListingView[]> {
  const conditions: SQL[] = [eq(listings.status, 'active')];
  if (f.query) {
    const pattern = `%${f.query.replace(/[%_\\]/g, '\\$&')}%`;
    const match = or(ilike(listings.title, pattern), ilike(listings.description, pattern));
    if (match) conditions.push(match);
  }
  if (f.maxPrice !== undefined) conditions.push(lte(listings.priceCredits, f.maxPrice));
  if (f.minReputation !== undefined) {
    conditions.push(gte(agents.reputationScore, f.minReputation));
  }

  const rows = await db
    .select({ listing: listings, sellerReputation: agents.reputationScore })
    .from(listings)
    .innerJoin(agents, eq(listings.sellerAgentId, agents.id))
    .where(and(...conditions));

  return rows
    .map(({ listing, sellerReputation }) => {
      const criteria = acceptanceCriteriaSchema.parse(listing.acceptanceCriteria);
      return {
        id: listing.id,
        seller_agent_id: listing.sellerAgentId,
        seller_reputation: sellerReputation,
        title: listing.title,
        description: listing.description,
        price_credits: listing.priceCredits,
        turnaround_seconds: listing.turnaroundSeconds,
        acceptance_criteria: criteria,
        version: listing.version,
        low_verifiability: isLowVerifiability(criteria),
      };
    })
    .filter((l) =>
      f.verifiabilityTier === 'machine'
        ? !l.low_verifiability
        : f.verifiabilityTier === 'low'
          ? l.low_verifiability
          : true,
    );
}

export interface CreateListingArgs {
  sellerAgentId: string;
  title: string;
  description?: string;
  priceCredits: bigint;
  turnaroundSeconds: number;
  acceptanceCriteria: AcceptanceCriteria;
  status?: 'draft' | 'active';
}

/** Create a listing and its immutable version-1 snapshot. */
export async function createListing(db: Db, args: CreateListingArgs): Promise<string> {
  const criteria = acceptanceCriteriaSchema.parse(args.acceptanceCriteria);
  const id = newId('lst');
  await db.transaction(async (tx) => {
    await tx.insert(listings).values({
      id,
      sellerAgentId: args.sellerAgentId,
      title: args.title,
      description: args.description ?? '',
      priceCredits: args.priceCredits,
      turnaroundSeconds: args.turnaroundSeconds,
      acceptanceCriteria: criteria,
      status: args.status ?? 'draft',
      version: 1,
    });
    await tx.insert(listingVersions).values({
      listingId: id,
      version: 1,
      priceCredits: args.priceCredits,
      turnaroundSeconds: args.turnaroundSeconds,
      acceptanceCriteria: criteria,
    });
  });
  return id;
}

export interface UpdateListingArgs {
  listingId: string;
  sellerAgentId: string;
  title?: string;
  description?: string;
  priceCredits?: bigint;
  turnaroundSeconds?: number;
  acceptanceCriteria?: AcceptanceCriteria;
  status?: 'draft' | 'active' | 'paused' | 'delisted';
}

/**
 * Update a listing. Contract-relevant edits (price, turnaround, criteria)
 * bump the version and write a new snapshot; existing orders keep the
 * version they purchased against.
 */
export async function updateListing(db: Db, args: UpdateListingArgs): Promise<{ version: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(listings)
      .where(eq(listings.id, args.listingId))
      .for('update');
    const listing = rows[0];
    if (!listing) throw new ApiError('not_found', 'Listing not found', 404);
    if (listing.sellerAgentId !== args.sellerAgentId) {
      throw new ApiError('forbidden', 'Only the listing seller may update it', 403);
    }

    const contractEdit =
      args.priceCredits !== undefined ||
      args.turnaroundSeconds !== undefined ||
      args.acceptanceCriteria !== undefined;

    const nextVersion = contractEdit ? listing.version + 1 : listing.version;
    const priceCredits = args.priceCredits ?? listing.priceCredits;
    const turnaroundSeconds = args.turnaroundSeconds ?? listing.turnaroundSeconds;
    const acceptanceCriteria = args.acceptanceCriteria
      ? acceptanceCriteriaSchema.parse(args.acceptanceCriteria)
      : listing.acceptanceCriteria;

    await tx
      .update(listings)
      .set({
        title: args.title ?? listing.title,
        description: args.description ?? listing.description,
        priceCredits,
        turnaroundSeconds,
        acceptanceCriteria,
        status: args.status ?? listing.status,
        version: nextVersion,
        updatedAt: new Date(),
      })
      .where(eq(listings.id, args.listingId));

    if (contractEdit) {
      await tx.insert(listingVersions).values({
        listingId: args.listingId,
        version: nextVersion,
        priceCredits,
        turnaroundSeconds,
        acceptanceCriteria,
      });
    }
    return { version: nextVersion };
  });
}
