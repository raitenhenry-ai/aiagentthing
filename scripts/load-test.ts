/**
 * Load test the order state machine end-to-end over REST: N full loops
 * (login → list → 402 → pay → deliver → verify → settle) at bounded
 * concurrency against a running dev server.
 *
 *   npm run dev
 *   npx tsx scripts/load-test.ts 30 6   # 30 loops, 6 concurrent
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const BASE = process.env.CLEARING_URL ?? 'http://localhost:3000';
const APP_SECRET = process.env.APP_SECRET ?? 'dev-secret';

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function login(name: string): Promise<{ token: string; wallet: string }> {
  const account = privateKeyToAccount(generatePrivateKey());
  const ch = await api('POST', '/api/auth/challenge', { body: { wallet_address: account.address } });
  const signature = await account.signMessage({ message: ch.data.message as string });
  const v = await api('POST', '/api/auth/verify', {
    body: { wallet_address: account.address, nonce: ch.data.nonce, signature, name },
  });
  return { token: v.data.session_token as string, wallet: (v.data.wallet_address as string) };
}

function paymentPayload(wallet: string): string {
  return Buffer.from(
    JSON.stringify({ payer: wallet, nonce: Math.random().toString(16).slice(2) }),
  ).toString('base64');
}

async function oneLoop(listingId: string, price: number): Promise<number> {
  const start = Date.now();
  const buyer = await login('lt-buyer');
  const seller = { token: SELLER_TOKEN };

  const quote = await api('POST', '/api/orders', {
    token: buyer.token,
    body: { listing_id: listingId, input_payload: { rows: [{ a: 1 }] } },
  });
  if (quote.status !== 402) throw new Error(`quote: ${quote.status}`);
  const orderId = quote.data.order_id as string;

  await api('POST', '/api/dev/fund', {
    headers: { 'x-app-secret': APP_SECRET },
    body: { wallet_address: buyer.wallet, amount_credits: price },
  });
  const paid = await api('POST', `/api/orders/${orderId}/pay`, {
    token: buyer.token,
    headers: { 'x-payment': paymentPayload(buyer.wallet) },
  });
  if (paid.status !== 201) throw new Error(`pay: ${paid.status} ${JSON.stringify(paid.data)}`);

  const delivered = await api('POST', `/api/orders/${orderId}/delivery`, {
    token: seller.token,
    body: { artifacts: [{ inline: { csv: 'a\n1', row_count: 1 } }], receipts: [{ step: 'x' }] },
  });
  if (delivered.status !== 201) throw new Error(`deliver: ${delivered.status}`);

  const final = await api('GET', `/api/orders/${orderId}`, { token: buyer.token });
  if (final.data.state !== 'settled_released') throw new Error(`state: ${final.data.state}`);
  return Date.now() - start;
}

let SELLER_TOKEN = '';

async function main(): Promise<void> {
  const total = Number.parseInt(process.argv[2] ?? '20', 10);
  const concurrency = Number.parseInt(process.argv[3] ?? '5', 10);

  const seller = await login('lt-seller');
  SELLER_TOKEN = seller.token;
  const listing = await api('POST', '/api/listings', {
    token: seller.token,
    body: {
      title: 'Load-test CSV service',
      price_credits: 100,
      turnaround_seconds: 3600,
      acceptance_criteria: {
        criteria: [
          {
            id: 'c1',
            type: 'schema',
            spec: { json_schema: { type: 'object', required: ['csv'] } },
          },
        ],
        pass_rule: 'all',
      },
    },
  });
  const listingId = listing.data.id as string;

  const durations: number[] = [];
  const errors: string[] = [];
  let next = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) {
        next++;
        try {
          durations.push(await oneLoop(listingId, 100));
        } catch (e) {
          errors.push(String(e));
        }
      }
    }),
  );
  const wall = Date.now() - started;
  durations.sort((a, b) => a - b);
  const pct = (p: number) => durations[Math.floor((durations.length - 1) * p)] ?? 0;
  console.log(`\nloops: ${durations.length}/${total} ok, ${errors.length} failed`);
  console.log(`wall: ${wall}ms  throughput: ${((durations.length / wall) * 1000).toFixed(1)} loops/s`);
  console.log(`latency p50: ${pct(0.5)}ms  p95: ${pct(0.95)}ms  max: ${pct(1)}ms`);
  if (errors.length > 0) console.log('first error:', errors[0]);
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
