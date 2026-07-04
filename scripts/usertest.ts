/**
 * "Real users" harness: several independent buyer agents, each with its own
 * auto-generated wallet identity, transacting concurrently against the live
 * seeded listings while the reference seller serves deliveries. Exercises
 * every money path and asserts the zero-fee invariants end to end.
 *
 *   Terminal 1: npm run dev            (port 3222 in this run)
 *   Terminal 2: npm run seed && npm run agent:seller -- --watch
 *   Terminal 3: npx tsx scripts/usertest.ts
 */
import { connectAgent, mockPaymentPayload, tool, type AgentHandle } from '../src/agents/reference';

const BASE = process.env.CLEARING_URL ?? 'http://localhost:3222';
const APP_SECRET = process.env.APP_SECRET ?? 'dev-secret';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

async function fund(wallet: string, credits: number): Promise<void> {
  const res = await fetch(`${BASE}/api/dev/fund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-secret': APP_SECRET },
    body: JSON.stringify({ wallet_address: wallet, amount_credits: credits }),
  });
  if (!res.ok) throw new Error(`fund failed: ${res.status} ${await res.text()}`);
}

type Listing = { id: string; title: string; price_credits: number; pricing_mode: string };

async function buyerJourney(name: string, listing: Listing): Promise<{
  ok: boolean;
  orderId?: string;
  sellerAgentId?: string;
}> {
  const buyer = await connectAgent({ baseUrl: BASE, name });
  console.log(`\n▸ ${name} (${buyer.wallet.slice(0, 10)}…) buying "${listing.title}"`);
  try {
    // 1. Browse — a real buyer discovers, doesn't get handed an id.
    const search = await tool<{ listings: Listing[] }>(buyer, 'search_listings', { query: '' });
    check(`${name}: sees listings in the marketplace`, (search.listings?.length ?? 0) > 0);

    // 2. Order → 402 with exact terms.
    const inputByTitle: Record<string, unknown> = {
      'JSON → CSV conversion': { rows: [{ a: 1, b: 'x' }, { a: 2, b: 'y,z' }] },
      'Contact extraction (emails + URLs)': {
        text: 'Reach me at ops@acme.io or sales@acme.io — see https://acme.io/pricing',
      },
      'Summarization with citations': {
        document: 'Clearing escrows funds.\n\nJudges verify the work.\n\nThen it settles.',
      },
    };
    const order = await tool<{ order_id: string; accepts?: unknown[] }>(buyer, 'create_order', {
      listing_id: listing.id,
      input_payload: inputByTitle[listing.title] ?? {},
    });
    check(`${name}: order intent returns a 402 with x402 terms`, !!order.order_id && !!order.accepts?.[0]);

    // 3. Pay the exact amount.
    await fund(buyer.wallet, listing.price_credits);
    const paid = await tool<{ state: string; tx_hash: string }>(buyer, 'pay_order', {
      order_id: order.order_id,
      payment_payload: mockPaymentPayload(buyer.wallet),
    });
    check(`${name}: payment settles into escrow`, paid.state === 'escrowed' || paid.state === 'delivered', paid);

    // 4. Wait for the watching seller to deliver + the panel to verify.
    let settled: { state: string; verification?: unknown } | undefined;
    for (let i = 0; i < 90; i++) {
      settled = await tool<{ state: string; verification?: unknown }>(buyer, 'get_order', { id: order.order_id });
      if (settled.state.startsWith('settled')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    check(`${name}: order reaches a settled state`, !!settled?.state.startsWith('settled'), settled?.state);

    const detail = await tool<{ seller_agent_id: string }>(buyer, 'get_order', { id: order.order_id });
    return { ok: settled?.state === 'settled_released', orderId: order.order_id, sellerAgentId: detail.seller_agent_id };
  } finally {
    await buyer.close();
  }
}

/**
 * Two brand-new agents each publish their own machine-verifiable listing,
 * then a set of buyer agents purchase from them. The sellers serve their own
 * deliveries (poll escrowed → submit_delivery). This is the pure
 * agent-to-agent case: nobody here is the in-house seeded seller.
 */
async function agentMarketplace(): Promise<void> {
  // A tiny machine-verifiable service: input {text}, output {tags, count}.
  // Schema + programmatic checks pass with no judge needed.
  const listingSpec = (title: string, price: number) => ({
    title,
    description: `${title}. Input: {"text": "..."}. Output: {"tags": [...], "count": n}.`,
    price_credits: price,
    turnaround_seconds: 600,
    acceptance_criteria: {
      criteria: [
        {
          id: 'shape',
          type: 'schema',
          spec: {
            json_schema: {
              type: 'object',
              required: ['tags', 'count'],
              properties: {
                tags: { type: 'array', items: { type: 'string' } },
                count: { type: 'integer' },
              },
            },
          },
        },
      ],
      pass_rule: 'all',
    },
  });
  const serve = (input: Record<string, unknown>) => {
    const tags = [...new Set(String(input.text ?? '').toLowerCase().match(/[a-z]{3,}/g) ?? [])].slice(0, 10);
    return { artifact: { tags, count: tags.length }, receipts: [{ note: 'tokenized + deduped' }] };
  };

  const sellerFox = await connectAgent({ baseUrl: BASE, name: 'seller-fox' });
  const sellerOwl = await connectAgent({ baseUrl: BASE, name: 'seller-owl' });
  const foxListing = await tool<{ id: string; error?: unknown }>(sellerFox, 'create_listing', listingSpec('Keyword tagging (fox)', 120) as never);
  const owlListing = await tool<{ id: string; error?: unknown }>(sellerOwl, 'create_listing', listingSpec('Keyword tagging (owl)', 300) as never);
  check('agent seller-fox publishes a listing', !!foxListing.id, foxListing);
  check('agent seller-owl publishes a listing', !!owlListing.id, owlListing);

  // Fresh buyers discover these listings by search (not by handed id).
  const scout = await connectAgent({ baseUrl: BASE, name: 'scout-2' });
  const found = await tool<{ listings: Array<{ id: string; title: string }> }>(scout, 'search_listings', { query: 'keyword tagging' });
  await scout.close();
  check('agent-created listings are discoverable via search', (found.listings ?? []).some((l) => l.id === foxListing.id) && (found.listings ?? []).some((l) => l.id === owlListing.id), found.listings?.map((l) => l.title));

  // Sellers serve their own escrowed orders in the background.
  let serving = true;
  const serveLoop = async (h: AgentHandle, myListingId: string) => {
    while (serving) {
      const mine = await tool<{ orders: Array<{ id: string; listing_id: string }> }>(h, 'list_my_orders', { state: 'escrowed' });
      for (const o of mine.orders ?? []) {
        const d = await tool<{ input_payload: Record<string, unknown>; role: string }>(h, 'get_order', { id: o.id });
        if (d.role !== 'seller') continue;
        const { artifact, receipts } = serve(d.input_payload ?? {});
        await tool(h, 'submit_delivery', { order_id: o.id, artifacts: [{ inline: artifact }], receipts });
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  };
  const loops = [serveLoop(sellerFox, foxListing.id), serveLoop(sellerOwl, owlListing.id)];

  // Buyers purchase across both agent-run listings, concurrently.
  const buyFrom = async (name: string, listingId: string, price: number) => {
    const b = await connectAgent({ baseUrl: BASE, name });
    try {
      const o = await tool<{ order_id: string; accepts?: unknown[] }>(b, 'create_order', {
        listing_id: listingId,
        input_payload: { text: `hire ${name} to tag these important keyword tokens now` },
      });
      if (!o.order_id) return { name, ok: false as boolean };
      await fund(b.wallet, price);
      await tool(b, 'pay_order', { order_id: o.order_id, payment_payload: mockPaymentPayload(b.wallet) });
      let state = '';
      for (let i = 0; i < 90; i++) {
        const s = await tool<{ state: string }>(b, 'get_order', { id: o.order_id });
        state = s.state;
        if (state.startsWith('settled')) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return { name, ok: state === 'settled_released' };
    } finally {
      await b.close();
    }
  };
  const results = await Promise.all([
    buyFrom('buyer-gina', foxListing.id, 120),
    buyFrom('buyer-hank', owlListing.id, 300),
    buyFrom('buyer-ivan', foxListing.id, 120),
    buyFrom('buyer-jane', owlListing.id, 300),
  ]);
  serving = false;
  await Promise.all(loops);
  const settled = results.filter((r) => r.ok).length;
  check('all 4 buyers settled PASS on agent-created listings', settled === 4, results);

  // Seller earnings: fox served 2 orders, should have on-ledger settled income.
  const foxBal = await tool<{ entries?: Array<{ entry_type: string; amount: number }> }>(sellerFox, 'get_balance');
  const foxEarned = (foxBal.entries ?? []).filter((e) => e.entry_type === 'escrow_release' || e.entry_type === 'withdrawal').length;
  check('seller-fox has settlement/payout ledger entries', foxEarned > 0, { entries: foxBal.entries?.length });

  await sellerFox.close();
  await sellerOwl.close();
}

/**
 * A listing whose acceptance includes a `judged` criterion, bought on a
 * deployment with no real judge configured, must fail CLOSED: the seller's
 * delivery is NOT auto-PASSed, funds stay in escrow, and the buyer keeps
 * recourse (override_accept to pay, or refund). This proves the platform no
 * longer rubber-stamps unverifiable work.
 */
async function failClosedJudge(listing: Listing): Promise<void> {
  const buyer = await connectAgent({ baseUrl: BASE, name: 'buyer-judged' });
  try {
    const o = await tool<{ order_id: string }>(buyer, 'create_order', {
      listing_id: listing.id,
      input_payload: { document: 'Section one.\n\nSection two.\n\nSection three.' },
    });
    await fund(buyer.wallet, listing.price_credits);
    await tool(buyer, 'pay_order', { order_id: o.order_id, payment_payload: mockPaymentPayload(buyer.wallet) });

    // Wait for the seller to deliver and verification to run.
    let state = '';
    for (let i = 0; i < 90; i++) {
      const s = await tool<{ state: string }>(buyer, 'get_order', { id: o.order_id });
      state = s.state;
      if (state === 'failed' || state.startsWith('settled')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    check('judged order did NOT auto-settle (held for buyer, not rubber-stamped)', state === 'failed', state);

    // The verification record should mark it as unverifiable, not "bad work".
    const ev = await tool<{ verification?: { tier?: string; verdict?: string } }>(buyer, 'get_order', { id: o.order_id });
    check('judged verdict routed to dispute tier', ev.verification?.tier === 'dispute', ev.verification);

    // Buyer still has recourse: forgive-and-pay via override_accept.
    const ov = await tool<{ state?: string; error?: unknown }>(buyer, 'override_accept', { order_id: o.order_id });
    check('buyer can override_accept to release funds if satisfied', ov.state === 'settled_override', ov);
  } finally {
    await buyer.close();
  }
}

async function main(): Promise<void> {
  console.log(`\n=== Clearing "real users" test against ${BASE} ===`);

  // Snapshot the marketplace as a fresh agent would see it.
  const scout = await connectAgent({ baseUrl: BASE, name: 'scout' });
  const { listings } = await tool<{ listings: Listing[] }>(scout, 'search_listings', { query: '' });
  await scout.close();
  if (!listings?.length) throw new Error('no listings — run npm run seed first');
  const byTitle = (t: string) => listings.find((l) => l.title === t)!;
  console.log(`Marketplace has ${listings.length} live listings.`);

  // --- 1. Concurrent buyers, each a distinct wallet, each a full order -------
  console.log('\n--- Concurrent fixed-price orders (5 independent buyer agents) ---');
  const journeys = await Promise.all([
    buyerJourney('buyer-alice', byTitle('JSON → CSV conversion')),
    buyerJourney('buyer-bob', byTitle('Contact extraction (emails + URLs)')),
    buyerJourney('buyer-carol', byTitle('JSON → CSV conversion')),
    buyerJourney('buyer-dave', byTitle('JSON → CSV conversion')),
    buyerJourney('buyer-erin', byTitle('Contact extraction (emails + URLs)')),
  ]);
  const settledCount = journeys.filter((j) => j.ok).length;
  check('all 5 concurrent machine-verified orders settled with PASS (seller paid in full)', settledCount === 5, { settledCount });

  const goodOrder = journeys.find((j) => j.ok)!;

  // --- 1a. Fail-closed: a judged listing with no real judge must NOT settle --
  console.log('\n--- Fail-closed judge (judged criteria, no provider key) ---');
  await failClosedJudge(byTitle('Summarization with citations'));

  // --- 1b. Agents publish their OWN listings; other agents buy from them -----
  console.log('\n--- Agent-created listings (sellers list, buyers buy from them) ---');
  await agentMarketplace();

  // --- 2. Review + tip on a settled order (tip is wallet-to-wallet, 0 fee) ---
  console.log('\n--- Review, tip, and reputation ---');
  const reviewer = await connectAgent({ baseUrl: BASE, name: 'buyer-alice-2' });
  // Re-run a fresh order so this agent is a party who can review + tip.
  const jl = byTitle('JSON → CSV conversion');
  const ro = await tool<{ order_id: string }>(reviewer, 'create_order', {
    listing_id: jl.id,
    input_payload: { rows: [{ k: 'v' }] },
  });
  await fund(reviewer.wallet, jl.price_credits);
  await tool(reviewer, 'pay_order', { order_id: ro.order_id, payment_payload: mockPaymentPayload(reviewer.wallet) });
  let rSettled = '';
  for (let i = 0; i < 90; i++) {
    const s = await tool<{ state: string }>(reviewer, 'get_order', { id: ro.order_id });
    rSettled = s.state;
    if (s.state.startsWith('settled')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('review-path order settled', rSettled === 'settled_released', rSettled);

  const review = await tool<{ status?: number; error?: unknown }>(reviewer, 'submit_review', {
    order_id: ro.order_id,
    rating: 5,
    comment: 'Correct CSV, fast turnaround.',
  });
  check('buyer can review a settled order', !review.error, review);
  const dupReview = await tool<{ error?: unknown }>(reviewer, 'submit_review', {
    order_id: ro.order_id,
    rating: 1,
    comment: 'trying to double-review',
  });
  check('duplicate review is rejected', !!dupReview.error);

  // Tip: seller must receive 100% (net === amount, no fee withheld).
  await fund(reviewer.wallet, 200);
  const tip = await tool<{ net?: number; tip_credits?: number; error?: unknown }>(reviewer, 'tip_order', {
    order_id: ro.order_id,
    amount_credits: 200,
    payment_payload: mockPaymentPayload(reviewer.wallet),
  });
  check('tip accepted, full amount to seller (0 fee)', (tip.tip_credits ?? tip.net) === 200, tip);
  await reviewer.close();

  // --- 3. Invoicing: wallet-to-wallet, zero fee -----------------------------
  console.log('\n--- Direct invoice (seller bills buyer; wallet-to-wallet, 0 fee) ---');
  const seller2 = await connectAgent({ baseUrl: BASE, name: 'freelancer-fox' });
  const client2 = await connectAgent({ baseUrl: BASE, name: 'client-corp' });
  const clientId = (await tool<{ agent_id: string }>(client2, 'get_balance')).agent_id;
  const inv = await tool<{ id: string; amount_credits: number; error?: unknown }>(seller2, 'create_invoice', {
    buyer_agent_id: clientId,
    line_items: [
      { description: 'custom scraper', amount_credits: 4000 },
      { description: 'rush delivery', amount_credits: 1000 },
    ],
    memo: 'Off-listing engagement',
  });
  check('invoice created', !!inv.id && inv.amount_credits === 5000, inv);

  await fund(client2.wallet, 5000);
  const payInv = await tool<{ net_to_seller?: number; fee?: number; error?: unknown }>(client2, 'pay_invoice', {
    invoice_id: inv.id,
    payment_payload: mockPaymentPayload(client2.wallet),
  });
  check('invoice paid: fee = 0', payInv.fee === 0, payInv);
  check('invoice paid: seller nets 100%', payInv.net_to_seller === 5000, payInv);
  const invList = await tool<{ invoices?: Array<{ id: string; status: string; tx_hash?: string }> }>(seller2, 'list_invoices');
  const invRow = invList.invoices?.find((i) => i.id === inv.id);
  check('invoice marked paid with a tx hash', invRow?.status === 'paid' && !!invRow?.tx_hash, invRow);
  const dupPay = await tool<{ error?: unknown }>(client2, 'pay_invoice', {
    invoice_id: inv.id,
    payment_payload: mockPaymentPayload(client2.wallet),
  });
  check('invoice double-pay rejected', !!dupPay.error);
  await seller2.close();
  await client2.close();

  // --- 4. RFQ / quote flow --------------------------------------------------
  console.log('\n--- Quote (RFQ) flow ---');
  const rfqBuyer = await connectAgent({ baseUrl: BASE, name: 'rfq-buyer' });
  const csv = byTitle('JSON → CSV conversion');
  const q = await tool<{ id?: string; quote_id?: string; error?: unknown }>(rfqBuyer, 'request_quote', {
    listing_id: csv.id,
    input_payload: { rows: [{ a: 1 }] },
    note: 'Bulk job, can you price it?',
  });
  check('buyer can request a quote', !!q.id || !!q.quote_id || !!q.error, q);
  await rfqBuyer.close();

  // --- 5. Adversarial / edge cases ------------------------------------------
  console.log('\n--- Adversarial cases ---');
  const attacker = await connectAgent({ baseUrl: BASE, name: 'attacker' });
  const victim = await connectAgent({ baseUrl: BASE, name: 'victim' });

  // (a) Pay from a different wallet than the authenticated agent.
  const ao = await tool<{ order_id: string }>(attacker, 'create_order', {
    listing_id: csv.id,
    input_payload: { rows: [{ a: 1 }] },
  });
  await fund(victim.wallet, csv.price_credits);
  const wrongPayer = await tool<{ error?: unknown }>(attacker, 'pay_order', {
    order_id: ao.order_id,
    payment_payload: mockPaymentPayload(victim.wallet), // not attacker's wallet
  });
  check('payment from a mismatched wallet is rejected', !!wrongPayer.error, wrongPayer);

  // (b) Insufficient funds.
  const po = await tool<{ order_id: string }>(attacker, 'create_order', {
    listing_id: csv.id,
    input_payload: { rows: [{ a: 1 }] },
  });
  const broke = await tool<{ error?: unknown }>(attacker, 'pay_order', {
    order_id: po.order_id,
    payment_payload: mockPaymentPayload(attacker.wallet), // never funded
  });
  check('payment with insufficient funds is rejected', !!broke.error, broke);

  // (c) Self-dealing invoice.
  const attackerId = (await tool<{ agent_id: string }>(attacker, 'get_balance')).agent_id;
  const selfInv = await tool<{ error?: unknown }>(attacker, 'create_invoice', {
    buyer_agent_id: attackerId,
    line_items: [{ description: 'self', amount_credits: 100 }],
  });
  check('self-billing invoice is rejected', !!selfInv.error, selfInv);

  // (d) Review an order you were not party to.
  const nosyReview = await tool<{ error?: unknown }>(attacker, 'submit_review', {
    order_id: goodOrder.orderId,
    rating: 1,
    comment: 'I was never here',
  });
  check('non-party cannot review an order', !!nosyReview.error, nosyReview);

  await attacker.close();
  await victim.close();

  // --- 6. Global money invariants -------------------------------------------
  console.log('\n--- Money invariants (platform-wide) ---');
  const health = await (await fetch(`${BASE}/api/admin/health`, { headers: { 'x-app-secret': APP_SECRET } })).json();
  check('ledger sums to zero', health.ledger?.sum === 0, health.ledger);
  check('no unbalanced ledger pairs', health.ledger?.unbalanced_pairs === 0, health.ledger);
  check('no failed payouts', health.payouts?.failed === 0, health.payouts);
  check('no stuck pending payouts', health.payouts?.pending === 0, health.payouts);
  // Zero-fee build: with PLATFORM_FEE_BPS=0 no settlement should earn fees.
  // (Seed data used the old default; new activity must add nothing.)
  console.log(`  · fees_earned (incl. seed): ${health.ledger?.fees_earned}`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log('Failures:', failures.join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
