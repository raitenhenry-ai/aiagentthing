/**
 * Phase 1 demo: the full core loop against a running dev server.
 *
 *   Terminal 1: npm run dev
 *   Terminal 2: npm run demo
 *
 * buyer agent purchases → escrow held → seller agent delivers with receipts
 * → stub judge panel verifies → funds settle to seller minus 10% fee.
 */

const BASE = process.env.CLEARING_URL ?? 'http://localhost:3000';
const APP_SECRET = process.env.APP_SECRET ?? 'dev-secret';

interface Json {
  [key: string]: unknown;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; key?: string; appSecret?: boolean } = {},
): Promise<Json> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.appSecret ? { 'x-app-secret': APP_SECRET } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = (await res.json()) as Json;
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function log(step: string, detail: unknown): void {
  console.log(`\n▸ ${step}`);
  console.log(`  ${JSON.stringify(detail)}`);
}

async function main(): Promise<void> {
  console.log(`Clearing Phase 1 demo against ${BASE}`);

  const account = await call('POST', '/api/accounts', {
    body: { email: `demo-${Date.now()}@clearing.dev` },
  });
  log('created human account', { id: account.id });

  const seller = await call('POST', '/api/agents', {
    body: { account_id: account.id, name: 'summarizer-agent', capabilities: ['seller'] },
  });
  const buyer = await call('POST', '/api/agents', {
    body: { account_id: account.id, name: 'research-agent', capabilities: ['buyer'] },
  });
  log('created agents', { seller: seller.id, buyer: buyer.id });

  await call('POST', '/api/dev/topup', {
    body: { agent_id: buyer.id, amount_credits: 10_000 },
    appSecret: true,
  });
  log('buyer topped up (dev credits — Stripe lands in Phase 3)', {
    balance: (await call('GET', '/api/agents/me/balance', { key: buyer.api_key as string }))
      .balance_credits,
  });

  const listing = await call('POST', '/api/listings', {
    key: seller.api_key as string,
    body: {
      title: 'Summarize a document with citations',
      description: 'Returns a faithful summary; every claim cites a section.',
      price_credits: 1000,
      turnaround_seconds: 3600,
      acceptance_criteria: {
        criteria: [
          {
            id: 'c1',
            type: 'schema',
            spec: { json_schema: { type: 'object', required: ['summary', 'citations'] } },
          },
          {
            id: 'c2',
            type: 'judged',
            spec: { requirement: 'Summary covers all sections of the input document' },
          },
        ],
        pass_rule: 'all',
      },
    },
  });
  log('seller published listing', { id: listing.id });

  const order = await call('POST', '/api/orders', {
    key: buyer.api_key as string,
    body: {
      listing_id: listing.id,
      input_payload: { document: 'Q3 report: revenue up 12%… (three sections)' },
    },
  });
  log('buyer purchased — credits held in escrow', {
    order: order.id,
    state: order.state,
    buyer_balance: (
      await call('GET', '/api/agents/me/balance', { key: buyer.api_key as string })
    ).balance_credits,
  });

  const delivery = await call('POST', `/api/orders/${order.id}/delivery`, {
    key: seller.api_key as string,
    body: {
      artifacts: [{ inline: { summary: 'Revenue rose 12%…', citations: ['§1', '§2', '§3'] } }],
      receipts: [
        { step: 'parsed input document', at: new Date().toISOString() },
        { step: 'generated summary + citations', at: new Date().toISOString() },
      ],
    },
  });
  log('seller delivered; judge panel verdict', { verdict: delivery.verdict });

  const settled = await call('GET', `/api/orders/${order.id}`, {
    key: buyer.api_key as string,
  });
  log('order settled', {
    state: settled.state,
    settled_at: settled.settled_at,
    verification: settled.verification,
  });

  const sellerBalance = await call('GET', '/api/agents/me/balance', {
    key: seller.api_key as string,
  });
  const buyerBalance = await call('GET', '/api/agents/me/balance', {
    key: buyer.api_key as string,
  });
  const reputation = await call('GET', `/api/agents/${seller.id}/reputation`);
  log('final balances (1000 escrowed → 900 to seller, 100 platform fee)', {
    seller: sellerBalance.balance_credits,
    buyer: buyerBalance.balance_credits,
  });
  log('seller reputation after settlement', reputation);

  console.log('\n✅ Core loop complete: purchase → escrow → deliver → verify → settle.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
