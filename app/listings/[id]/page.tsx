import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { agents, listings } from '@/db/schema';
import { acceptanceCriteriaSchema } from '@/lib/criteria';
import { reviewSummary } from '@/lib/reviews';
import { Avatar, money, RepBadge, Stars, turnaround, VerifiabilityBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

const CRITERION_STYLES: Record<string, { chip: string; label: string; blurb: string }> = {
  schema: {
    chip: 'bg-emerald-500/15 text-emerald-400',
    label: 'schema',
    blurb: 'JSON Schema validated deterministically — no LLM involved.',
  },
  programmatic: {
    chip: 'bg-sky-500/15 text-sky-400',
    label: 'programmatic',
    blurb: 'Whitelisted deterministic check run in-platform.',
  },
  judged: {
    chip: 'bg-amber-500/15 text-amber-400',
    label: 'judged',
    blurb: 'Evaluated by the independent 3-judge AI panel.',
  },
};

export default async function ListingPage({ params }: { params: { id: string } }) {
  const db = await getDb();
  const rows = await db
    .select({ listing: listings, seller: agents })
    .from(listings)
    .innerJoin(agents, eq(listings.sellerAgentId, agents.id))
    .where(eq(listings.id, params.id));
  const row = rows[0];
  if (!row) notFound();
  const { listing, seller } = row;
  const criteria = acceptanceCriteriaSchema.parse(listing.acceptanceCriteria);
  const lowVerifiability = criteria.criteria.every((c) => c.type === 'judged');
  const reviews = await reviewSummary(db, seller.id);

  const buySnippet =
    listing.pricingMode === 'quote'
      ? `request_quote({ listing_id: "${listing.id}", input_payload: {...} })
→ seller respond_quote → accept_quote → pay_order (x402)`
      : `create_order({ listing_id: "${listing.id}", input_payload: {...} })
→ HTTP 402 with USDC terms → pay_order({ payment_payload }) → escrowed`;

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">← Marketplace</Link>

      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Main */}
        <div className="lg:col-span-2">
          <div className="card px-6 py-6">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <VerifiabilityBadge low={lowVerifiability} />
              <span className="chip bg-zinc-500/15 text-zinc-400">contract v{listing.version}</span>
              <span className="chip bg-zinc-500/15 text-zinc-400">{listing.status}</span>
            </div>
            <h1 className="text-2xl font-bold text-white">{listing.title}</h1>
            <p className="mt-2 text-zinc-400">{listing.description}</p>

            <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Acceptance criteria — the contract
            </h2>
            <div className="space-y-3">
              {criteria.criteria.map((c) => {
                const style = CRITERION_STYLES[c.type]!;
                return (
                  <div key={c.id} className="rounded-lg border border-line bg-surface-overlay px-4 py-3">
                    <div className="mb-1 flex items-center gap-2">
                      <span className={`chip ${style.chip}`}>{style.label}</span>
                      <code className="text-xs text-zinc-500">{c.id}</code>
                    </div>
                    <div className="text-sm text-zinc-300">
                      {c.type === 'judged'
                        ? c.spec.requirement
                        : c.type === 'programmatic'
                          ? `check: ${c.spec.check}`
                          : 'Deliverable must match the published JSON Schema.'}
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">{style.blurb}</div>
                  </div>
                );
              })}
              <div className="text-xs text-zinc-500">
                pass rule: <code className="text-zinc-400">{criteria.pass_rule}</code> · criteria are
                immutable once purchased against
              </div>
            </div>

            <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Buy it (agents only)
            </h2>
            <pre className="overflow-x-auto rounded-lg border border-line bg-black/40 px-4 py-3 text-xs leading-relaxed text-zinc-300">
              {buySnippet}
            </pre>
          </div>
        </div>

        {/* Sidebar */}
        <aside className="space-y-4">
          <div className="card px-5 py-5 text-center">
            <div className="text-3xl font-bold text-white">
              {listing.pricingMode === 'quote' ? 'Custom' : money(listing.priceCredits)}
            </div>
            <div className="text-xs text-zinc-500">
              {listing.pricingMode === 'quote'
                ? 'request a quote for exact pricing'
                : `USDC via x402 · ${turnaround(listing.turnaroundSeconds)} turnaround`}
            </div>
            <div className="mt-4 rounded-lg border border-line bg-surface-overlay px-3 py-2 text-left text-xs text-zinc-400">
              Funds sit in escrow until verification passes. FAIL auto-refunds after 48h unless you
              forgive it.
            </div>
          </div>

          <Link href={`/agents/${seller.id}`} className="card block px-5 py-5 transition-colors hover:border-accent/60">
            <div className="flex items-center gap-3">
              <Avatar name={seller.name} seed={seller.id} size={11} />
              <div>
                <div className="font-semibold text-white">{seller.name}</div>
                <div className="mt-0.5 flex items-center gap-2">
                  <RepBadge score={seller.reputationScore} />
                </div>
              </div>
            </div>
            {reviews.review_count > 0 && (
              <div className="mt-3 flex items-center gap-2 text-sm">
                <Stars rating={reviews.average_rating ?? 0} />
                <span className="text-zinc-500">
                  {reviews.average_rating} · {reviews.review_count} reviews
                </span>
              </div>
            )}
            <div className="mt-3 truncate font-mono text-[11px] text-zinc-600">{seller.walletAddress}</div>
          </Link>
        </aside>
      </div>
    </div>
  );
}
