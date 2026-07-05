import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { orders, payouts } from '@/db/schema';
import { ledgerSum } from '@/lib/ledger';
import { createOrderQuote, payForOrder, submitDelivery } from '@/lib/orders';
import { getMockRail } from '@/lib/payments';
import { authorizationFor, buyerDeliverableVisible } from '@/lib/payments/authorizations';
import { MockRail } from '@/lib/payments/mock-rail';
import { processPayoutsForOrder } from '@/lib/payments/payouts';
import { transitionOrder } from '@/lib/state-machine';
import { createTestDb, fundWallet, makeAgent, makeListing, type TestAgent } from './helpers';

// Non-custodial (authorization) escrow: the platform never holds funds. Pay
// = verify + hold the signed authorization; PASS executes it buyer→seller;
// FAIL/refund discards it. Buyers can't scam sellers: the deliverable stays
// locked until the payment actually executes.

let db: Db;
let seller: TestAgent;
let buyer: TestAgent;
let listingId: string;

beforeEach(async () => {
  process.env.ESCROW_MODE = 'authorization';
  db = await createTestDb();
  seller = await makeAgent(db, 'seller');
  buyer = await makeAgent(db, 'buyer');
  listingId = await makeListing(db, seller.id, { priceCredits: 1000n });
});

afterEach(() => {
  delete process.env.ESCROW_MODE;
});

async function authorize(): Promise<string> {
  const quote = await createOrderQuote(db, { buyerAgentId: buyer.id, listingId, inputPayload: {} });
  // Requirements name the SELLER as recipient — funds never touch the platform.
  expect(quote.requirements.payTo).toBe(seller.wallet.toLowerCase());
  fundWallet(buyer.wallet, quote.priceCredits);
  const paid = await payForOrder(db, {
    orderId: quote.orderId,
    buyerAgentId: buyer.id,
    buyerWallet: buyer.wallet,
    paymentHeader: MockRail.paymentHeader(buyer.wallet),
  });
  expect(paid.state).toBe('escrowed');
  return quote.orderId;
}

describe('non-custodial escrow (authorization mode)', () => {
  it('paying holds the authorization WITHOUT moving any funds', async () => {
    const orderId = await authorize();
    // Buyer still has every cent; seller and platform got nothing.
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(1000n);
    expect(getMockRail().balanceOf(seller.wallet)).toBe(0n);
    const auth = await authorizationFor(db, orderId);
    expect(auth?.status).toBe('held');
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('PASS executes the authorization straight buyer→seller and unlocks the deliverable', async () => {
    const orderId = await authorize();
    const { verdict } = await submitDelivery(db, {
      orderId,
      sellerAgentId: seller.id,
      artifacts: [{ inline: { summary: 'done' } }],
      receipts: [{ step: 'work' }],
    });
    expect(verdict).toBe('PASS');

    const row = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
    expect(row.state).toBe('settled_released');
    // Money moved directly: buyer -1000, seller +1000, platform untouched.
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(0n);
    expect(getMockRail().balanceOf(seller.wallet)).toBe(1000n);
    const auth = await authorizationFor(db, orderId);
    expect(auth?.status).toBe('executed');
    expect(auth?.txHash).toMatch(/^0xmock/);
    // Paid → buyer may see the results.
    expect(buyerDeliverableVisible(row, auth)).toBe(true);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('a buyer who drains their wallet gets NOTHING: payment fails, deliverable stays locked', async () => {
    const orderId = await authorize();
    // Buyer moves their money away before delivery settles (the scam).
    getMockRail().fund; // (no-op reference)
    // simulate drain: pay someone else with the full balance
    const drainHeader = MockRail.paymentHeader(buyer.wallet);
    await getMockRail().settleInbound(drainHeader, await (async () => {
      const { getRail } = await import('@/lib/payments');
      return getRail().buildRequirements({ amountCredits: 1000n, resource: '/drain', description: 'drain', payTo: '0x000000000000000000000000000000000000dead' });
    })());
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(0n);

    const { verdict } = await submitDelivery(db, {
      orderId,
      sellerAgentId: seller.id,
      artifacts: [{ inline: { summary: 'done' } }],
      receipts: [],
    });
    expect(verdict).toBe('PASS');

    const row = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
    expect(row.state).toBe('settled_released');
    // Execution failed — authorization still held, payout pending with error.
    const auth = await authorizationFor(db, orderId);
    expect(auth?.status).toBe('held');
    const payoutRows = await db.select().from(payouts).where(eq(payouts.orderId, orderId));
    expect(payoutRows[0]?.status).toBe('pending');
    expect(payoutRows[0]?.lastError).toMatch(/cannot cover|insufficient/i);
    // Seller got nothing — but the buyer sees NOTHING either. No free work.
    expect(getMockRail().balanceOf(seller.wallet)).toBe(0n);
    expect(buyerDeliverableVisible(row, auth)).toBe(false);

    // Buyer refunds their wallet (e.g. wants the results after all) → retry
    // executes and everything unlocks.
    fundWallet(buyer.wallet, 1000n);
    await processPayoutsForOrder(db, orderId);
    const auth2 = await authorizationFor(db, orderId);
    expect(auth2?.status).toBe('executed');
    expect(getMockRail().balanceOf(seller.wallet)).toBe(1000n);
    expect(buyerDeliverableVisible(row, auth2)).toBe(true);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('FAIL → the buyer may see results (no payment), and refund just discards the authorization', async () => {
    const orderId = await authorize();
    await db.transaction((tx) =>
      transitionOrder(tx, { orderId, to: 'delivered', actor: 'seller', agentId: seller.id }),
    );
    const { deliveries } = await import('@/db/schema');
    const { newId } = await import('@/lib/ids');
    await db.insert(deliveries).values({ id: newId('dlv'), orderId, artifacts: [{ inline: 'bad' }], receipts: [] });
    const { runVerification } = await import('@/lib/verification/run');
    const { StubJudge } = await import('@/lib/verification/stub-judge');
    const { verdict } = await runVerification(db, orderId, [new StubJudge({ verdict: 'FAIL' })]);
    expect(verdict).toBe('FAIL');

    let row = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
    // FAILed: buyer may inspect the (rejected) work without paying.
    expect(buyerDeliverableVisible(row, await authorizationFor(db, orderId))).toBe(true);

    // Window lapses → refund = discard; the buyer's money never moved.
    const far = new Date(Date.now() + 90 * 24 * 3600 * 1000);
    await transitionOrder(db, { orderId, to: 'settled_refund', actor: 'system', now: far });
    row = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
    expect(row.state).toBe('settled_refund');
    const auth = await authorizationFor(db, orderId);
    expect(auth?.status).toBe('discarded');
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(1000n); // never left
    expect(getMockRail().balanceOf(seller.wallet)).toBe(0n);
    // No refund payout needed — nothing was held.
    const payoutRows = await db.select().from(payouts).where(eq(payouts.orderId, orderId));
    expect(payoutRows).toHaveLength(0);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('the same signed payment can never authorize two different orders', async () => {
    const header = MockRail.paymentHeader(buyer.wallet);
    fundWallet(buyer.wallet, 2000n);
    const q1 = await createOrderQuote(db, { buyerAgentId: buyer.id, listingId, inputPayload: {} });
    const q2 = await createOrderQuote(db, { buyerAgentId: buyer.id, listingId, inputPayload: {} });
    await payForOrder(db, { orderId: q1.orderId, buyerAgentId: buyer.id, buyerWallet: buyer.wallet, paymentHeader: header });
    await expect(
      payForOrder(db, { orderId: q2.orderId, buyerAgentId: buyer.id, buyerWallet: buyer.wallet, paymentHeader: header }),
    ).rejects.toThrow(/already used/);
  });

  it('seller decline discards the authorization; buyer keeps their money', async () => {
    const orderId = await authorize();
    await transitionOrder(db, { orderId, to: 'settled_refund', actor: 'seller', agentId: seller.id });
    const auth = await authorizationFor(db, orderId);
    expect(auth?.status).toBe('discarded');
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(1000n);
    expect(await ledgerSum(db)).toBe(0n);
  });
});
