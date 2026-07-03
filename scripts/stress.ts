/**
 * End-to-end stress harness: hammers EVERY flow concurrently, repeatedly,
 * against a running dev server, and asserts the platform invariants (ledger
 * sums to zero, no unbalanced pairs, no stuck payouts) after every round.
 *
 *   npm run dev
 *   npx tsx scripts/stress.ts [rounds=3] [opsPerRound=30] [concurrency=8]
 *
 * Scenario mix per operation slot:
 *   - fixed-price happy path (order → pay → deliver → PASS → settle)
 *   - failing delivery → buyer override (accept-and-pay a FAIL)
 *   - RFQ: request → respond → accept → pay → deliver → settle
 *   - invoice: create → pay
 *   - tip + review on a settled order
 *   - withdrawal of surplus credits
 *   - adversarial: replayed payments, double-pay races, wrong-wallet
 *     payments, unauthorized access, oversized inputs — all must be rejected
 *     WITHOUT corrupting state.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const BASE = process.env.CLEARING_URL ?? 'http://localhost:3000';
const APP_SECRET = process.env.APP_SECRET ?? 'dev-secret';

let failures: string[] = [];

function check(cond: boolean, label: string): void {
  if (!cond) failures.push(label);
}

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
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

interface Agent {
  token: string;
  wallet: string;
  id: string;
}

async function login(name: string): Promise<Agent> {
  const account = privateKeyToAccount(generatePrivateKey());
  const ch = await api('POST', '/api/auth/challenge', { body: { wallet_address: account.address } });
  const signature = await account.signMessage({ message: ch.data.message as string });
  const v = await api('POST', '/api/auth/verify', {
    body: { wallet_address: account.address, nonce: ch.data.nonce, signature, name },
  });
  return {
    token: v.data.session_token as string,
    wallet: v.data.wallet_address as string,
    id: v.data.agent_id as string,
  };
}

function payment(wallet: string): string {
  return Buffer.from(
    JSON.stringify({ payer: wallet, nonce: `${Date.now()}-${Math.random().toString(16).slice(2)}` }),
  ).toString('base64');
}

async function fundWallet(wallet: string, credits: number): Promise<void> {
  await api('POST', '/api/dev/fund', {
    headers: { 'x-app-secret': APP_SECRET },
    body: { wallet_address: wallet, amount_credits: credits },
  });
}

const CRITERIA = {
  criteria: [
    { id: 'c1', type: 'schema', spec: { json_schema: { type: 'object', required: ['csv'] } } },
  ],
  pass_rule: 'all',
};

async function makeListing(seller: Agent, mode: 'fixed' | 'quote' = 'fixed'): Promise<string> {
  const res = await api('POST', '/api/listings', {
    token: seller.token,
    body: {
      title: `stress ${mode} service ${Math.random().toString(16).slice(2, 8)}`,
      pricing_mode: mode,
      price_credits: mode === 'fixed' ? 100 : 0,
      turnaround_seconds: 3600,
      acceptance_criteria: CRITERIA,
    },
  });
  check(res.status === 201, `listing create → ${res.status}`);
  return res.data.id as string;
}

// --- scenarios ---------------------------------------------------------------

async function scenarioHappyPath(seller: Agent, listingId: string): Promise<void> {
  const buyer = await login('s-buyer');
  const q = await api('POST', '/api/orders', {
    token: buyer.token,
    body: { listing_id: listingId, input_payload: { n: 1 } },
  });
  check(q.status === 402, `happy: quote → ${q.status}`);
  const orderId = q.data.order_id as string;
  await fundWallet(buyer.wallet, 100);
  const paid = await api('POST', `/api/orders/${orderId}/pay`, {
    token: buyer.token,
    headers: { 'x-payment': payment(buyer.wallet) },
  });
  check(paid.status === 201, `happy: pay → ${paid.status} ${JSON.stringify(paid.data)}`);
  const del = await api('POST', `/api/orders/${orderId}/delivery`, {
    token: seller.token,
    body: { artifacts: [{ inline: { csv: 'a\n1' } }], receipts: [{ step: 'x' }] },
  });
  check(del.status === 201 && del.data.verdict === 'PASS', `happy: deliver → ${del.status} ${del.data.verdict}`);
  const view = await api('GET', `/api/orders/${orderId}`, { token: buyer.token });
  check(view.data.state === 'settled_released', `happy: state → ${view.data.state}`);
}

async function scenarioFailAndOverride(seller: Agent, listingId: string): Promise<void> {
  const buyer = await login('s-buyer-fail');
  const q = await api('POST', '/api/orders', {
    token: buyer.token,
    body: { listing_id: listingId, input_payload: {} },
  });
  const orderId = q.data.order_id as string;
  await fundWallet(buyer.wallet, 100);
  await api('POST', `/api/orders/${orderId}/pay`, {
    token: buyer.token,
    headers: { 'x-payment': payment(buyer.wallet) },
  });
  // Deliverable that fails the machine check (no csv field).
  const del = await api('POST', `/api/orders/${orderId}/delivery`, {
    token: seller.token,
    body: { artifacts: [{ inline: { wrong: true } }], receipts: [] },
  });
  check(del.data.verdict === 'FAIL', `fail: verdict → ${del.data.verdict}`);
  // Seller cannot self-release; stranger cannot override.
  const stranger = await login('s-stranger');
  const strangerOverride = await api('POST', `/api/orders/${orderId}/override`, {
    token: stranger.token,
  });
  check(strangerOverride.status === 403 || strangerOverride.status === 404, `fail: stranger override → ${strangerOverride.status}`);
  // Buyer forgives.
  const override = await api('POST', `/api/orders/${orderId}/override`, { token: buyer.token });
  check(override.status === 200 && override.data.state === 'settled_override', `fail: override → ${override.status} ${override.data.state}`);
  // Review both ways after settlement.
  const r1 = await api('POST', `/api/orders/${orderId}/review`, {
    token: buyer.token,
    body: { rating: 3, comment: 'forgiven' },
  });
  check(r1.status === 201, `fail: review → ${r1.status}`);
}

async function scenarioRfq(seller: Agent): Promise<void> {
  const buyer = await login('s-rfq-buyer');
  const listingId = await makeListing(seller, 'quote');
  const rfq = await api('POST', '/api/quotes', {
    token: buyer.token,
    body: { listing_id: listingId, input_payload: { rows: 5 }, message: 'price?' },
  });
  check(rfq.status === 201, `rfq: request → ${rfq.status}`);
  const quoteId = rfq.data.id as string;
  const resp = await api('POST', `/api/quotes/${quoteId}/respond`, {
    token: seller.token,
    body: { price_credits: 250, turnaround_seconds: 1200 },
  });
  check(resp.status === 200, `rfq: respond → ${resp.status}`);
  const accept = await api('POST', `/api/quotes/${quoteId}/accept`, { token: buyer.token });
  check(accept.status === 402, `rfq: accept → ${accept.status}`);
  const orderId = accept.data.order_id as string;
  await fundWallet(buyer.wallet, 250);
  const paid = await api('POST', `/api/orders/${orderId}/pay`, {
    token: buyer.token,
    headers: { 'x-payment': payment(buyer.wallet) },
  });
  check(paid.status === 201, `rfq: pay → ${paid.status}`);
  const del = await api('POST', `/api/orders/${orderId}/delivery`, {
    token: seller.token,
    body: { artifacts: [{ inline: { csv: 'x\n9' } }], receipts: [] },
  });
  check(del.data.verdict === 'PASS', `rfq: deliver → ${del.data.verdict}`);
}

async function scenarioInvoiceTipWithdraw(seller: Agent, listingId: string): Promise<void> {
  const buyer = await login('s-inv-buyer');
  // Invoice.
  const inv = await api('POST', '/api/invoices', {
    token: seller.token,
    body: {
      buyer_agent_id: buyer.id,
      line_items: [{ description: 'consulting', amount_credits: 400 }],
      memo: 'stress invoice',
    },
  });
  check(inv.status === 201, `inv: create → ${inv.status}`);
  await fundWallet(buyer.wallet, 400);
  const paid = await api('POST', `/api/invoices/${inv.data.id}/pay`, {
    token: buyer.token,
    headers: { 'x-payment': payment(buyer.wallet) },
  });
  check(paid.status === 201 && paid.data.status === 'paid', `inv: pay → ${paid.status}`);
  // Double pay must fail.
  await fundWallet(buyer.wallet, 400);
  const again = await api('POST', `/api/invoices/${inv.data.id}/pay`, {
    token: buyer.token,
    headers: { 'x-payment': payment(buyer.wallet) },
  });
  check(again.status === 409, `inv: double pay → ${again.status}`);

  // Settled order for tip + review.
  const q = await api('POST', '/api/orders', {
    token: buyer.token,
    body: { listing_id: listingId, input_payload: {} },
  });
  const orderId = q.data.order_id as string;
  await fundWallet(buyer.wallet, 100);
  await api('POST', `/api/orders/${orderId}/pay`, {
    token: buyer.token,
    headers: { 'x-payment': payment(buyer.wallet) },
  });
  await api('POST', `/api/orders/${orderId}/delivery`, {
    token: seller.token,
    body: { artifacts: [{ inline: { csv: 'k\n2' } }], receipts: [] },
  });
  await fundWallet(buyer.wallet, 33);
  const tip = await api('POST', `/api/orders/${orderId}/tip`, {
    token: buyer.token,
    headers: { 'x-payment': payment(buyer.wallet) },
    body: { amount_credits: 33 },
  });
  check(tip.status === 201, `tip → ${tip.status}`);
  const review = await api('POST', `/api/orders/${orderId}/review`, {
    token: buyer.token,
    body: { rating: 5, comment: 'stress ok' },
  });
  check(review.status === 201, `review → ${review.status}`);
  const dup = await api('POST', `/api/orders/${orderId}/review`, {
    token: buyer.token,
    body: { rating: 1 },
  });
  check(dup.status === 409, `dup review → ${dup.status}`);

  // Withdrawal of surplus credits: overpaying scenario — fund + direct topup
  // path doesn't exist over API, so test the min-floor rejection instead.
  const wd = await api('POST', '/api/agents/me/withdraw', {
    token: buyer.token,
    body: { amount_credits: 1 },
  });
  check(wd.status === 422, `withdraw below min → ${wd.status}`);
}

async function scenarioAdversarial(seller: Agent, listingId: string): Promise<void> {
  const buyer = await login('s-adv-buyer');
  const mallory = await login('s-mallory');

  // Unauthorized: no token.
  const noAuth = await api('GET', '/api/orders');
  check(noAuth.status === 401, `adv: no auth → ${noAuth.status}`);

  // Order + double-pay RACE with two different payments.
  const q = await api('POST', '/api/orders', {
    token: buyer.token,
    body: { listing_id: listingId, input_payload: {} },
  });
  const orderId = q.data.order_id as string;
  await fundWallet(buyer.wallet, 300);
  const [p1, p2] = await Promise.all([
    api('POST', `/api/orders/${orderId}/pay`, {
      token: buyer.token,
      headers: { 'x-payment': payment(buyer.wallet) },
    }),
    api('POST', `/api/orders/${orderId}/pay`, {
      token: buyer.token,
      headers: { 'x-payment': payment(buyer.wallet) },
    }),
  ]);
  const successes = [p1, p2].filter((p) => p.status === 201).length;
  check(successes >= 1, `adv: double-pay race → ${p1.status}/${p2.status}`);
  // If both settled on-chain, the surplus must be withdrawable, not lost:
  const ledger = await api('GET', '/api/agents/me/ledger', { token: buyer.token });
  const balance = Number(ledger.data.balance_credits ?? 0);
  check(balance === (successes === 2 ? 100 : 0), `adv: surplus credits → ${balance} (successes=${successes})`);
  if (balance >= 100) {
    const wd = await api('POST', '/api/agents/me/withdraw', {
      token: buyer.token,
      body: { amount_credits: balance },
    });
    check(wd.status === 201, `adv: surplus withdrawal → ${wd.status}`);
  }

  // Replay: reuse an X-PAYMENT for another order.
  const header = payment(mallory.wallet);
  await fundWallet(mallory.wallet, 200);
  const qa = await api('POST', '/api/orders', {
    token: mallory.token,
    body: { listing_id: listingId, input_payload: {} },
  });
  await api('POST', `/api/orders/${qa.data.order_id}/pay`, {
    token: mallory.token,
    headers: { 'x-payment': header },
  });
  const qb = await api('POST', '/api/orders', {
    token: mallory.token,
    body: { listing_id: listingId, input_payload: {} },
  });
  const replay = await api('POST', `/api/orders/${qb.data.order_id}/pay`, {
    token: mallory.token,
    headers: { 'x-payment': header },
  });
  check(replay.status === 402, `adv: replay → ${replay.status}`);

  // Wrong wallet: mallory's payment for buyer's order.
  const qc = await api('POST', '/api/orders', {
    token: buyer.token,
    body: { listing_id: listingId, input_payload: {} },
  });
  await fundWallet(mallory.wallet, 100);
  const wrong = await api('POST', `/api/orders/${qc.data.order_id}/pay`, {
    token: buyer.token,
    headers: { 'x-payment': payment(mallory.wallet) },
  });
  check(wrong.status === 402, `adv: wrong wallet → ${wrong.status}`);

  // Stranger reading buyer's order.
  const peek = await api('GET', `/api/orders/${orderId}`, { token: mallory.token });
  check(peek.status === 404, `adv: stranger read → ${peek.status}`);

  // Malformed inputs.
  const bad = await api('POST', '/api/listings', {
    token: seller.token,
    body: { title: '', price_credits: -5, turnaround_seconds: 0, acceptance_criteria: {} },
  });
  check(bad.status === 422, `adv: malformed listing → ${bad.status}`);
  const badReview = await api('POST', `/api/orders/${orderId}/review`, {
    token: buyer.token,
    body: { rating: 9 },
  });
  check([409, 422].includes(badReview.status), `adv: rating 9 → ${badReview.status}`);
}

// --- driver -------------------------------------------------------------------

async function health(): Promise<Record<string, unknown>> {
  const res = await api('GET', '/api/admin/health', { headers: { 'x-app-secret': APP_SECRET } });
  return res.data;
}

async function main(): Promise<void> {
  const rounds = Number.parseInt(process.argv[2] ?? '3', 10);
  const ops = Number.parseInt(process.argv[3] ?? '30', 10);
  const concurrency = Number.parseInt(process.argv[4] ?? '8', 10);
  console.log(`stress: ${rounds} rounds × ${ops} ops @ concurrency ${concurrency} → ${BASE}`);

  const seller = await login('stress-seller');
  const fixedListing = await makeListing(seller, 'fixed');

  const scenarios: Array<() => Promise<void>> = [
    () => scenarioHappyPath(seller, fixedListing),
    () => scenarioFailAndOverride(seller, fixedListing),
    () => scenarioRfq(seller),
    () => scenarioInvoiceTipWithdraw(seller, fixedListing),
    () => scenarioAdversarial(seller, fixedListing),
  ];

  for (let round = 1; round <= rounds; round++) {
    failures = [];
    const started = Date.now();
    let next = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < ops) {
          const i = next++;
          const scenario = scenarios[i % scenarios.length]!;
          try {
            await scenario();
          } catch (e) {
            failures.push(`scenario ${i % scenarios.length} threw: ${String(e).slice(0, 200)}`);
          }
          done++;
        }
      }),
    );
    const h = await health();
    const ledger = h.ledger as Record<string, unknown>;
    const ok =
      h.ok === true &&
      Number(ledger.unbalanced_pairs) === 0 &&
      (h.payouts as Record<string, number>).failed === 0;
    console.log(
      `round ${round}: ${done} ops in ${Date.now() - started}ms · scenario failures: ${failures.length} · ` +
        `ledger sum=${ledger.sum} unbalanced=${ledger.unbalanced_pairs} escrow=${ledger.escrow_held} ` +
        `pending_payouts=${(h.payouts as Record<string, number>).pending} · invariants ${ok ? 'OK' : 'VIOLATED'}`,
    );
    for (const f of failures.slice(0, 8)) console.log(`   ✗ ${f}`);
    if (!ok) {
      console.log('   health:', JSON.stringify(h));
      process.exit(1);
    }
    if (failures.length > 0) process.exitCode = 1;
  }
  console.log(process.exitCode ? '\n❌ stress finished with scenario failures' : '\n✅ stress passed: all rounds, all invariants');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
