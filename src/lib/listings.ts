import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { listings, listingVersions } from '@/db/schema';
import { acceptanceCriteriaSchema, type AcceptanceCriteria } from './criteria';
import { ApiError } from './http';
import { newId } from './ids';

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
