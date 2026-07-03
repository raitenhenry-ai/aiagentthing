import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { orders } from '@/db/schema';
import { newId } from '@/lib/ids';
import {
  agentAccount,
  getBalance,
  holdEscrow,
  ledgerSum,
  refundEscrow,
  releaseEscrow,
  topUp,
} from '@/lib/ledger';
import { createTestDb, makeAgent, makeListing } from './helpers';

// Property: whatever sequence of ledger operations runs — including ones
// that are rejected — the whole ledger sums to zero and no agent balance
// ever goes negative.

type Op =
  | { kind: 'topup'; amount: bigint }
  | { kind: 'order'; price: bigint; outcome: 'release' | 'refund' | 'double_release' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant<'topup'>('topup'),
    amount: fc.bigInt({ min: 1n, max: 10_000n }),
  }),
  fc.record({
    kind: fc.constant<'order'>('order'),
    price: fc.bigInt({ min: 1n, max: 15_000n }),
    outcome: fc.constantFrom<'release' | 'refund' | 'double_release'>(
      'release',
      'refund',
      'double_release',
    ),
  }),
);

async function applyOp(
  db: Db,
  buyerId: string,
  sellerId: string,
  listingId: string,
  op: Op,
): Promise<void> {
  if (op.kind === 'topup') {
    await topUp(db, buyerId, op.amount);
    return;
  }
  const orderId = newId('ord');
  await db.insert(orders).values({
    id: orderId,
    listingId,
    listingVersion: 1,
    buyerAgentId: buyerId,
    state: 'created',
    priceCredits: op.price,
    inputPayload: {},
    deadlineAt: new Date(Date.now() + 3600_000),
  });
  try {
    await db.transaction((tx) =>
      holdEscrow(tx, { orderId, buyerAgentId: buyerId, amount: op.price }),
    );
  } catch {
    return; // insufficient funds — rejected, nothing moved
  }
  if (op.outcome === 'refund') {
    await db.transaction((tx) => refundEscrow(tx, { orderId, buyerAgentId: buyerId }));
    return;
  }
  await db.transaction((tx) =>
    releaseEscrow(tx, { orderId, sellerAgentId: sellerId, feeBps: 1000, entryType: 'escrow_release' }),
  );
  if (op.outcome === 'double_release') {
    await expect(
      db.transaction((tx) =>
        releaseEscrow(tx, { orderId, sellerAgentId: sellerId, feeBps: 1000, entryType: 'escrow_release' }),
      ),
    ).rejects.toThrow();
  }
}

describe('ledger properties', () => {
  it('ledger always sums to zero and balances never go negative', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async (ops) => {
        const db = await createTestDb();
        const buyer = await makeAgent(db, 'pbuyer');
        const seller = await makeAgent(db, 'pseller');
        const listingId = await makeListing(db, seller.id);
        for (const op of ops) {
          await applyOp(db, buyer.id, seller.id, listingId, op);
          expect(await ledgerSum(db)).toBe(0n);
          expect(await getBalance(db, agentAccount(buyer.id))).toBeGreaterThanOrEqual(0n);
          expect(await getBalance(db, agentAccount(seller.id))).toBeGreaterThanOrEqual(0n);
        }
      }),
      { numRuns: 15 },
    );
  }, 120_000);
});
