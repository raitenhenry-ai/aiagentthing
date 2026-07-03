import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const agentStatusEnum = pgEnum('agent_status', ['active', 'frozen']);

export const listingStatusEnum = pgEnum('listing_status', [
  'draft',
  'active',
  'paused',
  'delisted',
]);

export const orderStateEnum = pgEnum('order_state', [
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
]);

export const verdictEnum = pgEnum('verdict', ['PASS', 'FAIL']);

export const verificationTierEnum = pgEnum('verification_tier', [
  'auto',
  'panel',
  'dispute',
]);

export const disputeStateEnum = pgEnum('dispute_state', ['open', 'resolved']);

export const ledgerEntryTypeEnum = pgEnum('ledger_entry_type', [
  'topup',
  'escrow_hold',
  'escrow_release',
  'escrow_refund',
  'fee',
  'withdrawal',
  'override_payment',
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    name: text('name').notNull(),
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
    apiKeyHash: text('api_key_hash').notNull(),
    status: agentStatusEnum('status').notNull().default('active'),
    reputationScore: integer('reputation_score').notNull().default(50),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    apiKeyHashIdx: uniqueIndex('agents_api_key_hash_idx').on(t.apiKeyHash),
    accountIdx: index('agents_account_id_idx').on(t.accountId),
  }),
);

export const listings = pgTable(
  'listings',
  {
    id: text('id').primaryKey(),
    sellerAgentId: text('seller_agent_id')
      .notNull()
      .references(() => agents.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    priceCredits: bigint('price_credits', { mode: 'bigint' }).notNull(),
    turnaroundSeconds: integer('turnaround_seconds').notNull(),
    acceptanceCriteria: jsonb('acceptance_criteria').notNull(),
    status: listingStatusEnum('status').notNull().default('draft'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sellerIdx: index('listings_seller_agent_id_idx').on(t.sellerAgentId),
    statusIdx: index('listings_status_idx').on(t.status),
  }),
);

// Immutability snapshots: orders reference (listing_id, version); editing a
// listing bumps the version and writes a new snapshot, so criteria that were
// purchased-against can never change underneath an order.
export const listingVersions = pgTable(
  'listing_versions',
  {
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id),
    version: integer('version').notNull(),
    priceCredits: bigint('price_credits', { mode: 'bigint' }).notNull(),
    turnaroundSeconds: integer('turnaround_seconds').notNull(),
    acceptanceCriteria: jsonb('acceptance_criteria').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.listingId, t.version] }),
  }),
);

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id),
    listingVersion: integer('listing_version').notNull(),
    buyerAgentId: text('buyer_agent_id')
      .notNull()
      .references(() => agents.id),
    state: orderStateEnum('state').notNull().default('created'),
    priceCredits: bigint('price_credits', { mode: 'bigint' }).notNull(),
    escrowEntryId: text('escrow_entry_id'),
    inputPayload: jsonb('input_payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    failWindowEndsAt: timestamp('fail_window_ends_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => ({
    buyerIdx: index('orders_buyer_agent_id_idx').on(t.buyerAgentId),
    listingIdx: index('orders_listing_id_idx').on(t.listingId),
    stateIdx: index('orders_state_idx').on(t.state),
  }),
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    artifacts: jsonb('artifacts').notNull().default([]),
    receipts: jsonb('receipts').notNull().default([]),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('deliveries_order_id_idx').on(t.orderId),
  }),
);

export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    judgeVerdicts: jsonb('judge_verdicts').notNull(),
    aggregateVerdict: verdictEnum('aggregate_verdict').notNull(),
    aggregateConfidence: real('aggregate_confidence').notNull(),
    tier: verificationTierEnum('tier').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('verifications_order_id_idx').on(t.orderId),
  }),
);

export const disputes = pgTable(
  'disputes',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    openedBy: text('opened_by')
      .notNull()
      .references(() => agents.id),
    evidence: jsonb('evidence').notNull().default({}),
    state: disputeStateEnum('state').notNull().default('open'),
    resolution: jsonb('resolution'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => ({
    orderIdx: index('disputes_order_id_idx').on(t.orderId),
  }),
);

// Double-entry, append-only. Every movement is exactly two rows summing to
// zero, cross-linked via balancing_entry_id (FK added as deferrable in SQL
// migration so both rows of a pair can insert in one statement).
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: text('id').primaryKey(),
    ledgerAccount: text('ledger_account').notNull(),
    orderId: text('order_id').references(() => orders.id),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    entryType: ledgerEntryTypeEnum('entry_type').notNull(),
    balancingEntryId: text('balancing_entry_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountIdx: index('ledger_entries_account_idx').on(t.ledgerAccount),
    orderIdx: index('ledger_entries_order_id_idx').on(t.orderId),
  }),
);

export const reputationEvents = pgTable(
  'reputation_events',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    orderId: text('order_id').references(() => orders.id),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentIdx: index('reputation_events_agent_id_idx').on(t.agentId),
  }),
);

export const webhooks = pgTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    events: jsonb('events').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentIdx: index('webhooks_agent_id_idx').on(t.agentId),
  }),
);

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  agentId: text('agent_id').notNull(),
  requestHash: text('request_hash').notNull(),
  response: jsonb('response'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
