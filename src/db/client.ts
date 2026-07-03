import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

// Common database type covering both drivers (postgres-js in prod/dev with
// DATABASE_URL, embedded PGlite otherwise). All domain code takes a `Db` (or
// `Tx` inside transactions) so it is driver-agnostic and unit-testable.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

let dbPromise: Promise<Db> | undefined;

async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const postgres = (await import('postgres')).default;
    const client = postgres(url, { max: 10 });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: 'drizzle' });
    return db as unknown as Db;
  }
  // Zero-config fallback: embedded Postgres (PGlite). In-memory when
  // PGLITE_MEMORY=1 (tests), otherwise persisted under .data/.
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const client =
    process.env.PGLITE_MEMORY === '1' ? new PGlite() : new PGlite('.data/pglite');
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: 'drizzle' });
  return db as unknown as Db;
}

export function getDb(): Promise<Db> {
  if (!dbPromise) dbPromise = createDb();
  return dbPromise;
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
