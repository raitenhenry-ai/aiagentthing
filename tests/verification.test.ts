import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { deliveries, orders, verifications } from '@/db/schema';
import { newId } from '@/lib/ids';
import { agentAccount, getBalance } from '@/lib/ledger';
import { createOrder, submitDelivery } from '@/lib/orders';
import { transitionOrder } from '@/lib/state-machine';
import { aggregateVerdicts } from '@/lib/verification/judge';
import { runVerification } from '@/lib/verification/run';
import { StubJudge } from '@/lib/verification/stub-judge';
import { createTestDb, fund, makeAgent, makeListing, type TestAgent } from './helpers';

let db: Db;
let buyer: TestAgent;
let seller: TestAgent;
let listingId: string;

beforeEach(async () => {
  db = await createTestDb();
  buyer = await makeAgent(db, 'buyer');
  seller = await makeAgent(db, 'seller');
  listingId = await makeListing(db, seller.id, { priceCredits: 1000n });
  await fund(db, buyer.id, 5000n);
});

describe('verification pipeline', () => {
  it('stub judge PASS settles the order and pays the seller', async () => {
    const { orderId } = await createOrder(db, { buyerAgentId: buyer.id, listingId, inputPayload: {} });
    const { verdict } = await submitDelivery(db, {
      orderId,
      sellerAgentId: seller.id,
      artifacts: [{ inline: { summary: 'result' } }],
      receipts: [{ step: 'did the work' }],
    });
    expect(verdict).toBe('PASS');
    const row = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
    expect(row.state).toBe('settled_released');
    expect(await getBalance(db, agentAccount(seller.id))).toBe(900n);

    const vRows = await db.select().from(verifications).where(eq(verifications.orderId, orderId));
    expect(vRows).toHaveLength(1);
    expect(vRows[0]!.aggregateVerdict).toBe('PASS');
    expect(vRows[0]!.tier).toBe('auto');
  });

  it('FAIL panel leaves order in failed with the override window open, funds still held', async () => {
    const { orderId } = await createOrder(db, { buyerAgentId: buyer.id, listingId, inputPayload: {} });
    await db.transaction((tx) =>
      transitionOrder(tx, { orderId, to: 'delivered', actor: 'seller', agentId: seller.id }),
    );
    await db.insert(deliveries).values({
      id: newId('dlv'),
      orderId,
      artifacts: [{ inline: 'bad work' }],
      receipts: [],
    });
    const { verdict } = await runVerification(db, orderId, [new StubJudge({ verdict: 'FAIL' })]);
    expect(verdict).toBe('FAIL');
    const row = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
    expect(row.state).toBe('failed');
    expect(row.failWindowEndsAt).not.toBeNull();
    expect(await getBalance(db, agentAccount(seller.id))).toBe(0n);
    expect(await getBalance(db, agentAccount(buyer.id))).toBe(4000n);
  });

  it('verdicts store hashed reasoning only', async () => {
    const { orderId } = await createOrder(db, { buyerAgentId: buyer.id, listingId, inputPayload: {} });
    await submitDelivery(db, {
      orderId,
      sellerAgentId: seller.id,
      artifacts: [{ inline: { summary: 'x' } }],
      receipts: [],
    });
    const vRows = await db.select().from(verifications).where(eq(verifications.orderId, orderId));
    const record = vRows[0]!.judgeVerdicts as { runs: Array<Array<Record<string, unknown>>> };
    const verdicts = record.runs.flat();
    expect(verdicts.length).toBeGreaterThan(0);
    for (const v of verdicts) {
      expect(v.reasoningHash).toMatch(/^[a-f0-9]{64}$/);
      expect(v).not.toHaveProperty('reasoning');
    }
  });
});

describe('panel aggregation', () => {
  const verdict = (v: 'PASS' | 'FAIL', confidence: number) => ({
    judgeModel: 'j',
    verdict: v,
    confidence,
    criteriaResults: [],
    reasoningHash: 'x'.repeat(64),
  });

  it('unanimous high-confidence → auto tier', () => {
    const agg = aggregateVerdicts([verdict('PASS', 0.95), verdict('PASS', 0.9), verdict('PASS', 0.85)]);
    expect(agg).toMatchObject({ verdict: 'PASS', tier: 'auto' });
  });

  it('2-1 split → majority stands, panel tier (appealable, not FAIL-cautious)', () => {
    const agg = aggregateVerdicts([verdict('PASS', 0.9), verdict('PASS', 0.9), verdict('FAIL', 0.9)]);
    expect(agg).toMatchObject({ verdict: 'PASS', tier: 'panel' });
  });

  it('unanimous but low confidence → panel tier', () => {
    const agg = aggregateVerdicts([verdict('FAIL', 0.6), verdict('FAIL', 0.7), verdict('FAIL', 0.65)]);
    expect(agg).toMatchObject({ verdict: 'FAIL', tier: 'panel' });
  });
});
