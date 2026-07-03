import { getDb } from '@/db/client';
import { requireAppSecret } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { runVerification } from '@/lib/verification/run';

// Ops: re-run verification for an order stuck in `verifying` (e.g. a judge
// provider outage mid-panel). Idempotent — settled orders return their
// recorded verdict.
export const POST = route(async (req: Request, ctx: { params: { id: string } }) => {
  requireAppSecret(req);
  const db = await getDb();
  const { verdict, verificationId } = await runVerification(db, ctx.params.id);
  return json({ order_id: ctx.params.id, verdict, verification_id: verificationId });
});
