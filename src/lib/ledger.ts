import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { ledgerEntries } from '@/db/schema';
import { newId } from './ids';

// ---------------------------------------------------------------------------
// Ledger accounts
// ---------------------------------------------------------------------------

export const PLATFORM_ESCROW = 'platform:escrow';
export const PLATFORM_FEES = 'platform:fees';
/** Credits reserved for in-flight on-chain payouts — reserving at enqueue
 * time makes double-spending a pending payout impossible. */
export const PLATFORM_PENDING = 'platform:pending_payouts';
export const EXTERNAL_BASE = 'external:base';

export function agentAccount(agentId: string): string {
  return `agent:${agentId}`;
}

export type LedgerEntryType =
  | 'topup'
  | 'escrow_hold'
  | 'escrow_release'
  | 'escrow_refund'
  | 'fee'
  | 'withdrawal'
  | 'override_payment'
  | 'appeal_deposit'
  | 'appeal_deposit_refund'
  | 'appeal_deposit_forfeit'
  | 'invoice_payment'
  | 'tip';

export class InsufficientFundsError extends Error {
  constructor(account: string, requested: bigint, available: bigint) {
    super(
      `Insufficient funds in ${account}: requested ${requested}, available ${available}`,
    );
    this.name = 'InsufficientFundsError';
  }
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

// ---------------------------------------------------------------------------
// Core posting primitive
// ---------------------------------------------------------------------------

interface Movement {
  from: string;
  to: string;
  amount: bigint;
  entryType: LedgerEntryType;
  orderId?: string;
  /** On-chain USDC transfer hash for movements crossing the money boundary. */
  txHash?: string;
}

/**
 * Post one double-entry movement: exactly two rows, cross-linked, summing to
 * zero. Must be called inside a transaction. Returns the debit entry id.
 */
export async function postMovement(tx: Tx, m: Movement): Promise<string> {
  if (m.amount <= 0n) {
    throw new LedgerError(`Movement amount must be positive, got ${m.amount}`);
  }
  if (m.from === m.to) {
    throw new LedgerError(`Movement from and to accounts must differ (${m.from})`);
  }
  const debitId = newId('led');
  const creditId = newId('led');
  await tx.insert(ledgerEntries).values([
    {
      id: debitId,
      ledgerAccount: m.from,
      orderId: m.orderId,
      amount: -m.amount,
      entryType: m.entryType,
      balancingEntryId: creditId,
      txHash: m.txHash,
    },
    {
      id: creditId,
      ledgerAccount: m.to,
      orderId: m.orderId,
      amount: m.amount,
      entryType: m.entryType,
      balancingEntryId: debitId,
      txHash: m.txHash,
    },
  ]);
  return debitId;
}

/**
 * Serialize all balance-affecting work on an account for the duration of the
 * enclosing transaction, so concurrent spends cannot both pass a balance
 * check.
 */
export async function lockAccount(tx: Tx, account: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${account}))`);
}

export async function getBalance(db: Db | Tx, account: string): Promise<bigint> {
  const rows = await db
    .select({
      balance: sql<string>`COALESCE(SUM(${ledgerEntries.amount}), 0)`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.ledgerAccount, account));
  return BigInt(rows[0]?.balance ?? '0');
}

/** The whole-ledger sum — must always be exactly zero. */
export async function ledgerSum(db: Db | Tx): Promise<bigint> {
  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${ledgerEntries.amount}), 0)` })
    .from(ledgerEntries);
  return BigInt(rows[0]?.total ?? '0');
}

// ---------------------------------------------------------------------------
// Domain movements
// ---------------------------------------------------------------------------

export function feeFor(price: bigint, feeBps: number): bigint {
  return (price * BigInt(feeBps)) / 10000n;
}

/**
 * Inbound funds crossing the money boundary (a confirmed x402 USDC payment)
 * land in the agent's credits account. txHash links to the on-chain settle.
 */
export async function topUp(
  db: Db | Tx,
  agentId: string,
  amount: bigint,
  txHash?: string,
  orderId?: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    return postMovement(tx, {
      from: EXTERNAL_BASE,
      to: agentAccount(agentId),
      amount,
      entryType: 'topup',
      txHash,
      orderId,
    });
  });
}

/**
 * Hold the order price from the buyer in platform escrow. Fails with
 * InsufficientFundsError if the buyer's balance can't cover it.
 */
export async function holdEscrow(
  tx: Tx,
  args: { orderId: string; buyerAgentId: string; amount: bigint },
): Promise<string> {
  const buyer = agentAccount(args.buyerAgentId);
  await lockAccount(tx, buyer);
  const balance = await getBalance(tx, buyer);
  if (balance < args.amount) {
    throw new InsufficientFundsError(buyer, args.amount, balance);
  }
  return postMovement(tx, {
    from: buyer,
    to: PLATFORM_ESCROW,
    amount: args.amount,
    entryType: 'escrow_hold',
    orderId: args.orderId,
  });
}

const PRINCIPAL_TYPES = [
  'escrow_hold',
  'escrow_release',
  'escrow_refund',
  'override_payment',
  'fee',
] as const;

const DEPOSIT_TYPES = [
  'appeal_deposit',
  'appeal_deposit_refund',
  'appeal_deposit_forfeit',
] as const;

/** Order principal currently held in escrow (appeal deposits tracked apart). */
async function heldAmount(tx: Tx, orderId: string): Promise<bigint> {
  const rows = await tx
    .select({
      held: sql<string>`COALESCE(SUM(${ledgerEntries.amount}), 0)`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.orderId, orderId),
        eq(ledgerEntries.ledgerAccount, PLATFORM_ESCROW),
        inArray(ledgerEntries.entryType, [...PRINCIPAL_TYPES]),
      ),
    );
  return BigInt(rows[0]?.held ?? '0');
}

/** Appeal deposit currently held in escrow for this order. */
export async function depositHeld(tx: Tx, orderId: string): Promise<bigint> {
  const rows = await tx
    .select({
      held: sql<string>`COALESCE(SUM(${ledgerEntries.amount}), 0)`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.orderId, orderId),
        eq(ledgerEntries.ledgerAccount, PLATFORM_ESCROW),
        inArray(ledgerEntries.entryType, [...DEPOSIT_TYPES]),
      ),
    );
  return BigInt(rows[0]?.held ?? '0');
}

/**
 * Hold the seller's appeal deposit (APPEAL_DEPOSIT_BPS of order value —
 * 0 by default, so this is usually a no-op; refunded if the
 * appeal succeeds, forfeited to platform fees if it fails).
 */
export async function holdAppealDeposit(
  tx: Tx,
  args: { orderId: string; sellerAgentId: string; amount: bigint },
): Promise<void> {
  if (args.amount <= 0n) return;
  const seller = agentAccount(args.sellerAgentId);
  await lockAccount(tx, seller);
  const balance = await getBalance(tx, seller);
  if (balance < args.amount) {
    throw new InsufficientFundsError(seller, args.amount, balance);
  }
  await postMovement(tx, {
    from: seller,
    to: PLATFORM_ESCROW,
    amount: args.amount,
    entryType: 'appeal_deposit',
    orderId: args.orderId,
  });
}

/**
 * Reserve credits for an outbound payout: agent -> pending. Runs in the
 * same transaction as whatever credited the agent, so the balance can never
 * be spent twice while a transfer is in flight.
 */
export async function reserveForPayout(
  tx: Tx,
  args: { agentId: string; amount: bigint; orderId?: string },
): Promise<void> {
  const account = agentAccount(args.agentId);
  await lockAccount(tx, account);
  const balance = await getBalance(tx, account);
  if (balance < args.amount) {
    throw new InsufficientFundsError(account, args.amount, balance);
  }
  await postMovement(tx, {
    from: account,
    to: PLATFORM_PENDING,
    amount: args.amount,
    entryType: 'withdrawal',
    orderId: args.orderId,
  });
}

/** Finalize a confirmed payout: pending -> external, carrying the tx hash. */
export async function settleReservedPayout(
  tx: Tx,
  args: { amount: bigint; orderId?: string; txHash: string },
): Promise<void> {
  await postMovement(tx, {
    from: PLATFORM_PENDING,
    to: EXTERNAL_BASE,
    amount: args.amount,
    entryType: 'withdrawal',
    orderId: args.orderId,
    txHash: args.txHash,
  });
}

/** Cancel a reserved payout: pending -> agent (correction, never an edit). */
export async function refundReservedPayout(
  tx: Tx,
  args: { agentId: string; amount: bigint; orderId?: string },
): Promise<void> {
  await postMovement(tx, {
    from: PLATFORM_PENDING,
    to: agentAccount(args.agentId),
    amount: args.amount,
    entryType: 'withdrawal',
    orderId: args.orderId,
  });
}

/** Return or forfeit whatever appeal deposit is held for the order. */
export async function settleAppealDeposit(
  tx: Tx,
  args: { orderId: string; sellerAgentId: string; outcome: 'refund' | 'forfeit' },
): Promise<bigint> {
  const held = await depositHeld(tx, args.orderId);
  if (held <= 0n) return 0n;
  await postMovement(tx, {
    from: PLATFORM_ESCROW,
    to: args.outcome === 'refund' ? agentAccount(args.sellerAgentId) : PLATFORM_FEES,
    amount: held,
    entryType: args.outcome === 'refund' ? 'appeal_deposit_refund' : 'appeal_deposit_forfeit',
    orderId: args.orderId,
  });
  return held;
}

/**
 * Release held funds to the seller minus the platform fee. Used for both
 * normal PASS release (`escrow_release`) and buyer override of a FAIL
 * (`override_payment`). Double release is blocked both here (held amount
 * check) and by a partial unique index in the database.
 */
export async function releaseEscrow(
  tx: Tx,
  args: {
    orderId: string;
    sellerAgentId: string;
    feeBps: number;
    entryType: 'escrow_release' | 'override_payment';
  },
): Promise<{ net: bigint; fee: bigint }> {
  const held = await heldAmount(tx, args.orderId);
  if (held <= 0n) {
    throw new LedgerError(`No funds held in escrow for order ${args.orderId}`);
  }
  const fee = feeFor(held, args.feeBps);
  const net = held - fee;
  await postMovement(tx, {
    from: PLATFORM_ESCROW,
    to: agentAccount(args.sellerAgentId),
    amount: net,
    entryType: args.entryType,
    orderId: args.orderId,
  });
  if (fee > 0n) {
    await postMovement(tx, {
      from: PLATFORM_ESCROW,
      to: PLATFORM_FEES,
      amount: fee,
      entryType: 'fee',
      orderId: args.orderId,
    });
  }
  return { net, fee };
}

/** Return all held funds to the buyer (FAIL lapse, expiry, dispute refund). */
export async function refundEscrow(
  tx: Tx,
  args: { orderId: string; buyerAgentId: string },
): Promise<bigint> {
  const held = await heldAmount(tx, args.orderId);
  if (held <= 0n) {
    throw new LedgerError(`No funds held in escrow for order ${args.orderId}`);
  }
  await postMovement(tx, {
    from: PLATFORM_ESCROW,
    to: agentAccount(args.buyerAgentId),
    amount: held,
    entryType: 'escrow_refund',
    orderId: args.orderId,
  });
  return held;
}
