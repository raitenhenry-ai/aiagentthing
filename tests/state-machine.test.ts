import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { ledgerEntries, orders } from '@/db/schema';
import { agentAccount, getBalance, ledgerSum, PLATFORM_FEES } from '@/lib/ledger';
import { createOrderQuote, payForOrder } from '@/lib/orders';
import { getMockRail } from '@/lib/payments';
import { MockRail } from '@/lib/payments/mock-rail';
import {
  findTransition,
  isSettled,
  TRANSITIONS,
  TransitionError,
  transitionOrder,
  type Actor,
  type OrderState,
} from '@/lib/state-machine';
import {
  createTestDb,
  fund,
  fundWallet,
  makeAgent,
  makeEscrowedOrder,
  makeListing,
  type TestAgent,
} from './helpers';

const ALL_STATES: OrderState[] = [
  'created',
  'escrowed',
  'delivered',
  'verifying',
  'passed',
  'failed',
  'expired',
  'appealed',
  'settled_released',
  'settled_refund',
  'settled_override',
];
const ALL_ACTORS: Actor[] = ['buyer', 'seller', 'system', 'panel'];

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

async function newEscrowedOrder(): Promise<string> {
  return makeEscrowedOrder(db, buyer, listingId);
}

/** Drive an order into the given state through legal transitions only. */
async function driveTo(orderId: string, target: OrderState): Promise<void> {
  const paths: Record<OrderState, Array<{ to: OrderState; actor: Actor; agentId?: string }>> = {
    created: [],
    escrowed: [],
    delivered: [{ to: 'delivered', actor: 'seller', agentId: seller.id }],
    verifying: [
      { to: 'delivered', actor: 'seller', agentId: seller.id },
      { to: 'verifying', actor: 'system' },
    ],
    passed: [
      { to: 'delivered', actor: 'seller', agentId: seller.id },
      { to: 'verifying', actor: 'system' },
      { to: 'passed', actor: 'panel' },
    ],
    failed: [
      { to: 'delivered', actor: 'seller', agentId: seller.id },
      { to: 'verifying', actor: 'system' },
      { to: 'failed', actor: 'panel' },
    ],
    expired: [],
    appealed: [
      { to: 'delivered', actor: 'seller', agentId: seller.id },
      { to: 'verifying', actor: 'system' },
      { to: 'failed', actor: 'panel' },
      { to: 'appealed', actor: 'seller', agentId: seller.id },
    ],
    settled_released: [
      { to: 'delivered', actor: 'seller', agentId: seller.id },
      { to: 'verifying', actor: 'system' },
      { to: 'passed', actor: 'panel' },
      { to: 'settled_released', actor: 'system' },
    ],
    settled_refund: [
      { to: 'delivered', actor: 'seller', agentId: seller.id },
      { to: 'verifying', actor: 'system' },
      { to: 'failed', actor: 'panel' },
    ],
    settled_override: [
      { to: 'delivered', actor: 'seller', agentId: seller.id },
      { to: 'verifying', actor: 'system' },
      { to: 'failed', actor: 'panel' },
      { to: 'settled_override', actor: 'buyer', agentId: buyer.id },
    ],
  };
  for (const step of paths[target]) {
    await transitionOrder(db, { orderId, ...step });
  }
  if (target === 'settled_refund') {
    // lapse the window with a future clock
    await transitionOrder(db, {
      orderId,
      to: 'settled_refund',
      actor: 'system',
      now: new Date(Date.now() + 49 * 3600 * 1000),
    });
  }
}

async function orderState(orderId: string): Promise<OrderState> {
  const rows = await db.select({ state: orders.state }).from(orders).where(eq(orders.id, orderId));
  return rows[0]!.state;
}

describe('transition table shape (static invariants)', () => {
  it('no buyer-triggerable transition exists out of verifying or passed', () => {
    const buyerBlocking = TRANSITIONS.filter(
      (t) => (t.from === 'verifying' || t.from === 'passed') && t.actors.includes('buyer'),
    );
    expect(buyerBlocking).toEqual([]);
  });

  it('from failed, the only funds-to-seller transition requires the buyer', () => {
    const toSellerFunds = TRANSITIONS.filter(
      (t) => t.from === 'failed' && (t.to === 'settled_released' || t.to === 'settled_override'),
    );
    expect(toSellerFunds.map((t) => t.to)).toEqual(['settled_override']);
    expect(toSellerFunds[0]!.actors).toEqual(['buyer']);
  });

  it('settled states are terminal — no transitions out', () => {
    const outOfSettled = TRANSITIONS.filter((t) => isSettled(t.from));
    expect(outOfSettled).toEqual([]);
  });
});

describe('legal transitions', () => {
  it('every declared transition is executable end-to-end via its legal path', async () => {
    // Exercised collectively by the scenario tests below; here we assert the
    // table is internally reachable: every from-state (except created, the
    // entry point) is some transition's to-state.
    const froms = new Set(TRANSITIONS.map((t) => t.from));
    const tos = new Set(TRANSITIONS.map((t) => t.to));
    for (const from of froms) {
      if (from !== 'created') expect(tos.has(from), `unreachable state ${from}`).toBe(true);
    }
  });

  it('happy path: escrowed → delivered → verifying → passed → settled_released moves funds once', async () => {
    const orderId = await newEscrowedOrder();
    // Inbound 1000 escrowed; buyer credits net zero, wallet drained.
    expect(await getBalance(db, agentAccount(buyer.id))).toBe(0n);
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(0n);
    await driveTo(orderId, 'settled_released');
    expect(await orderState(orderId)).toBe('settled_released');
    // Payout executed: 900 USDC on the seller's wallet, fee stays as credits.
    expect(getMockRail().balanceOf(seller.wallet)).toBe(900n);
    expect(await getBalance(db, agentAccount(seller.id))).toBe(0n);
    expect(await getBalance(db, PLATFORM_FEES)).toBe(100n);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('FAIL then window lapse refunds the buyer in full', async () => {
    const orderId = await newEscrowedOrder();
    await driveTo(orderId, 'settled_refund');
    expect(await orderState(orderId)).toBe('settled_refund');
    // Refund payout lands back on the buyer's wallet, no fee taken.
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(1000n);
    expect(getMockRail().balanceOf(seller.wallet)).toBe(0n);
    expect(await getBalance(db, agentAccount(buyer.id))).toBe(0n);
  });

  it('FAIL then buyer override pays the seller (minus fee)', async () => {
    const orderId = await newEscrowedOrder();
    await driveTo(orderId, 'settled_override');
    expect(await orderState(orderId)).toBe('settled_override');
    expect(getMockRail().balanceOf(seller.wallet)).toBe(900n);
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.orderId, orderId));
    expect(entries.some((e) => e.entryType === 'override_payment')).toBe(true);
  });

  it('expiry refunds the buyer', async () => {
    const orderId = await newEscrowedOrder();
    const future = new Date(Date.now() + 7200_000);
    await transitionOrder(db, { orderId, to: 'expired', actor: 'system', now: future });
    await transitionOrder(db, { orderId, to: 'settled_refund', actor: 'system', now: future });
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(1000n);
  });

  it('appeal path: failed → appealed → settled_released pays the seller and returns the deposit', async () => {
    // Seller needs the 5% appeal deposit (50 credits on a 1000-credit order).
    await fund(db, seller.id, 50n);
    const orderId = await newEscrowedOrder();
    await driveTo(orderId, 'appealed');
    // Deposit held while the appeal is pending.
    expect(await getBalance(db, agentAccount(seller.id))).toBe(0n);
    await transitionOrder(db, { orderId, to: 'settled_released', actor: 'system' });
    // 900 release + 50 deposit back, both paid out on-chain.
    expect(getMockRail().balanceOf(seller.wallet)).toBe(950n);
    expect(await getBalance(db, agentAccount(seller.id))).toBe(0n);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('losing an appeal refunds the buyer and forfeits the deposit to fees', async () => {
    await fund(db, seller.id, 50n);
    const orderId = await newEscrowedOrder();
    await driveTo(orderId, 'appealed');
    await transitionOrder(db, { orderId, to: 'settled_refund', actor: 'system' });
    expect(getMockRail().balanceOf(buyer.wallet)).toBe(1000n);
    expect(getMockRail().balanceOf(seller.wallet)).toBe(0n);
    expect(await getBalance(db, PLATFORM_FEES)).toBe(50n);
    expect(await ledgerSum(db)).toBe(0n);
  });
});

describe('illegal transitions — full matrix', () => {
  it('rejects every (state, state, actor) combination not in the table', async () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        for (const actor of ALL_ACTORS) {
          const t = findTransition(from, to);
          const legal = t !== undefined && t.actors.includes(actor);
          if (legal) continue;
          const { assertTransition } = await import('@/lib/state-machine');
          expect(
            () => assertTransition(from, to, actor),
            `${from} -> ${to} as ${actor} should be rejected`,
          ).toThrow(TransitionError);
        }
      }
    }
  });

  it('buyer cannot block a PASS: no buyer action moves an order out of verifying/passed except through settlement', async () => {
    const orderId = await newEscrowedOrder();
    await driveTo(orderId, 'verifying');
    for (const to of ALL_STATES) {
      await expect(
        transitionOrder(db, { orderId, to, actor: 'buyer', agentId: buyer.id }),
      ).rejects.toThrow(TransitionError);
    }
    expect(await orderState(orderId)).toBe('verifying');
  });

  it('seller cannot self-release funds from failed', async () => {
    const orderId = await newEscrowedOrder();
    await driveTo(orderId, 'failed');
    for (const to of ['settled_released', 'settled_override'] as OrderState[]) {
      await expect(
        transitionOrder(db, { orderId, to, actor: 'seller', agentId: seller.id }),
      ).rejects.toThrow(TransitionError);
    }
    expect(getMockRail().balanceOf(seller.wallet)).toBe(0n);
  });

  it('a non-party agent cannot act as buyer or seller', async () => {
    const stranger = await makeAgent(db, 'stranger');
    const orderId = await newEscrowedOrder();
    await expect(
      transitionOrder(db, { orderId, to: 'delivered', actor: 'seller', agentId: stranger.id }),
    ).rejects.toThrow(TransitionError);
    await driveTo(orderId, 'failed');
    await expect(
      transitionOrder(db, { orderId, to: 'settled_override', actor: 'buyer', agentId: stranger.id }),
    ).rejects.toThrow(TransitionError);
  });
});

describe('guards', () => {
  it('cannot expire before the deadline', async () => {
    const orderId = await newEscrowedOrder();
    await expect(
      transitionOrder(db, { orderId, to: 'expired', actor: 'system' }),
    ).rejects.toThrow(/deadline has not passed/);
  });

  it('cannot deliver after the deadline', async () => {
    const orderId = await newEscrowedOrder();
    await expect(
      transitionOrder(db, {
        orderId,
        to: 'delivered',
        actor: 'seller',
        agentId: seller.id,
        now: new Date(Date.now() + 7200_000),
      }),
    ).rejects.toThrow(/deadline has passed/);
  });

  it('fail window: no auto-refund while open, no override after it closes', async () => {
    const orderId = await newEscrowedOrder();
    await driveTo(orderId, 'failed');
    await expect(
      transitionOrder(db, { orderId, to: 'settled_refund', actor: 'system' }),
    ).rejects.toThrow(/window is still open/);
    await expect(
      transitionOrder(db, {
        orderId,
        to: 'settled_override',
        actor: 'buyer',
        agentId: buyer.id,
        now: new Date(Date.now() + 49 * 3600 * 1000),
      }),
    ).rejects.toThrow(/window has closed/);
  });
});

describe('settlement invariants', () => {
  it('funds move only on transitions into settled_* states', async () => {
    const orderId = await newEscrowedOrder();
    const holdEntries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orderId, orderId));
    // Pre-settlement the order has only its inbound payment + escrow hold.
    expect(
      holdEntries.every((e) => e.entryType === 'escrow_hold' || e.entryType === 'topup'),
    ).toBe(true);

    for (const target of ['delivered', 'verifying', 'passed'] as OrderState[]) {
      // walk one step at a time and confirm no new ledger rows appear
      const before = (await db.select().from(ledgerEntries)).length;
      const step =
        target === 'delivered'
          ? { to: target, actor: 'seller' as Actor, agentId: seller.id }
          : target === 'verifying'
            ? { to: target, actor: 'system' as Actor }
            : { to: target, actor: 'panel' as Actor };
      await transitionOrder(db, { orderId, ...step });
      const after = (await db.select().from(ledgerEntries)).length;
      expect(after, `no funds may move entering ${target}`).toBe(before);
    }
    const before = (await db.select().from(ledgerEntries)).length;
    await transitionOrder(db, { orderId, to: 'settled_released', actor: 'system' });
    const after = (await db.select().from(ledgerEntries)).length;
    expect(after).toBeGreaterThan(before);
  });

  it('exactly one settlement per order — settled orders reject any further transition', async () => {
    const orderId = await newEscrowedOrder();
    await driveTo(orderId, 'settled_released');
    for (const to of ALL_STATES) {
      for (const actor of ALL_ACTORS) {
        await expect(
          transitionOrder(db, { orderId, to, actor, agentId: actor === 'buyer' ? buyer.id : seller.id }),
        ).rejects.toThrow(TransitionError);
      }
    }
    // Seller was paid exactly once.
    expect(getMockRail().balanceOf(seller.wallet)).toBe(900n);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('concurrent settlement attempts settle exactly once', async () => {
    const orderId = await newEscrowedOrder();
    await driveTo(orderId, 'passed');
    const results = await Promise.allSettled([
      transitionOrder(db, { orderId, to: 'settled_released', actor: 'system' }),
      transitionOrder(db, { orderId, to: 'settled_released', actor: 'system' }),
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    expect(succeeded).toBe(1);
    expect(getMockRail().balanceOf(seller.wallet)).toBe(900n);
  });

  it('an unfunded wallet cannot escrow: payment fails and the order stays unpaid', async () => {
    const poor = await makeAgent(db, 'poor');
    fundWallet(poor.wallet, 10n); // far below the 1000-credit price
    const quote = await createOrderQuote(db, {
      buyerAgentId: poor.id,
      listingId,
      inputPayload: {},
    });
    await expect(
      payForOrder(db, {
        orderId: quote.orderId,
        buyerAgentId: poor.id,
        buyerWallet: poor.wallet,
        paymentHeader: MockRail.paymentHeader(poor.wallet),
      }),
    ).rejects.toThrow(/cannot cover/);
    const rows = await db.select().from(orders).where(eq(orders.buyerAgentId, poor.id));
    expect(rows[0]!.state).toBe('created'); // quote persists, escrow never happened
    expect(await getBalance(db, agentAccount(poor.id))).toBe(0n);
  });
});
