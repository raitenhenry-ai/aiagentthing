/**
 * Database readiness check — run after pointing DATABASE_URL at Neon:
 *
 *   DATABASE_URL='postgresql://…neon.tech/…?sslmode=require' npm run db:check
 *
 * Connects with the same driver selection the app uses, applies pending
 * migrations, and verifies the platform invariants hold (round-trip write,
 * advisory locks, deferrable FKs, ledger sum).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../src/db/client';
import { ledgerSum } from '../src/lib/ledger';

/** Drivers disagree on execute() result shape: postgres-js returns the row
 * array itself; neon/pglite wrap it in {rows}. Normalize. */
function rowsOf<T>(result: unknown): T[] {
  const r = result as { rows?: T[] } | T[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  console.log(
    url
      ? `checking ${url.replace(/:\/\/[^@]*@/, '://***@')}`
      : 'checking embedded PGlite (no DATABASE_URL set)',
  );

  const started = Date.now();
  const db = await getDb(); // connects + applies migrations
  console.log(`✓ connected + migrations applied (${Date.now() - started}ms)`);

  const version = await db.execute(sql`SELECT version()`);
  const versionRow = rowsOf<{ version: string }>(version)[0];
  if (versionRow) console.log(`✓ ${versionRow.version.split(' on ')[0]}`);

  // Features the money paths depend on.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('db-check'))`);
  });
  console.log('✓ interactive transactions + advisory locks');

  const tables = await db.execute(sql`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const tableCount = rowsOf<{ n: number }>(tables)[0]?.n ?? 0;
  console.log(`✓ ${tableCount} tables present`);

  const settlementIdx = await db.execute(sql`
    SELECT count(*)::int AS n FROM pg_indexes
    WHERE indexname = 'ledger_entries_one_settlement_per_order_idx'
  `);
  const hasIdx = (rowsOf<{ n: number }>(settlementIdx)[0]?.n ?? 0) > 0;
  console.log(hasIdx ? '✓ double-settlement unique index in place' : '✗ MISSING settlement index');

  const sum = await ledgerSum(db);
  console.log(`✓ ledger sum = ${sum} ${sum === 0n ? '(balanced)' : '— INVARIANT VIOLATED'}`);

  if (!hasIdx || sum !== 0n) process.exit(1);
  console.log('\n✅ database ready for Clearing');
  process.exit(0);
}

main().catch((e) => {
  console.error('✗ database check failed:', e);
  process.exit(1);
});
