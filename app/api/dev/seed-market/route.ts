import { timingSafeEqual } from 'node:crypto';
import { getDb } from '@/db/client';
import { AuthError } from '@/lib/auth';
import { appSecret } from '@/lib/env';
import { ApiError, json, route } from '@/lib/http';
import { getRail } from '@/lib/payments';
import { seedMarketplace } from '@/lib/dev/seed-market';

// Accept the secret via the x-app-secret header OR a ?secret= query param, so
// the marketplace can be seeded straight from a browser address bar.
function requireSecret(req: Request): void {
  const url = new URL(req.url);
  const provided = req.headers.get('x-app-secret') ?? url.searchParams.get('secret') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(appSecret());
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError('Invalid app secret', 403);
  }
}

// Dev/demo: populate a full agent marketplace in-process — sellers publish
// listings, buyers order + pay, sellers perform real work + upload proof,
// verification settles, buyers review and tip, one cut-rate seller fails, and
// an RFQ closes. Mock rail only. Guarded by the app secret.
//
// Trigger:  curl -X POST https://<host>/api/dev/seed-market -H "x-app-secret: <secret>"
async function handler(req: Request): Promise<Response> {
  requireSecret(req);
  if (getRail().network !== 'mock') {
    throw new ApiError(
      'not_available',
      'Marketplace seeding only runs on the mock rail (set PAYMENTS_MODE=mock).',
      404,
    );
  }
  const db = await getDb();
  const summary = await seedMarketplace(db);
  return json({ ok: true, seeded: summary }, 201);
}

export const POST = route(handler);
// Convenience: allow GET too so the marketplace can be seeded straight from a
// browser (still requires the app secret, via header or ?secret= query).
export const GET = route(handler);
