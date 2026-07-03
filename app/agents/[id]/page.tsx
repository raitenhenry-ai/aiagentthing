import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { listings } from '@/db/schema';
import { getProfile } from '@/lib/profiles';
import { listReviews } from '@/lib/reviews';

export const dynamic = 'force-dynamic';

export default async function AgentProfilePage({ params }: { params: { id: string } }) {
  const db = await getDb();
  let profile;
  try {
    profile = await getProfile(db, params.id);
  } catch {
    notFound();
  }
  const [reviews, agentListings] = await Promise.all([
    listReviews(db, params.id, { limit: 20 }),
    db
      .select({ id: listings.id, title: listings.title, priceCredits: listings.priceCredits, pricingMode: listings.pricingMode })
      .from(listings)
      .where(and(eq(listings.sellerAgentId, params.id), eq(listings.status, 'active'))),
  ]);

  return (
    <main style={{ maxWidth: '48rem' }}>
      <p>
        <Link href="/">← marketplace</Link>
      </p>
      <h1>{profile.name}</h1>
      <p style={{ color: '#666' }}>
        <code>{profile.wallet_address}</code> · member since{' '}
        {new Date(profile.member_since).toLocaleDateString()}
        {profile.website && (
          <>
            {' · '}
            <a href={profile.website}>{profile.website}</a>
          </>
        )}
      </p>
      {profile.bio && <p>{profile.bio}</p>}
      {profile.tags.length > 0 && (
        <p>
          {profile.tags.map((t: string) => (
            <span key={t} style={{ background: '#eef', borderRadius: 4, padding: '2px 8px', marginRight: 6 }}>
              {t}
            </span>
          ))}
        </p>
      )}

      <h2>Trust</h2>
      <ul>
        <li>
          <strong>Reputation: {profile.reputation.score}/100</strong> (server-computed from settled
          orders — never self-reported)
        </li>
        <li>
          Settled: {profile.reputation.seller_settled_count} as seller,{' '}
          {profile.reputation.buyer_settled_count} as buyer
        </li>
        {profile.reputation.pass_rate !== null && (
          <li>Pass rate: {Math.round(profile.reputation.pass_rate * 100)}% · on-time:{' '}
            {profile.reputation.on_time_rate !== null ? Math.round(profile.reputation.on_time_rate * 100) : '—'}%
          </li>
        )}
        <li>
          Reviews: {profile.reviews.average_rating ?? '—'}★ ({profile.reviews.review_count})
        </li>
      </ul>

      {agentListings.length > 0 && (
        <>
          <h2>Active listings</h2>
          <ul>
            {agentListings.map((l) => (
              <li key={l.id}>
                <Link href={`/listings/${l.id}`}>{l.title}</Link> —{' '}
                {l.pricingMode === 'quote'
                  ? 'quote-priced'
                  : `$${(Number(l.priceCredits) / 100).toFixed(2)}`}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Reviews</h2>
      {reviews.length === 0 && <p>No reviews yet.</p>}
      {reviews.map((r) => (
        <div key={r.id} style={{ borderTop: '1px solid #eee', padding: '0.5rem 0' }}>
          <strong>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</strong>{' '}
          <span style={{ color: '#666' }}>
            by {r.reviewer_name} ({r.role === 'buyer_on_seller' ? 'buyer' : 'seller'}) ·{' '}
            {new Date(r.created_at).toLocaleDateString()}
          </span>
          {r.comment && <p style={{ margin: '0.3rem 0' }}>{r.comment}</p>}
        </div>
      ))}
    </main>
  );
}
