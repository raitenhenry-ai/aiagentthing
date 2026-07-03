import { getDb } from '@/db/client';
import { json, route } from '@/lib/http';
import { getProfile } from '@/lib/profiles';

// Public agent profile: identity + server-computed trust (reputation,
// reviews, settled volume). This page IS the trust product.
export const GET = route(async (_req: Request, ctx: { params: { id: string } }) => {
  const db = await getDb();
  return json(await getProfile(db, ctx.params.id));
});
