import { eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { agents, listings, orders, reputationEvents } from '@/db/schema';
import { failOverrideWindowSeconds, platformFeeBps } from './env';
import { newId } from './ids';
import { refundEscrow, releaseEscrow } from './ledger';

// ---------------------------------------------------------------------------
// States, actors, transitions
// ---------------------------------------------------------------------------

export type OrderState =
  | 'created'
  | 'escrowed'
  | 'delivered'
  | 'verifying'
  | 'passed'
  | 'failed'
  | 'expired'
  | 'appealed'
  | 'settled_released'
  | 'settled_refund'
  | 'settled_override';

export type Actor = 'buyer' | 'seller' | 'system' | 'panel';

export const SETTLED_STATES = [
  'settled_released',
  'settled_refund',
  'settled_override',
] as const satisfies readonly OrderState[];

export type SettledState = (typeof SETTLED_STATES)[number];

export function isSettled(state: OrderState): state is SettledState {
  return (SETTLED_STATES as readonly OrderState[]).includes(state);
}

export interface Transition {
  name: string;
  from: OrderState;
  to: OrderState;
  /** Who is allowed to trigger this transition. Nobody else, ever. */
  actors: readonly Actor[];
}

/**
 * The complete transition table. This is the ONLY way order state changes.
 *
 * Product invariants encoded here — do not "fix" these:
 * - No buyer-triggerable transition exists from `verifying` or `passed`:
 *   a buyer can never block a PASS.
 * - From `failed`, the only funds-to-seller transition (`buyer_override`)
 *   requires the buyer; sellers get `seller_appeal`, an appeal, not a veto.
 */
export const TRANSITIONS: readonly Transition[] = [
  { name: 'escrow_funds', from: 'created', to: 'escrowed', actors: ['system'] },
  { name: 'submit_delivery', from: 'escrowed', to: 'delivered', actors: ['seller'] },
  { name: 'deadline_expired', from: 'escrowed', to: 'expired', actors: ['system'] },
  { name: 'expiry_refund', from: 'expired', to: 'settled_refund', actors: ['system'] },
  { name: 'start_verification', from: 'delivered', to: 'verifying', actors: ['system'] },
  { name: 'panel_pass', from: 'verifying', to: 'passed', actors: ['panel'] },
  { name: 'release_funds', from: 'passed', to: 'settled_released', actors: ['system'] },
  { name: 'panel_fail', from: 'verifying', to: 'failed', actors: ['panel'] },
  { name: 'fail_window_lapse', from: 'failed', to: 'settled_refund', actors: ['system'] },
  { name: 'buyer_override', from: 'failed', to: 'settled_override', actors: ['buyer'] },
  { name: 'seller_appeal', from: 'failed', to: 'appealed', actors: ['seller'] },
  { name: 'appeal_release', from: 'appealed', to: 'settled_released', actors: ['system'] },
  { name: 'appeal_refund', from: 'appealed', to: 'settled_refund', actors: ['system'] },
  { name: 'appeal_override', from: 'appealed', to: 'settled_override', actors: ['buyer'] },
] as const;

export class TransitionError extends Error {
  readonly code: 'invalid_transition' | 'forbidden_actor' | 'guard_failed';
  constructor(code: TransitionError['code'], message: string) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
  }
}

export function findTransition(from: OrderState, to: OrderState): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function assertTransition(from: OrderState, to: OrderState, actor: Actor): Transition {
  const t = findTransition(from, to);
  if (!t) {
    throw new TransitionError('invalid_transition', `No transition ${from} -> ${to}`);
  }
  if (!t.actors.includes(actor)) {
    throw new TransitionError(
      'forbidden_actor',
      `Actor ${actor} may not trigger ${t.name} (${from} -> ${to})`,
    );
  }
  return t;
}

// ---------------------------------------------------------------------------
// Executing transitions against an order
// ---------------------------------------------------------------------------

export interface OrderRow {
  id: string;
  listingId: string;
  buyerAgentId: string;
  state: OrderState;
  priceCredits: bigint;
  deadlineAt: Date;
  failWindowEndsAt: Date | null;
  settledAt: Date | null;
}

export interface TransitionResult {
  order: OrderRow;
  transition: Transition;
}

async function lockOrder(tx: Tx, orderId: string): Promise<OrderRow> {
  const rows = await tx
    .select({
      id: orders.id,
      listingId: orders.listingId,
      buyerAgentId: orders.buyerAgentId,
      state: orders.state,
      priceCredits: orders.priceCredits,
      deadlineAt: orders.deadlineAt,
      failWindowEndsAt: orders.failWindowEndsAt,
      settledAt: orders.settledAt,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .for('update');
  const row = rows[0];
  if (!row) throw new TransitionError('guard_failed', `Order ${orderId} not found`);
  return row;
}

async function sellerAgentIdFor(tx: Tx, listingId: string): Promise<string> {
  const rows = await tx
    .select({ sellerAgentId: listings.sellerAgentId })
    .from(listings)
    .where(eq(listings.id, listingId));
  const row = rows[0];
  if (!row) throw new TransitionError('guard_failed', `Listing ${listingId} not found`);
  return row.sellerAgentId;
}

async function recordReputationEvent(
  tx: Tx,
  agentId: string,
  orderId: string,
  delta: number,
  reason: string,
): Promise<void> {
  await tx.insert(reputationEvents).values({
    id: newId('rep'),
    agentId,
    orderId,
    delta,
    reason,
  });
  // Phase 1 placeholder scoring: nudge the 0-100 score by the event delta.
  // The Phase 3 reputation engine recomputes from events + ledger wholesale.
  await tx
    .update(agents)
    .set({
      reputationScore: sql`LEAST(100, GREATEST(0, ${agents.reputationScore} + ${delta}))`,
    })
    .where(eq(agents.id, agentId));
}

/**
 * Execute a state transition with all guards and side effects, atomically.
 *
 * Funds move ONLY here, and only on transitions into settled_* states — in
 * the same database transaction as the state write, under a row lock on the
 * order, guarded by `settled_at IS NULL` and (belt-and-braces) a partial
 * unique index on the ledger.
 */
export async function transitionOrder(
  db: Db | Tx,
  args: {
    orderId: string;
    to: OrderState;
    actor: Actor;
    /** For actor-scoped guards: the authenticated agent driving this call. */
    agentId?: string;
    now?: Date;
  },
): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const now = args.now ?? new Date();
    const order = await lockOrder(tx, args.orderId);
    const transition = assertTransition(order.state, args.to, args.actor);
    const sellerAgentId = await sellerAgentIdFor(tx, order.listingId);

    // Identity guards: buyer/seller actors must be the order's own parties.
    if (args.actor === 'buyer' && args.agentId !== order.buyerAgentId) {
      throw new TransitionError('forbidden_actor', 'Only the order buyer may do this');
    }
    if (args.actor === 'seller' && args.agentId !== sellerAgentId) {
      throw new TransitionError('forbidden_actor', 'Only the listing seller may do this');
    }

    // Temporal guards.
    if (transition.name === 'deadline_expired' && now < order.deadlineAt) {
      throw new TransitionError('guard_failed', 'Order deadline has not passed yet');
    }
    if (transition.name === 'submit_delivery' && now >= order.deadlineAt) {
      throw new TransitionError('guard_failed', 'Order deadline has passed');
    }
    if (
      transition.name === 'fail_window_lapse' &&
      order.failWindowEndsAt !== null &&
      now < order.failWindowEndsAt
    ) {
      throw new TransitionError('guard_failed', 'Buyer override window is still open');
    }
    if (
      (transition.name === 'buyer_override' || transition.name === 'seller_appeal') &&
      order.failWindowEndsAt !== null &&
      now >= order.failWindowEndsAt
    ) {
      throw new TransitionError('guard_failed', 'The 48h post-FAIL window has closed');
    }

    const update: Record<string, unknown> = { state: args.to };

    if (args.to === 'failed') {
      update.failWindowEndsAt = new Date(
        now.getTime() + failOverrideWindowSeconds() * 1000,
      );
    }

    // Settlement side effects — the only place funds ever move.
    if (isSettled(args.to)) {
      if (order.settledAt !== null) {
        throw new TransitionError('guard_failed', `Order ${order.id} already settled`);
      }
      update.settledAt = now;
      if (args.to === 'settled_released' || args.to === 'settled_override') {
        await releaseEscrow(tx, {
          orderId: order.id,
          sellerAgentId,
          feeBps: platformFeeBps(),
          entryType: args.to === 'settled_override' ? 'override_payment' : 'escrow_release',
        });
        const reason =
          args.to === 'settled_override' ? 'settled_via_buyer_override' : 'order_passed';
        await recordReputationEvent(tx, sellerAgentId, order.id, args.to === 'settled_released' ? 2 : 1, reason);
        await recordReputationEvent(tx, order.buyerAgentId, order.id, 1, 'order_settled');
      } else {
        await refundEscrow(tx, { orderId: order.id, buyerAgentId: order.buyerAgentId });
        const reason =
          order.state === 'expired' ? 'seller_missed_deadline' : 'order_failed_refund';
        await recordReputationEvent(tx, sellerAgentId, order.id, -2, reason);
      }
    }

    await tx.update(orders).set(update).where(eq(orders.id, order.id));

    const updated: OrderRow = {
      ...order,
      state: args.to,
      settledAt: isSettled(args.to) ? now : order.settledAt,
      failWindowEndsAt:
        args.to === 'failed'
          ? (update.failWindowEndsAt as Date)
          : order.failWindowEndsAt,
    };
    return { order: updated, transition };
  });
}
