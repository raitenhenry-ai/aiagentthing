import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { ledgerEntries, orders, payouts } from '@/db/schema';
import { ledgerSum } from '@/lib/ledger';
import { createOrderQuote, payForOrder, submitDelivery } from '@/lib/orders';
import { getMockRail } from '@/lib/payments';
import { MockRail } from '@/lib/payments/mock-rail';
import { transitionOrder } from '@/lib/state-machine';
import {
  createTestDb,
  fundWallet,
  makeAgent,
  makeEscrowedOrder,
  makeListing,
  type TestAgent,
} from './helpers';

let db: Db;
let buyer: TestAgent;
let seller: TestAgent;
let listingId: string;

beforeEach(async () => {
  db = await createTestDb();
  buyer = await makeAgent(db, 'buyer');
  seller = await makeAgent(db, 'seller');
  listingId = await makeListing(db, seller.id, { priceCredits: 1000n });
});

describe('x402 payment flow (spec E2E)', () => {
  it('pay 402 → escrow → delivery → PASS → seller wallet += amount−fee, ledger sums to zero', async () => {
    const quote = await createOrderQuote(db, {
      buyerAgentId: buyer.id,
      listingId,
      inputPayload: { doc: 'x' },
    });
    fundWallet(buyer.wallet, 1000n);
    const sellerBefore = getMockRail().balanceOf(seller.wallet);

    const paid = await payForOrder(db, {
      orderId: quote.orderId,
      buyerAgentId: buyer.id,
      buyerWallet: buyer.wallet,
      paymentHeader: MockRail.paymentHeader(buyer.wallet),
    });
    expect(paid.state).toBe('escrowed');
    expect(paid.txHash).toMatch(/^0xmock/);

    const { verdict } = await submitDelivery(db, {
      orderId: quote.orderId,
      sellerAgentId: seller.id,
      artifacts: [{ inline: { summary: 'done' } }],
      receipts: [{ step: 'work' }],
    });
    expect(verdict).toBe('PASS');

    expect(getMockRail().balanceOf(seller.wallet) - sellerBefore).toBe(900n);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('no settlement without confirmed inbound payment: an unpaid order cannot move', async () => {
    const quote = await createOrderQuote(db, {
      buyerAgentId: buyer.id,
      listingId,
      inputPayload: {},
    });
    // The only transition out of `created` is system escrow, which happens
    // exclusively inside payForOrder after facilitator settlement. Delivery,
    // verification, and settlement are all unreachable.
    await expect(
      transitionOrder(db, {
        orderId: quote.orderId,
        to: 'delivered',
        actor: 'seller',
        agentId: seller.id,
      }),
    ).rejects.toThrow(/No transition/);
    await expect(
      transitionOrder(db, { orderId: quote.orderId, to: 'settled_refund', actor: 'system' }),
    ).rejects.toThrow(/No transition/);
    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orderId, quote.orderId));
    expect(entries).toEqual([]); // zero ledger rows before payment
  });

  it('a replayed X-PAYMENT payload is rejected', async () => {
    fundWallet(buyer.wallet, 2000n);
    const header = MockRail.paymentHeader(buyer.wallet);
    const q1 = await createOrderQuote(db, { buyerAgentId: buyer.id, listingId, inputPayload: {} });
    await payForOrder(db, {
      orderId: q1.orderId,
      buyerAgentId: buyer.id,
      buyerWallet: buyer.wallet,
      paymentHeader: header,
    });
    const q2 = await createOrderQuote(db, { buyerAgentId: buyer.id, listingId, inputPayload: {} });
    await expect(
      payForOrder(db, {
        orderId: q2.orderId,
        buyerAgentId: buyer.id,
        buyerWallet: buyer.wallet,
        paymentHeader: header,
      }),
    ).rejects.toThrow(/already used|already settled/);
  });

  it('a payment naming a different wallet is rejected WITHOUT touching that wallet', async () => {
    // The attack: an authenticated agent names a victim's wallet as the payer
    // to drain it. The rail must reject before any funds move — the victim's
    // balance is unchanged and nothing lands in the platform wallet.
    const victim = await makeAgent(db, 'victim');
    fundWallet(victim.wallet, 1000n);
    const platformWallet = '0xp1a7f0rm000000000000000000000000000000000';
    const victimBefore = getMockRail().balanceOf(victim.wallet);
    const platformBefore = getMockRail().balanceOf(platformWallet);

    const quote = await createOrderQuote(db, { buyerAgentId: buyer.id, listingId, inputPayload: {} });
    await expect(
      payForOrder(db, {
        orderId: quote.orderId,
        buyerAgentId: buyer.id,
        buyerWallet: buyer.wallet,
        paymentHeader: MockRail.paymentHeader(victim.wallet), // forged payer
      }),
    ).rejects.toThrow(/different wallet/);

    // No funds moved anywhere.
    expect(getMockRail().balanceOf(victim.wallet)).toBe(victimBefore);
    expect(getMockRail().balanceOf(platformWallet)).toBe(platformBefore);

    // And the same header (fresh nonce) can't be replayed to drain either —
    // a legitimate retry from the real buyer still works.
    fundWallet(buyer.wallet, 1000n);
    const paid = await payForOrder(db, {
      orderId: quote.orderId,
      buyerAgentId: buyer.id,
      buyerWallet: buyer.wallet,
      paymentHeader: MockRail.paymentHeader(buyer.wallet),
    });
    expect(paid.state).toBe('escrowed');
    expect(getMockRail().balanceOf(victim.wallet)).toBe(victimBefore); // still untouched
  });
});

describe('payout ↔ ledger invariants (spec)', () => {
  it('confirmed payouts exactly match the ledger settlement entries', async () => {
    const orderId = await makeEscrowedOrder(db, buyer, listingId);
    await transitionOrder(db, { orderId, to: 'delivered', actor: 'seller', agentId: seller.id });
    await transitionOrder(db, { orderId, to: 'verifying', actor: 'system' });
    await transitionOrder(db, { orderId, to: 'passed', actor: 'panel' });
    await transitionOrder(db, { orderId, to: 'settled_released', actor: 'system' });

    const payoutRows = await db.select().from(payouts).where(eq(payouts.orderId, orderId));
    expect(payoutRows).toHaveLength(1);
    expect(payoutRows[0]).toMatchObject({ status: 'confirmed', reason: 'release' });
    expect(payoutRows[0]!.txHash).toMatch(/^0xmock/);

    // The credited settlement amount equals the payout amount equals the
    // withdrawal ledger pair, and the withdrawal carries the payout tx hash.
    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orderId, orderId));
    const releaseCredit = entries.find(
      (e) => e.entryType === 'escrow_release' && e.amount > 0n,
    )!;
    // Reserve leg (agent -> pending, at settlement) and transfer leg
    // (pending -> external, tx-hashed at confirmation).
    const reserveDebit = entries.find(
      (e) => e.entryType === 'withdrawal' && e.amount < 0n && e.txHash === null,
    )!;
    const transferDebit = entries.find(
      (e) => e.entryType === 'withdrawal' && e.amount < 0n && e.txHash !== null,
    )!;
    expect(payoutRows[0]!.amountCredits).toBe(releaseCredit.amount);
    expect(-reserveDebit.amount).toBe(payoutRows[0]!.amountCredits);
    expect(-transferDebit.amount).toBe(payoutRows[0]!.amountCredits);
    expect(transferDebit.txHash).toBe(payoutRows[0]!.txHash);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('a failed payout retries without re-running settlement', async () => {
    const orderId = await makeEscrowedOrder(db, buyer, listingId);
    await transitionOrder(db, { orderId, to: 'delivered', actor: 'seller', agentId: seller.id });
    await transitionOrder(db, { orderId, to: 'verifying', actor: 'system' });
    await transitionOrder(db, { orderId, to: 'failed', actor: 'panel' });

    // Drain the mock platform wallet so the refund payout must fail.
    const rail = getMockRail();
    const drained = rail.balanceOf('0xp1a7f0rm000000000000000000000000000000000');
    // (simulate by paying out to a burn wallet via the private API surface)
    await rail.payout({
      to: '0xdead000000000000000000000000000000000000',
      amountCredits: drained,
      idempotencyKey: `drain-${orderId}`,
    });

    await transitionOrder(db, {
      orderId,
      to: 'settled_refund',
      actor: 'system',
      now: new Date(Date.now() + 49 * 3600 * 1000),
    });
    // Settlement committed even though the transfer failed.
    const orderRow = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
    expect(orderRow.state).toBe('settled_refund');
    const p1 = (await db.select().from(payouts).where(eq(payouts.orderId, orderId)))[0]!;
    expect(p1.status).toBe('pending');
    expect(p1.attempts).toBe(1);
    expect(p1.lastError).toMatch(/cannot cover/);

    // Refund the platform wallet and retry ONLY the transfer.
    rail.fund('0xp1a7f0rm000000000000000000000000000000000', drained);
    const { processPayoutsForOrder } = await import('@/lib/payments/payouts');
    const results = await processPayoutsForOrder(db, orderId);
    expect(results[0]).toMatchObject({ status: 'confirmed' });
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(1000n);

    // Exactly one settlement ever happened: one refund pair in the ledger.
    const refunds = await db
      .select()
      .from(ledgerEntries)
      .where(
        inArray(ledgerEntries.entryType, ['escrow_refund']),
      );
    expect(refunds.filter((e) => e.orderId === orderId && e.amount < 0n)).toHaveLength(1);
  });
});
