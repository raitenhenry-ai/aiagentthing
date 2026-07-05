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

export const pricingModeEnum = pgEnum('pricing_mode', ['fixed', 'quote']);

export const quoteStatusEnum = pgEnum('quote_status', [
  'pending',
  'quoted',
  'accepted',
  'declined',
  'expired',
]);

export const invoiceStatusEnum = pgEnum('invoice_status', ['open', 'paid', 'void']);

export const reviewRoleEnum = pgEnum('review_role', [
  'buyer_on_seller',
  'seller_on_buyer',
]);

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
  'appeal_deposit',
  'appeal_deposit_refund',
  'appeal_deposit_forfeit',
  'invoice_payment',
  'tip',
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

// Identity = wallet. An agent IS its Base wallet address; the record is
// auto-created on first authenticated interaction. No emails, no humans.
export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    walletAddress: text('wallet_address').notNull(),
    name: text('name').notNull().default(''),
    bio: text('bio').notNull().default(''),
    avatarUrl: text('avatar_url'),
    website: text('website'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    metadata: jsonb('metadata').notNull().default({}),
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
    status: agentStatusEnum('status').notNull().default('active'),
    reputationScore: integer('reputation_score').notNull().default(50),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    walletIdx: uniqueIndex('agents_wallet_address_idx').on(t.walletAddress),
  }),
);

// SIWE-style auth: single-use challenge nonces, then bearer session tokens
// (stored hashed) minted after wallet-signature verification.
export const authNonces = pgTable('auth_nonces', {
  nonce: text('nonce').primaryKey(),
  walletAddress: text('wallet_address').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentIdx: index('sessions_agent_id_idx').on(t.agentId),
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
    pricingMode: pricingModeEnum('pricing_mode').notNull().default('fixed'),
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
    quoteId: text('quote_id'),
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
    // On-chain settlement reference (USDC transfer) for topup/withdrawal rows.
    txHash: text('tx_hash'),
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

// Peer reviews: subjective counterpart to the objective reputation engine.
// One review per settled order per side; immutable once posted.
export const reviews = pgTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    reviewerAgentId: text('reviewer_agent_id')
      .notNull()
      .references(() => agents.id),
    subjectAgentId: text('subject_agent_id')
      .notNull()
      .references(() => agents.id),
    role: reviewRoleEnum('role').notNull(),
    rating: integer('rating').notNull(), // 1-5, checked in migration
    comment: text('comment').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneReviewPerSide: uniqueIndex('reviews_order_reviewer_idx').on(t.orderId, t.reviewerAgentId),
    subjectIdx: index('reviews_subject_idx').on(t.subjectAgentId),
  }),
);

// RFQ flow for quote-priced listings: buyer requests, seller prices,
// buyer accepts -> order at the quoted terms (criteria frozen at request).
export const quotes = pgTable(
  'quotes',
  {
    id: text('id').primaryKey(),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id),
    listingVersion: integer('listing_version').notNull(),
    buyerAgentId: text('buyer_agent_id')
      .notNull()
      .references(() => agents.id),
    sellerAgentId: text('seller_agent_id')
      .notNull()
      .references(() => agents.id),
    inputPayload: jsonb('input_payload').notNull(),
    message: text('message').notNull().default(''),
    status: quoteStatusEnum('status').notNull().default('pending'),
    quotedPriceCredits: bigint('quoted_price_credits', { mode: 'bigint' }),
    quotedTurnaroundSeconds: integer('quoted_turnaround_seconds'),
    sellerMessage: text('seller_message'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    orderId: text('order_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
  },
  (t) => ({
    buyerIdx: index('quotes_buyer_idx').on(t.buyerAgentId),
    sellerIdx: index('quotes_seller_idx').on(t.sellerAgentId),
    statusIdx: index('quotes_status_idx').on(t.status),
  }),
);

// Direct invoicing between agents (custom/off-listing work): x402-paid
// straight to the seller's wallet (zero fee), no escrow/verification —
// trust is priced via reputation and reviews.
export const invoices = pgTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    sellerAgentId: text('seller_agent_id')
      .notNull()
      .references(() => agents.id),
    buyerAgentId: text('buyer_agent_id')
      .notNull()
      .references(() => agents.id),
    lineItems: jsonb('line_items').notNull(),
    amountCredits: bigint('amount_credits', { mode: 'bigint' }).notNull(),
    memo: text('memo').notNull().default(''),
    status: invoiceStatusEnum('status').notNull().default('open'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    txHash: text('tx_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (t) => ({
    sellerIdx: index('invoices_seller_idx').on(t.sellerAgentId),
    buyerIdx: index('invoices_buyer_idx').on(t.buyerAgentId),
  }),
);

export const payoutStatusEnum = pgEnum('payout_status', [
  'pending',
  'confirmed',
  'failed',
]);

// On-chain payout queue. Settlement writes ledger entries and enqueues a
// payout; the transfer executes separately with idempotency + retries. A
// failed payout NEVER re-runs settlement logic — only the transfer retries.
export const payouts = pgTable(
  'payouts',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').references(() => orders.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    toWallet: text('to_wallet').notNull(),
    amountCredits: bigint('amount_credits', { mode: 'bigint' }).notNull(),
    reason: text('reason').notNull(), // release | refund | override | deposit_refund
    status: payoutStatusEnum('status').notNull().default('pending'),
    txHash: text('tx_hash'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => ({
    orderIdx: index('payouts_order_id_idx').on(t.orderId),
    statusIdx: index('payouts_status_idx').on(t.status),
  }),
);

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  agentId: text('agent_id').notNull(),
  requestHash: text('request_hash').notNull(),
  response: jsonb('response'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Direct agent-to-agent messaging (buyer ↔ seller). Each row is one message;
// `pairKey` (the two agent ids, sorted) groups a conversation thread so both
// directions read as one exchange. `orderId` optionally pins a message to an
// order for context. `readAt` is the recipient's read receipt.
export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    pairKey: text('pair_key').notNull(),
    senderAgentId: text('sender_agent_id')
      .notNull()
      .references(() => agents.id),
    recipientAgentId: text('recipient_agent_id')
      .notNull()
      .references(() => agents.id),
    orderId: text('order_id').references(() => orders.id),
    body: text('body').notNull(),
    /** Uploaded files/links: [{name, url}] where url is https:// or data:. */
    attachments: jsonb('attachments')
      .$type<Array<{ name: string; url: string }>>()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => ({
    threadIdx: index('messages_pair_created_idx').on(t.pairKey, t.createdAt),
    inboxIdx: index('messages_recipient_read_idx').on(t.recipientAgentId, t.readAt),
  }),
);

// Portfolio: an agent's examples of work shown on its profile. Each item can
// carry an external link OR an uploaded file/image (as a data: URI in `url`),
// an inline `sample` deliverable, and an optional `orderId` linking it to a
// real settled order (a verified proof-of-work badge).
export const portfolioItems = pgTable(
  'portfolio_items',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    url: text('url'),
    sample: jsonb('sample'),
    orderId: text('order_id').references(() => orders.id),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentIdx: index('portfolio_agent_idx').on(t.agentId, t.position),
  }),
);
