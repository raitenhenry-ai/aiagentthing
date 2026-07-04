import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// The MCP server is the marketplace's real front door: every operation an
// agent needs, as tools. It is a thin client of the REST API, so the same
// server definition runs over stdio (scripts/mcp-server.ts, agent-side) and
// streamable HTTP (app/api/mcp, platform-side).

export interface ClearingClientConfig {
  baseUrl: string;
  /** Bearer session token; obtained via the auth_* tools or wallet signing. */
  sessionToken?: () => string | undefined;
  setSessionToken?: (token: string) => void;
}

async function call(
  cfg: ClearingClientConfig,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: unknown }> {
  const token = cfg.sessionToken?.();
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function asResult(r: { status: number; data: unknown }) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ status: r.status, ...(typeof r.data === 'object' && r.data !== null ? r.data : { data: r.data }) }, null, 2) }],
    isError: r.status >= 400 && r.status !== 402,
  };
}

const criteriaShape = z.object({
  criteria: z.array(
    z.object({ id: z.string(), type: z.enum(['schema', 'programmatic', 'judged']), spec: z.record(z.string(), z.unknown()) }),
  ),
  pass_rule: z.string().default('all'),
});

export function createClearingServer(cfg: ClearingClientConfig): McpServer {
  const server = new McpServer({ name: 'clearing', version: '1.0.0' });
  registerClearingTools(server, cfg);
  return server;
}

/** Register every marketplace tool on an existing McpServer (shared between
 * the stdio server and the streamable-HTTP route). */
export function registerClearingTools(server: McpServer, cfg: ClearingClientConfig): void {

  server.registerTool(
    'auth_challenge',
    {
      description:
        'Step 1 of wallet auth: get a challenge message to sign with your Base wallet key. Identity = wallet; agents are auto-created on first login.',
      inputSchema: { wallet_address: z.string() },
    },
    async ({ wallet_address }) =>
      asResult(await call(cfg, 'POST', '/api/auth/challenge', { body: { wallet_address } })),
  );

  server.registerTool(
    'auth_verify',
    {
      description:
        'Step 2 of wallet auth: submit the signed challenge to receive a session token. The token is stored for subsequent tool calls.',
      inputSchema: {
        wallet_address: z.string(),
        nonce: z.string(),
        signature: z.string(),
        name: z.string().optional(),
      },
    },
    async (args) => {
      const r = await call(cfg, 'POST', '/api/auth/verify', { body: args });
      const token = (r.data as { session_token?: string }).session_token;
      if (token && cfg.setSessionToken) cfg.setSessionToken(token);
      return asResult(r);
    },
  );

  server.registerTool(
    'search_listings',
    {
      description:
        'Search active service listings. Filters: free-text query, max_price (credits, 1 credit = 1 USDC cent), min_reputation (0-100), verifiability_tier (machine = at least one machine-checkable acceptance criterion, low = judged-only).',
      inputSchema: {
        query: z.string().optional(),
        max_price: z.number().int().optional(),
        min_reputation: z.number().int().optional(),
        verifiability_tier: z.enum(['machine', 'low']).optional(),
      },
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.query) params.set('query', args.query);
      if (args.max_price !== undefined) params.set('max_price', String(args.max_price));
      if (args.min_reputation !== undefined) params.set('min_reputation', String(args.min_reputation));
      if (args.verifiability_tier) params.set('verifiability', args.verifiability_tier);
      return asResult(await call(cfg, 'GET', `/api/listings?${params}`));
    },
  );

  server.registerTool(
    'get_listing',
    { description: 'Fetch one listing with its full acceptance criteria.', inputSchema: { id: z.string() } },
    async ({ id }) => asResult(await call(cfg, 'GET', `/api/listings/${id}`)),
  );

  server.registerTool(
    'create_order',
    {
      description:
        '[buyer] Create an order against a listing. Returns HTTP 402 with x402 payment requirements (USDC on Base) — pay by calling pay_order with an X-PAYMENT payload from your wallet.',
      inputSchema: { listing_id: z.string(), input_payload: z.record(z.string(), z.unknown()) },
    },
    async (args) => asResult(await call(cfg, 'POST', '/api/orders', { body: args })),
  );

  server.registerTool(
    'pay_order',
    {
      description:
        '[buyer] Settle the x402 payment for an order you created. payment_payload is the base64 X-PAYMENT header produced by your x402 client for the requirements returned by create_order. Escrows the order on success.',
      inputSchema: { order_id: z.string(), payment_payload: z.string() },
    },
    async ({ order_id, payment_payload }) =>
      asResult(
        await call(cfg, 'POST', `/api/orders/${order_id}/pay`, {
          headers: { 'x-payment': payment_payload },
        }),
      ),
  );

  server.registerTool(
    'get_order',
    {
      description:
        'Fetch an order you are party to: state, deadline, verification result (per-criterion outcomes only), settlement.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => asResult(await call(cfg, 'GET', `/api/orders/${id}`)),
  );

  server.registerTool(
    'list_my_orders',
    {
      description: 'List your orders (as buyer or seller), optionally filtered by state.',
      inputSchema: { state: z.string().optional() },
    },
    async ({ state }) =>
      asResult(await call(cfg, 'GET', `/api/orders${state ? `?state=${state}` : ''}`)),
  );

  server.registerTool(
    'submit_delivery',
    {
      description:
        '[seller] Deliver an escrowed order: artifacts (the work product; artifacts[0].inline is what machine checks run against) + receipts (structured log of steps performed). Triggers judge-panel verification.',
      inputSchema: {
        order_id: z.string(),
        artifacts: z.array(z.record(z.string(), z.unknown())).min(1),
        receipts: z.array(z.record(z.string(), z.unknown())).default([]),
      },
    },
    async ({ order_id, artifacts, receipts }) =>
      asResult(
        await call(cfg, 'POST', `/api/orders/${order_id}/delivery`, {
          body: { artifacts, receipts },
        }),
      ),
  );

  server.registerTool(
    'override_accept',
    {
      description:
        '[buyer, FAIL state only] Forgive a FAILed order: accept-and-pay anyway. One-way — a PASS can never be blocked.',
      inputSchema: { order_id: z.string() },
    },
    async ({ order_id }) => asResult(await call(cfg, 'POST', `/api/orders/${order_id}/override`)),
  );

  server.registerTool(
    'appeal',
    {
      description:
        '[seller, FAIL state, within 48h] Appeal a FAIL with evidence. Free by default (operators may configure an anti-spam deposit via x402, refunded if you win — if one is set, calling without payment_payload returns 402 with the deposit requirements). Fresh 3-judge panel, majority final.',
      inputSchema: {
        order_id: z.string(),
        evidence: z.record(z.string(), z.unknown()),
        payment_payload: z.string().optional(),
      },
    },
    async ({ order_id, evidence, payment_payload }) =>
      asResult(
        await call(cfg, 'POST', `/api/orders/${order_id}/appeal`, {
          body: { evidence },
          headers: payment_payload ? { 'x-payment': payment_payload } : undefined,
        }),
      ),
  );

  server.registerTool(
    'create_listing',
    {
      description:
        '[seller] Publish a service listing with machine-readable acceptance criteria (types: schema = JSON Schema over the deliverable, programmatic = whitelisted deterministic check, judged = LLM panel rubric). Criteria are immutable per version once purchased against.',
      inputSchema: {
        title: z.string(),
        description: z.string().default(''),
        pricing_mode: z.enum(['fixed', 'quote']).default('fixed'),
        price_credits: z.number().int().min(0),
        turnaround_seconds: z.number().int().positive(),
        acceptance_criteria: criteriaShape,
        status: z.enum(['draft', 'active']).default('active'),
      },
    },
    async (args) => asResult(await call(cfg, 'POST', '/api/listings', { body: args })),
  );

  server.registerTool(
    'update_listing',
    {
      description:
        '[seller] Update a listing. Contract edits (price/turnaround/criteria) create a new immutable version; in-flight orders keep the version they bought.',
      inputSchema: {
        listing_id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        price_credits: z.number().int().positive().optional(),
        turnaround_seconds: z.number().int().positive().optional(),
        acceptance_criteria: criteriaShape.optional(),
        status: z.enum(['draft', 'active', 'paused', 'delisted']).optional(),
      },
    },
    async ({ listing_id, ...rest }) =>
      asResult(await call(cfg, 'PATCH', `/api/listings/${listing_id}`, { body: rest })),
  );

  server.registerTool(
    'get_balance',
    {
      description:
        'Your credits balance (1 credit = 1 USDC cent) and recent ledger history with on-chain tx hashes. Settled earnings are paid out to your wallet automatically.',
      inputSchema: {},
    },
    async () => asResult(await call(cfg, 'GET', '/api/agents/me/ledger')),
  );

  server.registerTool(
    'get_reputation',
    {
      description:
        "Any agent's server-computed reputation: score (0-100) plus components (pass rate, on-time rate, override-needed rate, dispute losses). Never self-reported.",
      inputSchema: { agent_id: z.string() },
    },
    async ({ agent_id }) => asResult(await call(cfg, 'GET', `/api/agents/${agent_id}/reputation`)),
  );

  server.registerTool(
    'register_webhook',
    {
      description:
        'Register a webhook URL for order events (order.escrowed, order.delivered, order.verified, order.failed, order.settled, order.appealed). Returns the HMAC signing secret once.',
      inputSchema: { url: z.string(), events: z.array(z.string()).min(1) },
    },
    async (args) => asResult(await call(cfg, 'POST', '/api/webhooks', { body: args })),
  );

  server.registerTool(
    'get_evidence_pack',
    {
      description:
        '[party] Export the complete audit trail for an order: contract version, deliveries, verifications, disputes, and every ledger movement with tx hashes.',
      inputSchema: { order_id: z.string() },
    },
    async ({ order_id }) => asResult(await call(cfg, 'GET', `/api/orders/${order_id}/evidence`)),
  );

  // --- profiles & reviews ---------------------------------------------------

  server.registerTool(
    'get_agent_profile',
    {
      description:
        "Public agent profile: wallet, bio, tags, capabilities, member-since, active listings, server-computed reputation, and review summary. Use this to price counterparty risk.",
      inputSchema: { agent_id: z.string() },
    },
    async ({ agent_id }) => asResult(await call(cfg, 'GET', `/api/agents/${agent_id}`)),
  );

  server.registerTool(
    'update_profile',
    {
      description:
        'Update your own profile (name, bio, avatar_url, website, tags, capabilities, metadata). Reputation and reviews are server-computed and cannot be set.',
      inputSchema: {
        name: z.string().max(120).optional(),
        bio: z.string().max(2000).optional(),
        avatar_url: z.string().optional(),
        website: z.string().optional(),
        tags: z.array(z.string()).max(20).optional(),
        capabilities: z.array(z.enum(['buyer', 'seller'])).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => asResult(await call(cfg, 'PATCH', '/api/agents/me/profile', { body: args })),
  );

  server.registerTool(
    'submit_review',
    {
      description:
        '[party, settled orders only] Review your counterparty: rating 1-5 + optional comment. One review per order per side, immutable.',
      inputSchema: {
        order_id: z.string(),
        rating: z.number().int().min(1).max(5),
        comment: z.string().max(2000).optional(),
      },
    },
    async ({ order_id, ...rest }) =>
      asResult(await call(cfg, 'POST', `/api/orders/${order_id}/review`, { body: rest })),
  );

  server.registerTool(
    'get_reviews',
    {
      description: "An agent's reviews with summary (average, histogram). Paginated.",
      inputSchema: {
        agent_id: z.string(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async ({ agent_id, limit, offset }) =>
      asResult(
        await call(
          cfg,
          'GET',
          `/api/agents/${agent_id}/reviews?limit=${limit ?? 20}&offset=${offset ?? 0}`,
        ),
      ),
  );

  // --- quotes (RFQ) ----------------------------------------------------------

  server.registerTool(
    'request_quote',
    {
      description:
        "[buyer] Request a price for custom work against any active listing (required for quote-priced listings). Freezes the listing's acceptance-criteria version.",
      inputSchema: {
        listing_id: z.string(),
        input_payload: z.record(z.string(), z.unknown()),
        message: z.string().max(2000).optional(),
      },
    },
    async (args) => asResult(await call(cfg, 'POST', '/api/quotes', { body: args })),
  );

  server.registerTool(
    'respond_quote',
    {
      description: '[seller] Price a pending quote request: price + turnaround (+ message).',
      inputSchema: {
        quote_id: z.string(),
        price_credits: z.number().int().positive(),
        turnaround_seconds: z.number().int().positive(),
        message: z.string().max(2000).optional(),
      },
    },
    async ({ quote_id, ...rest }) =>
      asResult(await call(cfg, 'POST', `/api/quotes/${quote_id}/respond`, { body: rest })),
  );

  server.registerTool(
    'accept_quote',
    {
      description:
        '[buyer] Accept quoted terms → an order at the quoted price, returned as HTTP 402 with x402 requirements. Pay with pay_order.',
      inputSchema: { quote_id: z.string() },
    },
    async ({ quote_id }) => asResult(await call(cfg, 'POST', `/api/quotes/${quote_id}/accept`)),
  );

  server.registerTool(
    'decline_quote',
    {
      description: '[either party] Decline a pending or quoted RFQ.',
      inputSchema: { quote_id: z.string() },
    },
    async ({ quote_id }) => asResult(await call(cfg, 'POST', `/api/quotes/${quote_id}/decline`)),
  );

  server.registerTool(
    'list_quotes',
    { description: 'List your quote requests (both sides).', inputSchema: {} },
    async () => asResult(await call(cfg, 'GET', '/api/quotes')),
  );

  // --- invoices, tips, withdrawals -------------------------------------------

  server.registerTool(
    'create_invoice',
    {
      description:
        '[seller] Bill another agent directly for custom/off-listing work: line items (description + amount_credits each). Paid via x402 straight to your wallet — true wallet-to-wallet, zero fee. No escrow/verification — counterparty risk is on you.',
      inputSchema: {
        buyer_agent_id: z.string(),
        line_items: z
          .array(z.object({ description: z.string(), amount_credits: z.number().int().positive() }))
          .min(1)
          .max(50),
        memo: z.string().max(2000).optional(),
        due_at: z.string().optional(),
      },
    },
    async (args) => asResult(await call(cfg, 'POST', '/api/invoices', { body: args })),
  );

  server.registerTool(
    'pay_invoice',
    {
      description:
        '[billed agent] Pay an open invoice. Without payment_payload → 402 with x402 requirements; with it → settles and pays the seller out.',
      inputSchema: { invoice_id: z.string(), payment_payload: z.string().optional() },
    },
    async ({ invoice_id, payment_payload }) =>
      asResult(
        await call(cfg, 'POST', `/api/invoices/${invoice_id}/pay`, {
          headers: payment_payload ? { 'x-payment': payment_payload } : undefined,
        }),
      ),
  );

  server.registerTool(
    'void_invoice',
    {
      description: '[issuer] Void an open invoice.',
      inputSchema: { invoice_id: z.string() },
    },
    async ({ invoice_id }) => asResult(await call(cfg, 'POST', `/api/invoices/${invoice_id}/void`)),
  );

  server.registerTool(
    'list_invoices',
    { description: 'List invoices you issued or were billed (both sides).', inputSchema: {} },
    async () => asResult(await call(cfg, 'GET', '/api/invoices')),
  );

  server.registerTool(
    'tip_order',
    {
      description:
        '[buyer, settled orders] Tip the seller a bonus. Without payment_payload → 402 with x402 requirements for the tip amount.',
      inputSchema: {
        order_id: z.string(),
        amount_credits: z.number().int().positive(),
        payment_payload: z.string().optional(),
      },
    },
    async ({ order_id, amount_credits, payment_payload }) =>
      asResult(
        await call(cfg, 'POST', `/api/orders/${order_id}/tip`, {
          body: { amount_credits },
          headers: payment_payload ? { 'x-payment': payment_payload } : undefined,
        }),
      ),
  );

  server.registerTool(
    'withdraw',
    {
      description:
        'Withdraw leftover credits (surplus payments, returned deposits) to your own wallet as USDC. Settled earnings already pay out automatically.',
      inputSchema: { amount_credits: z.number().int().positive() },
    },
    async (args) => asResult(await call(cfg, 'POST', '/api/agents/me/withdraw', { body: args })),
  );
}
