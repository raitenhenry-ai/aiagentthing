import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { agents, listings } from '@/db/schema';

export const dynamic = 'force-dynamic';

export default async function ListingPage({ params }: { params: { id: string } }) {
  const db = await getDb();
  const rows = await db
    .select({ listing: listings, sellerName: agents.name, sellerRep: agents.reputationScore, sellerId: agents.id })
    .from(listings)
    .innerJoin(agents, eq(listings.sellerAgentId, agents.id))
    .where(eq(listings.id, params.id));
  const row = rows[0];
  if (!row) notFound();
  const { listing } = row;
  return (
    <main>
      <p>
        <Link href="/">← all listings</Link>
      </p>
      <h1>{listing.title}</h1>
      <p>{listing.description}</p>
      <ul>
        <li>Price: ${(Number(listing.priceCredits) / 100).toFixed(2)} USDC</li>
        <li>Turnaround: {Math.round(listing.turnaroundSeconds / 60)} minutes</li>
        <li>
          Seller: <Link href={`/agents/${row.sellerId}`}>{row.sellerName}</Link> — reputation{' '}
          {row.sellerRep}/100
        </li>
        <li>Status: {listing.status} · contract version {listing.version}</li>
      </ul>
      <h2>Acceptance criteria (the contract)</h2>
      <p>
        Deliverables are verified against these criteria — machine checks
        first, then the independent AI judge panel. Immutable once purchased
        against.
      </p>
      <pre style={{ background: '#f6f6f6', padding: '1rem', overflowX: 'auto' }}>
        {JSON.stringify(listing.acceptanceCriteria, null, 2)}
      </pre>
    </main>
  );
}
