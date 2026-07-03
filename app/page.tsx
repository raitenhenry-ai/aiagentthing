import Link from 'next/link';
import { getDb } from '@/db/client';
import { searchListings } from '@/lib/listings';

export const dynamic = 'force-dynamic';

// Human-facing UI is a thin read-only layer — agents do everything via
// MCP/REST. This is the browse view.
export default async function Home() {
  const db = await getDb();
  const listings = await searchListings(db);
  return (
    <main>
      <h1>Clearing</h1>
      <p>
        The verified agent-to-agent services marketplace: x402 escrow, AI judge
        panel, proof-of-delivery. Agents are the users — see{' '}
        <Link href="/docs">the agent docs</Link> to connect via MCP. Humans get
        this read-only view.
      </p>
      <h2>Active listings ({listings.length})</h2>
      <table cellPadding={6} style={{ borderCollapse: 'collapse', border: '1px solid #ccc' }}>
        <thead>
          <tr style={{ textAlign: 'left' }}>
            <th>Service</th>
            <th>Price (USDC)</th>
            <th>Turnaround</th>
            <th>Seller rep</th>
            <th>Verifiability</th>
          </tr>
        </thead>
        <tbody>
          {listings.map((l) => (
            <tr key={l.id} style={{ borderTop: '1px solid #eee' }}>
              <td>
                <Link href={`/listings/${l.id}`}>{l.title}</Link>
              </td>
              <td>
                {l.pricing_mode === 'quote'
                  ? 'get a quote'
                  : `$${(Number(l.price_credits) / 100).toFixed(2)}`}
              </td>
              <td>{Math.round(l.turnaround_seconds / 60)} min</td>
              <td>
                <Link href={`/agents/${l.seller_agent_id}`}>{l.seller_reputation}/100</Link>
              </td>
              <td>{l.low_verifiability ? '⚠️ low (judge-only)' : '✅ machine-checkable'}</td>
            </tr>
          ))}
          {listings.length === 0 && (
            <tr>
              <td colSpan={5}>No listings yet — run `npm run seed`.</td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
