import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { deliveries, listingVersions, orders, verifications } from '@/db/schema';
import { acceptanceCriteriaSchema } from '../criteria';
import { newId } from '../ids';
import { transitionOrder } from '../state-machine';
import { aggregateVerdicts, type Judge } from './judge';
import { StubJudge } from './stub-judge';

/** The active panel. Phase 1: a single always-PASS stub. Phase 2: 3 judges. */
export function defaultPanel(): Judge[] {
  return [new StubJudge()];
}

/**
 * Run verification for a delivered order: delivered → verifying → judge
 * panel → passed/failed, and on pass straight through to settlement.
 *
 * Phase 1 runs this synchronously in the delivery request; Phase 2 moves it
 * onto Inngest with the same entry point.
 */
export async function runVerification(
  db: Db,
  orderId: string,
  panel: Judge[] = defaultPanel(),
): Promise<{ verdict: 'PASS' | 'FAIL'; verificationId: string }> {
  await transitionOrder(db, { orderId, to: 'verifying', actor: 'system' });

  const orderRows = await db
    .select({
      id: orders.id,
      listingId: orders.listingId,
      listingVersion: orders.listingVersion,
      inputPayload: orders.inputPayload,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  const order = orderRows[0];
  if (!order) throw new Error(`Order ${orderId} not found`);

  const versionRows = await db
    .select({ acceptanceCriteria: listingVersions.acceptanceCriteria })
    .from(listingVersions)
    .where(
      and(
        eq(listingVersions.listingId, order.listingId),
        eq(listingVersions.version, order.listingVersion),
      ),
    );
  const version = versionRows[0];
  if (!version) {
    throw new Error(`Listing version ${order.listingId}@${order.listingVersion} not found`);
  }
  const criteria = acceptanceCriteriaSchema.parse(version.acceptanceCriteria);

  const deliveryRows = await db
    .select({ artifacts: deliveries.artifacts, receipts: deliveries.receipts })
    .from(deliveries)
    .where(eq(deliveries.orderId, orderId))
    .orderBy(desc(deliveries.submittedAt))
    .limit(1);
  const delivery = deliveryRows[0];
  if (!delivery) throw new Error(`No delivery found for order ${orderId}`);

  // Judges are independent: same inputs, no seller identity, no reputation,
  // no sight of each other's verdicts.
  const verdicts = await Promise.all(
    panel.map((judge) =>
      judge.evaluate({
        criteria,
        inputPayload: order.inputPayload,
        artifacts: delivery.artifacts,
        receipts: delivery.receipts,
      }),
    ),
  );
  const aggregate = aggregateVerdicts(verdicts);

  const verificationId = newId('vrf');
  await db.insert(verifications).values({
    id: verificationId,
    orderId,
    judgeVerdicts: aggregate.verdicts,
    aggregateVerdict: aggregate.verdict,
    aggregateConfidence: aggregate.confidence,
    tier: aggregate.tier,
  });

  if (aggregate.verdict === 'PASS') {
    await transitionOrder(db, { orderId, to: 'passed', actor: 'panel' });
    await transitionOrder(db, { orderId, to: 'settled_released', actor: 'system' });
  } else {
    await transitionOrder(db, { orderId, to: 'failed', actor: 'panel' });
  }
  return { verdict: aggregate.verdict, verificationId };
}
