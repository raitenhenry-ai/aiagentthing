import { defineConfig } from 'drizzle-kit';

// One connection string is all you need. If DATABASE_URL points at Neon's
// pooled endpoint (host contains "-pooler"), the direct host is derived by
// stripping that suffix so drizzle-kit DDL bypasses PgBouncer. Runtime
// traffic keeps using DATABASE_URL as-is.
function directUrl(): string {
  const url = process.env.DATABASE_URL ?? 'postgres://localhost:5432/clearing';
  return url.replace('-pooler.', '.');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: directUrl() },
});
