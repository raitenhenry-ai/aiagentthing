import { count, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { agents, disputes, invoices, ledgerEntries, orders, payouts, quotes, reviews } from '@/db/schema';
import { requireAppSecret } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { ledgerSum, PLATFORM_ESCROW, PLATFORM_FEES, PLATFORM_PENDING, getBalance } from '@/lib/ledger';

// Ops health: the invariants that must hold at all times, live. The stress
// harness asserts against this after every round.
export const GET = route(async (req: Request) => {
  requireAppSecret(req);
  const db = await getDb();

  const [sum, escrow, fees, pending] = await Promise.all([
    ledgerSum(db),
    getBalance(db, PLATFORM_ESCROW),
    getBalance(db, PLATFORM_FEES),
    getBalance(db, PLATFORM_PENDING),
  ]);

  const stateCounts = await db
    .select({ state: orders.state, n: count() })
    .from(orders)
    .groupBy(orders.state);

  const [agentCount, ledgerCount, pendingPayouts, failedPayouts, quoteCount, invoiceCount, reviewCount, disputeCount] =
    await Promise.all([
      db.select({ n: count() }).from(agents),
      db.select({ n: count() }).from(ledgerEntries),
      db.select({ n: count() }).from(payouts).where(eq(payouts.status, 'pending')),
      db.select({ n: count() }).from(payouts).where(eq(payouts.status, 'failed')),
      db.select({ n: count() }).from(quotes),
      db.select({ n: count() }).from(invoices),
      db.select({ n: count() }).from(reviews),
      db.select({ n: count() }).from(disputes),
    ]);

  // Unbalanced entries: any ledger row whose pair doesn't negate it.
  // (Drivers disagree on execute() shape: postgres-js returns the row array,
  // neon/pglite wrap it in {rows} — normalize.)
  const unbalancedResult = await db.execute(sql`
    SELECT COUNT(*) AS n FROM ledger_entries a
    JOIN ledger_entries b ON a.balancing_entry_id = b.id
    WHERE a.amount + b.amount <> 0
  `);
  const unbalancedRows = Array.isArray(unbalancedResult)
    ? (unbalancedResult as Array<{ n: string }>)
    : ((unbalancedResult as unknown as { rows?: Array<{ n: string }> }).rows ?? []);

  return json({
    ok: sum === 0n,
    ledger: {
      sum,
      escrow_held: escrow,
      fees_earned: fees,
      pending_payout_reserve: pending,
      entry_count: Number(ledgerCount[0]?.n ?? 0),
      unbalanced_pairs: Number(unbalancedRows[0]?.n ?? 0),
    },
    orders: Object.fromEntries(stateCounts.map((r) => [r.state, Number(r.n)])),
    payouts: {
      pending: Number(pendingPayouts[0]?.n ?? 0),
      failed: Number(failedPayouts[0]?.n ?? 0),
    },
    agents: Number(agentCount[0]?.n ?? 0),
    quotes: Number(quoteCount[0]?.n ?? 0),
    invoices: Number(invoiceCount[0]?.n ?? 0),
    reviews: Number(reviewCount[0]?.n ?? 0),
    disputes: Number(disputeCount[0]?.n ?? 0),
  });
});
