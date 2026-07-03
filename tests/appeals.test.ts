import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { disputes, orders, verifications } from '@/db/schema';
import { appealDepositFor, openAppeal, resolveAppeal } from '@/lib/appeals';
import { ledgerSum } from '@/lib/ledger';
import { getMockRail } from '@/lib/payments';
import { transitionOrder } from '@/lib/state-machine';
import { StubJudge } from '@/lib/verification/stub-judge';
import { runVerification } from '@/lib/verification/run';
import {
  createTestDb,
  fund,
  makeAgent,
  makeEscrowedOrder,
  makeListing,
  type TestAgent,
} from './helpers';

let db: Db;
let buyer: TestAgent;
let seller: TestAgent;
let listingId: string;

const FAIL_PANEL = [new StubJudge({ verdict: 'FAIL' })];
const PASS_PANEL_5 = Array.from({ length: 5 }, (_, i) => new StubJudge({ model: `s${i}` }));
const FAIL_PANEL_5 = Array.from(
  { length: 5 },
  (_, i) => new StubJudge({ model: `s${i}`, verdict: 'FAIL' }),
);

beforeEach(async () => {
  db = await createTestDb();
  buyer = await makeAgent(db, 'buyer');
  seller = await makeAgent(db, 'seller');
  listingId = await makeListing(db, seller.id, { priceCredits: 1000n });
});

async function failedOrderViaPanel(): Promise<string> {
  const orderId = await makeEscrowedOrder(db, buyer, listingId);
  await transitionOrder(db, { orderId, to: 'delivered', actor: 'seller', agentId: seller.id });
  const { deliveries } = await import('@/db/schema');
  const { newId } = await import('@/lib/ids');
  await db.insert(deliveries).values({
    id: newId('dlv'),
    orderId,
    artifacts: [{ inline: { summary: 'disputed work' } }],
    receipts: [],
  });
  await runVerification(db, orderId, FAIL_PANEL);
  return orderId;
}

describe('appeals (appeal ≠ veto)', () => {
  it('appeal requires evidence', async () => {
    const orderId = await failedOrderViaPanel();
    await fund(db, seller.id, 50n);
    await expect(
      openAppeal(db, { orderId, sellerAgentId: seller.id, evidence: {} }),
    ).rejects.toThrow(/evidence/i);
  });

  it('winning an appeal releases funds and returns the deposit', async () => {
    const orderId = await failedOrderViaPanel();
    await fund(db, seller.id, 50n); // deposit as credits (x402 inbound at route level)
    await openAppeal(db, {
      orderId,
      sellerAgentId: seller.id,
      evidence: { receipts: ['proof'] },
    });
    const { verdict } = await resolveAppeal(db, orderId, PASS_PANEL_5);
    expect(verdict).toBe('PASS');
    // 900 net release + 50 deposit back, on-chain.
    expect(getMockRail().balanceOf(seller.wallet)).toBe(950n);
    const disputeRow = (await db.select().from(disputes).where(eq(disputes.orderId, orderId)))[0]!;
    expect(disputeRow.state).toBe('resolved');
    expect((disputeRow.resolution as { verdict: string }).verdict).toBe('PASS');
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('losing an appeal refunds the buyer and forfeits the deposit — final, no second appeal', async () => {
    const orderId = await failedOrderViaPanel();
    await fund(db, seller.id, 50n);
    await openAppeal(db, { orderId, sellerAgentId: seller.id, evidence: { note: 'but…' } });
    const { verdict } = await resolveAppeal(db, orderId, FAIL_PANEL_5);
    expect(verdict).toBe('FAIL');
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(1000n);
    expect(getMockRail().balanceOf(seller.wallet)).toBe(0n);
    // Final: the order is settled; nothing further can happen.
    await expect(
      openAppeal(db, { orderId, sellerAgentId: seller.id, evidence: { again: true } }),
    ).rejects.toThrow();
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('appeal verification is recorded at dispute tier with a 5-judge panel', async () => {
    const orderId = await failedOrderViaPanel();
    await fund(db, seller.id, 50n);
    await openAppeal(db, { orderId, sellerAgentId: seller.id, evidence: { r: 1 } });
    await resolveAppeal(db, orderId, PASS_PANEL_5);
    const vRows = await db
      .select()
      .from(verifications)
      .where(eq(verifications.orderId, orderId));
    const disputeTier = vRows.find((v) => v.tier === 'dispute');
    expect(disputeTier).toBeDefined();
    const record = disputeTier!.judgeVerdicts as { runs: unknown[][] };
    expect(record.runs[record.runs.length - 1]).toHaveLength(5);
  });

  it('panel-tier verdicts are appealable at no fee', async () => {
    const orderId = await makeEscrowedOrder(db, buyer, listingId);
    await transitionOrder(db, { orderId, to: 'delivered', actor: 'seller', agentId: seller.id });
    const { deliveries } = await import('@/db/schema');
    const { newId } = await import('@/lib/ids');
    await db.insert(deliveries).values({
      id: newId('dlv'),
      orderId,
      artifacts: [{ inline: { summary: 'split decision work' } }],
      receipts: [],
    });
    // 2-1 FAIL split → panel tier.
    await runVerification(db, orderId, [
      new StubJudge({ model: 'a', verdict: 'FAIL' }),
      new StubJudge({ model: 'b', verdict: 'FAIL' }),
      new StubJudge({ model: 'c', verdict: 'PASS' }),
    ]);
    const vRow = (await db.select().from(verifications).where(eq(verifications.orderId, orderId)))[0]!;
    expect(vRow.tier).toBe('panel');

    const deposit = await appealDepositFor(db, orderId);
    expect(deposit).toEqual({ amountCredits: 0n, freeAppeal: true });
    // Seller has zero credits and zero wallet — the appeal still opens.
    await openAppeal(db, { orderId, sellerAgentId: seller.id, evidence: { split: true } });
    const row = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
    expect(row.state).toBe('appealed');
  });

  it('buyer can still override during an appeal (forgiveness beats arbitration)', async () => {
    const orderId = await failedOrderViaPanel();
    await fund(db, seller.id, 50n);
    await openAppeal(db, { orderId, sellerAgentId: seller.id, evidence: { r: 1 } });
    await transitionOrder(db, {
      orderId,
      to: 'settled_override',
      actor: 'buyer',
      agentId: buyer.id,
    });
    // Seller gets net + deposit back; buyer paid despite the FAIL.
    expect(getMockRail().balanceOf(seller.wallet)).toBe(950n);
  });
});
