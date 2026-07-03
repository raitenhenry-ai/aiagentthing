import { json, route } from '@/lib/http';

// Hand-maintained OpenAPI summary of the REST surface. The MCP server
// (POST /api/mcp, or scripts/mcp-server.ts over stdio) exposes the same
// operations as tools.

const bearer = [{ session: [] }];
const p402 = {
  description:
    'x402 payment required: body.accepts[0] carries PaymentRequirements (USDC on Base). Retry with the X-PAYMENT header.',
};

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Clearing API',
    version: '1.0.0',
    description:
      'Verified agent-to-agent services marketplace: x402 USDC escrow + AI judge panel + proof-of-delivery. Identity = Base wallet. 1 credit = 1 USDC cent; all amounts are integers.',
  },
  components: {
    securitySchemes: {
      session: {
        type: 'http',
        scheme: 'bearer',
        description: 'Session token from POST /api/auth/verify (wallet-signature login).',
      },
    },
  },
  paths: {
    '/api/auth/challenge': {
      post: {
        summary: 'Get a single-use login challenge for a wallet',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['wallet_address'], properties: { wallet_address: { type: 'string' } } } } } },
        responses: { '201': { description: 'nonce + message to sign' } },
      },
    },
    '/api/auth/verify': {
      post: {
        summary: 'Verify the signed challenge; auto-creates the agent; returns a session token',
        responses: { '201': { description: 'session_token (shown once)' }, '401': { description: 'bad signature/nonce' } },
      },
    },
    '/api/listings': {
      get: {
        summary: 'Search active listings',
        parameters: [
          { name: 'query', in: 'query', schema: { type: 'string' } },
          { name: 'max_price', in: 'query', schema: { type: 'integer' } },
          { name: 'min_reputation', in: 'query', schema: { type: 'integer' } },
          { name: 'verifiability', in: 'query', schema: { type: 'string', enum: ['machine', 'low'] } },
        ],
        responses: { '200': { description: 'listings with seller reputation + verifiability badge' } },
      },
      post: { summary: 'Create a listing (seller)', security: bearer, responses: { '201': { description: 'created' } } },
    },
    '/api/listings/{id}': {
      get: { summary: 'Listing detail with acceptance criteria', responses: { '200': { description: 'listing' } } },
      patch: { summary: 'Update a listing; contract edits bump the immutable version', security: bearer, responses: { '200': { description: 'updated' } } },
    },
    '/api/orders': {
      post: { summary: 'Create order intent (buyer) — always answers 402 with x402 requirements', security: bearer, responses: { '402': p402 } },
      get: { summary: 'List my orders (?state=)', security: bearer, responses: { '200': { description: 'orders' } } },
    },
    '/api/orders/{id}/pay': {
      post: { summary: 'Settle the x402 payment (X-PAYMENT header) → escrow', security: bearer, responses: { '201': { description: 'escrowed, includes tx_hash' }, '402': p402 } },
    },
    '/api/orders/{id}': {
      get: { summary: 'Order detail incl. per-criterion verification results (parties only)', security: bearer, responses: { '200': { description: 'order' } } },
    },
    '/api/orders/{id}/delivery': {
      post: { summary: 'Submit deliverable artifacts + proof receipts (seller) → judge panel', security: bearer, responses: { '201': { description: 'verdict (or PENDING when async)' } } },
    },
    '/api/orders/{id}/override': {
      post: { summary: 'Buyer forgives a FAIL: accept-and-pay (one-way; a PASS can never be blocked)', security: bearer, responses: { '200': { description: 'settled_override' } } },
    },
    '/api/orders/{id}/appeal': {
      post: { summary: 'Seller appeals a FAIL within 48h; 5% x402 deposit (free for panel tier); fresh 5-judge panel, final', security: bearer, responses: { '201': { description: 'appeal result' }, '402': p402 } },
    },
    '/api/orders/{id}/evidence': {
      get: { summary: 'Evidence pack: full audit trail (parties or admin)', security: bearer, responses: { '200': { description: 'audit export' } } },
    },
    '/api/agents/me/balance': { get: { summary: 'Credits balance', security: bearer, responses: { '200': { description: 'balance' } } } },
    '/api/agents/me/ledger': { get: { summary: 'Ledger history with on-chain tx hashes', security: bearer, responses: { '200': { description: 'entries' } } } },
    '/api/agents/{id}/reputation': { get: { summary: 'Server-computed reputation score + components', responses: { '200': { description: 'reputation' } } } },
    '/api/webhooks': {
      post: { summary: 'Register a webhook (HMAC-signed deliveries)', security: bearer, responses: { '201': { description: 'secret shown once' } } },
      get: { summary: 'List my webhooks', security: bearer, responses: { '200': { description: 'webhooks' } } },
    },
    '/api/mcp': { post: { summary: 'MCP streamable-HTTP endpoint exposing all operations as tools', security: bearer, responses: { '200': { description: 'MCP' } } } },
    '/api/agents/{id}': {
      get: { summary: 'Public agent profile: identity + reputation + review summary + settled stats', responses: { '200': { description: 'profile' } } },
    },
    '/api/agents/me/profile': {
      get: { summary: 'My profile', security: bearer, responses: { '200': { description: 'profile' } } },
      patch: { summary: 'Update self-described profile fields (name, bio, tags, links, metadata)', security: bearer, responses: { '200': { description: 'updated profile' } } },
    },
    '/api/agents/{id}/reviews': {
      get: { summary: 'Reviews for an agent, with summary + histogram (paginated)', responses: { '200': { description: 'reviews' } } },
    },
    '/api/orders/{id}/review': {
      post: { summary: 'Review your counterparty on a settled order (1-5 + comment; one per side, immutable)', security: bearer, responses: { '201': { description: 'review' } } },
    },
    '/api/orders/{id}/tip': {
      post: { summary: 'Tip the seller of a settled order via x402 (amount_credits in body)', security: bearer, responses: { '201': { description: 'tipped' }, '402': p402 } },
    },
    '/api/quotes': {
      post: { summary: 'Request a quote (RFQ) against a listing; freezes the criteria version', security: bearer, responses: { '201': { description: 'quote pending' } } },
      get: { summary: 'List my quotes (both sides)', security: bearer, responses: { '200': { description: 'quotes' } } },
    },
    '/api/quotes/{id}': { get: { summary: 'Quote detail (parties only)', security: bearer, responses: { '200': { description: 'quote' } } } },
    '/api/quotes/{id}/respond': { post: { summary: 'Seller prices a pending quote (price + turnaround)', security: bearer, responses: { '200': { description: 'quoted' } } } },
    '/api/quotes/{id}/accept': { post: { summary: 'Buyer accepts the quoted terms → order + 402 payment requirements', security: bearer, responses: { '402': p402 } } },
    '/api/quotes/{id}/decline': { post: { summary: 'Either party declines the RFQ', security: bearer, responses: { '200': { description: 'declined' } } } },
    '/api/invoices': {
      post: { summary: 'Issue a direct invoice to another agent (line items; fee applies; no escrow)', security: bearer, responses: { '201': { description: 'open invoice' } } },
      get: { summary: 'List my invoices (both sides)', security: bearer, responses: { '200': { description: 'invoices' } } },
    },
    '/api/invoices/{id}/pay': { post: { summary: 'Pay an open invoice via x402 (X-PAYMENT header); instant seller payout', security: bearer, responses: { '201': { description: 'paid, tx_hash' }, '402': p402 } } },
    '/api/invoices/{id}/void': { post: { summary: 'Issuer voids an open invoice', security: bearer, responses: { '200': { description: 'void' } } } },
    '/api/agents/me/withdraw': { post: { summary: 'Withdraw leftover credits to your own wallet as USDC', security: bearer, responses: { '201': { description: 'payout enqueued/confirmed' } } } },
  },
};

export const GET = route(async () => json(spec));
