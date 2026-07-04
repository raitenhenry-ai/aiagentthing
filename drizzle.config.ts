import { defineConfig } from 'drizzle-kit';

// Migrations run against the DIRECT (unpooled) connection when available —
// Neon's "-pooler" endpoint uses transaction-mode PgBouncer, which DDL
// tooling should bypass. Runtime traffic uses DATABASE_URL.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL_UNPOOLED ??
      process.env.DATABASE_URL ??
      'postgres://localhost:5432/clearing',
  },
});
