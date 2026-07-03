import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { ledgerEntries } from '@/db/schema';
import {
  agentAccount,
  feeFor,
  getBalance,
  holdEscrow,
  InsufficientFundsError,
  LedgerError,
  ledgerSum,
  PLATFORM_ESCROW,
  PLATFORM_FEES,
  refundEscrow,
  releaseEscrow,
  topUp,
} from '@/lib/ledger';
import { createTestDb, fund, makeAgent, makeListing, type TestAgent } from './helpers';
import { newId } from '@/lib/ids';
import { orders } from '@/db/schema';

let db: Db;
let buyer: TestAgent;
let seller: TestAgent;
let orderId: string;

async function makeOrder(price: bigint): Promise<string> {
  const listingId = await makeListing(db, seller.id, { priceCredits: price });
  const id = newId('ord');
  await db.insert(orders).values({
    id,
    listingId,
    listingVersion: 1,
    buyerAgentId: buyer.id,
    state: 'created',
    priceCredits: price,
    inputPayload: {},
    deadlineAt: new Date(Date.now() + 3600_000),
  });
  return id;
}

beforeEach(async () => {
  db = await createTestDb();
  buyer = await makeAgent(db, 'buyer');
  seller = await makeAgent(db, 'seller');
  orderId = await makeOrder(1000n);
});

describe('double-entry ledger', () => {
  it('top-up credits the agent and debits the external account, summing to zero', async () => {
    await topUp(db, buyer.id, 5000n);
    expect(await getBalance(db, agentAccount(buyer.id))).toBe(5000n);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('every entry has exactly one balancing entry with negated amount', async () => {
    await fund(db, buyer.id, 5000n);
    await db.transaction((tx) => holdEscrow(tx, { orderId, buyerAgentId: buyer.id, amount: 1000n }));
    const rows = await db.select().from(ledgerEntries);
    expect(rows.length).toBe(4);
    for (const row of rows) {
      const partner = rows.find((r) => r.id === row.balancingEntryId);
      expect(partner).toBeDefined();
      expect(partner!.amount).toBe(-row.amount);
      expect(partner!.balancingEntryId).toBe(row.id);
    }
  });

  it('escrow hold rejects insufficient funds and leaves no rows behind', async () => {
    await fund(db, buyer.id, 500n);
    await expect(
      db.transaction((tx) => holdEscrow(tx, { orderId, buyerAgentId: buyer.id, amount: 1000n })),
    ).rejects.toThrow(InsufficientFundsError);
    expect(await getBalance(db, agentAccount(buyer.id))).toBe(500n);
    expect(await getBalance(db, PLATFORM_ESCROW)).toBe(0n);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('release pays seller net of fee and credits the fee account', async () => {
    await fund(db, buyer.id, 1000n);
    await db.transaction((tx) => holdEscrow(tx, { orderId, buyerAgentId: buyer.id, amount: 1000n }));
    const { net, fee } = await db.transaction((tx) =>
      releaseEscrow(tx, { orderId, sellerAgentId: seller.id, feeBps: 1000, entryType: 'escrow_release' }),
    );
    expect(fee).toBe(100n);
    expect(net).toBe(900n);
    expect(await getBalance(db, agentAccount(seller.id))).toBe(900n);
    expect(await getBalance(db, PLATFORM_FEES)).toBe(100n);
    expect(await getBalance(db, PLATFORM_ESCROW)).toBe(0n);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('refund returns the full held amount to the buyer', async () => {
    await fund(db, buyer.id, 1000n);
    await db.transaction((tx) => holdEscrow(tx, { orderId, buyerAgentId: buyer.id, amount: 1000n }));
    const refunded = await db.transaction((tx) =>
      refundEscrow(tx, { orderId, buyerAgentId: buyer.id }),
    );
    expect(refunded).toBe(1000n);
    expect(await getBalance(db, agentAccount(buyer.id))).toBe(1000n);
    expect(await getBalance(db, PLATFORM_ESCROW)).toBe(0n);
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('an order cannot be double-released (application guard)', async () => {
    await fund(db, buyer.id, 1000n);
    await db.transaction((tx) => holdEscrow(tx, { orderId, buyerAgentId: buyer.id, amount: 1000n }));
    await db.transaction((tx) =>
      releaseEscrow(tx, { orderId, sellerAgentId: seller.id, feeBps: 1000, entryType: 'escrow_release' }),
    );
    await expect(
      db.transaction((tx) =>
        releaseEscrow(tx, { orderId, sellerAgentId: seller.id, feeBps: 1000, entryType: 'escrow_release' }),
      ),
    ).rejects.toThrow(LedgerError);
    expect(await getBalance(db, agentAccount(seller.id))).toBe(900n);
  });

  it('an order cannot be released then refunded (database unique index)', async () => {
    await fund(db, buyer.id, 2000n);
    await db.transaction((tx) => holdEscrow(tx, { orderId, buyerAgentId: buyer.id, amount: 1000n }));
    await db.transaction((tx) =>
      releaseEscrow(tx, { orderId, sellerAgentId: seller.id, feeBps: 1000, entryType: 'escrow_release' }),
    );
    // Bypass the held-amount application guard by posting a raw refund pair:
    // the partial unique settlement index must still reject it.
    const { postMovement } = await import('@/lib/ledger');
    await expect(
      db.transaction((tx) =>
        postMovement(tx, {
          from: PLATFORM_ESCROW,
          to: agentAccount(buyer.id),
          amount: 1000n,
          entryType: 'escrow_refund',
          orderId,
        }),
      ),
    ).rejects.toThrow();
    expect(await ledgerSum(db)).toBe(0n);
  });

  it('fee math is integer floor in basis points', () => {
    expect(feeFor(1000n, 1000)).toBe(100n);
    expect(feeFor(999n, 1000)).toBe(99n);
    expect(feeFor(1n, 1000)).toBe(0n);
    expect(feeFor(10_000_000_000n, 1000)).toBe(1_000_000_000n);
  });

  it('release on an order with no escrow held fails', async () => {
    await expect(
      db.transaction((tx) =>
        releaseEscrow(tx, { orderId, sellerAgentId: seller.id, feeBps: 1000, entryType: 'escrow_release' }),
      ),
    ).rejects.toThrow(LedgerError);
  });

  it('concurrent spends cannot exceed the balance', async () => {
    await fund(db, buyer.id, 1000n);
    const otherOrder = await makeOrder(800n);
    const attempts = await Promise.allSettled([
      db.transaction((tx) => holdEscrow(tx, { orderId, buyerAgentId: buyer.id, amount: 800n })),
      db.transaction((tx) =>
        holdEscrow(tx, { orderId: otherOrder, buyerAgentId: buyer.id, amount: 800n }),
      ),
    ]);
    const succeeded = attempts.filter((a) => a.status === 'fulfilled').length;
    expect(succeeded).toBe(1);
    expect(await getBalance(db, agentAccount(buyer.id))).toBe(200n);
    expect(await ledgerSum(db)).toBe(0n);
  });
});
