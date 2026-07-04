import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

// Common database type covering every driver (Neon serverless over
// WebSockets, postgres-js over TCP, embedded PGlite for dev/test). All
// domain code takes a `Db` (or `Tx` inside transactions) so it is
// driver-agnostic and unit-testable.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Next.js dev compiles routes into separate bundles that each evaluate this
// module — pin the singleton on globalThis so every bundle shares one client
// (PGlite is single-connection; two copies would fight over the data dir).
const globalStore = globalThis as { __clearingDb?: Promise<Db> };

function isNeonUrl(url: string): boolean {
  return /neon\.tech|neon\.build/.test(url);
}

async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const driver = process.env.DATABASE_DRIVER ?? (isNeonUrl(url) ? 'neon' : 'postgres');
    if (driver === 'neon') {
      // Neon serverless driver: pooled WebSocket connections, full
      // interactive-transaction support (required by the ledger/state
      // machine), works in Node and edge runtimes alike.
      const { Pool, neonConfig } = await import('@neondatabase/serverless');
      const { drizzle } = await import('drizzle-orm/neon-serverless');
      const { migrate } = await import('drizzle-orm/neon-serverless/migrator');
      // Node has no global WebSocket in all supported versions — wire in ws.
      if (typeof WebSocket === 'undefined') {
        const ws = (await import('ws')).default;
        neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket;
      }
      const pool = new Pool({
        connectionString: url,
        max: Number.parseInt(process.env.DB_POOL_MAX ?? '5', 10),
      });
      const db = drizzle(pool, { schema });
      await migrate(db, { migrationsFolder: 'drizzle' });
      return db as unknown as Db;
    }
    // Plain Postgres over TCP (also works with Neon's pooled endpoint).
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const postgres = (await import('postgres')).default;
    // PgBouncer transaction pooling (Neon "-pooler" endpoints, Supabase
    // pooler) cannot serve prepared statements — disable them there.
    const pooled = /-pooler\.|pgbouncer=true/.test(url);
    const client = postgres(url, {
      max: Number.parseInt(process.env.DB_POOL_MAX ?? '10', 10),
      prepare: pooled ? false : true,
    });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: 'drizzle' });
    return db as unknown as Db;
  }
  // Zero-config fallback: embedded Postgres (PGlite). In-memory when
  // PGLITE_MEMORY=1 (tests), otherwise persisted under .data/.
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  let client;
  if (process.env.PGLITE_MEMORY === '1') {
    client = new PGlite();
  } else {
    const { mkdirSync } = await import('node:fs');
    mkdirSync('.data/pglite', { recursive: true });
    client = new PGlite('.data/pglite');
  }
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: 'drizzle' });
  return db as unknown as Db;
}

export function getDb(): Promise<Db> {
  if (!globalStore.__clearingDb) globalStore.__clearingDb = createDb();
  return globalStore.__clearingDb;
}

/** Test helper: fresh, isolated in-memory database with migrations applied. */
export async function createTestDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: 'drizzle' });
  return db as unknown as Db;
}
