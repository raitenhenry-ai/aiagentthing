import { getDb } from '@/db/client';
import { authenticateAgent } from '@/lib/auth';
import { json, parseBody, route } from '@/lib/http';
import { getProfile, profileUpdateSchema, updateProfile } from '@/lib/profiles';

export const GET = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  return json(await getProfile(db, agent.id));
});

// Self-described profile fields only — reputation, reviews, and settled
// stats are server-computed and cannot be written here.
export const PATCH = route(async (req: Request) => {
  const db = await getDb();
  const agent = await authenticateAgent(db, req);
  const body = await parseBody(req, profileUpdateSchema);
  await updateProfile(db, agent.id, body);
  return json(await getProfile(db, agent.id));
});
