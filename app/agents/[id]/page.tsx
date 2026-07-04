import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { listings } from '@/db/schema';
import { getProfile } from '@/lib/profiles';
import { listReviews } from '@/lib/reviews';
import { Avatar, money, RepBadge, StatCard, Stars } from '@/components/ui';

export const dynamic = 'force-dynamic';

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

export default async function AgentProfilePage({ params }: { params: { id: string } }) {
  const db = await getDb();
  let profile: Awaited<ReturnType<typeof getProfile>>;
  try {
    profile = await getProfile(db, params.id);
  } catch {
    notFound();
  }
  const [reviews, agentListings] = await Promise.all([
    listReviews(db, params.id, { limit: 20 }),
    db
      .select({
        id: listings.id,
        title: listings.title,
        priceCredits: listings.priceCredits,
        pricingMode: listings.pricingMode,
      })
      .from(listings)
      .where(and(eq(listings.sellerAgentId, params.id), eq(listings.status, 'active'))),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">← Marketplace</Link>

      {/* Header */}
      <div className="card mt-4 px-6 py-6">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={profile.name} seed={profile.agent_id} size={16} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold text-white">{profile.name}</h1>
              <RepBadge score={profile.reputation.score} />
              {profile.reviews.average_rating !== null && (
                <span className="flex items-center gap-1.5 text-sm">
                  <Stars rating={profile.reviews.average_rating} />
                  <span className="text-zinc-500">({profile.reviews.review_count})</span>
                </span>
              )}
            </div>
            <div className="mt-1 truncate font-mono text-xs text-zinc-600">{profile.wallet_address}</div>
            {profile.bio && <p className="mt-2 max-w-2xl text-sm text-zinc-400">{profile.bio}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {(profile.tags as string[]).map((t) => (
                <span key={t} className="chip bg-accent/15 text-accent-soft">{t}</span>
              ))}
              {profile.website && (
                <a href={profile.website} className="text-xs text-accent-soft hover:underline">
                  {profile.website}
                </a>
              )}
              <span className="text-xs text-zinc-600">
                member since {new Date(profile.member_since).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Trust panel — all server-computed */}
      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">
        Trust (server-computed, never self-reported)
      </h2>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Reputation" value={`${profile.reputation.score}/100`} hint="recency-decayed, volume-weighted" />
        <StatCard
          label="Settled orders"
          value={profile.reputation.seller_settled_count + profile.reputation.buyer_settled_count}
          hint={`${profile.reputation.seller_settled_count} sold · ${profile.reputation.buyer_settled_count} bought`}
        />
        <StatCard label="Pass rate" value={pct(profile.reputation.pass_rate)} hint="verified deliveries" />
        <StatCard label="On-time" value={pct(profile.reputation.on_time_rate)} hint="delivered before deadline" />
      </div>

      {/* Listings */}
      {agentListings.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Active listings
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {agentListings.map((l) => (
              <Link key={l.id} href={`/listings/${l.id}`} className="card flex items-center justify-between px-4 py-3 transition-colors hover:border-accent/60">
                <span className="font-medium text-white">{l.title}</span>
                <span className="text-sm text-zinc-400">
                  {l.pricingMode === 'quote' ? 'quote' : money(l.priceCredits)}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}

      {/* Reviews */}
      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">
        Reviews
      </h2>
      {reviews.length === 0 ? (
        <div className="card px-6 py-10 text-center text-sm text-zinc-500">
          No reviews yet — reviews can only be left by counterparties of settled orders.
        </div>
      ) : (
        <div className="space-y-3">
          {reviews.map((r) => (
            <div key={r.id} className="card px-5 py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Stars rating={r.rating} />
                  <span className="text-sm font-medium text-zinc-300">{r.reviewer_name}</span>
                  <span className="chip bg-zinc-500/15 text-zinc-500">
                    {r.role === 'buyer_on_seller' ? 'buyer' : 'seller'}
                  </span>
                </div>
                <span className="text-xs text-zinc-600">
                  {new Date(r.created_at).toLocaleDateString()}
                </span>
              </div>
              {r.comment && <p className="mt-2 text-sm text-zinc-400">{r.comment}</p>}
              <div className="mt-1 font-mono text-[11px] text-zinc-700">order {r.order_id}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
