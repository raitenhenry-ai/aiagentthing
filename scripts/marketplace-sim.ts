/**
 * Living-marketplace simulation. Autonomous agents behave like real sellers
 * and buyers, end to end:
 *
 *   • Sellers set up a profile, publish a service listing with machine-
 *     verifiable acceptance criteria, then run a work loop: pick up escrowed
 *     orders, ACTUALLY PERFORM the task, and upload the deliverable plus real
 *     proof-of-work receipts (input/output SHA-256, per-step log, timings).
 *   • Buyers browse the market, weigh price against seller reputation, order,
 *     pay the x402 402, wait for the judge/verifier verdict, then react like a
 *     real customer: inspect the result, leave a rating, tip when delighted,
 *     or — on a FAIL — decide whether to forgive-and-pay or take the refund.
 *   • One seller is deliberately sloppy to exercise the FAIL / dispute path.
 *   • A quote (RFQ) negotiation runs for custom-scoped work.
 *
 * Run:  npm run dev  (server)  →  npx tsx scripts/marketplace-sim.ts
 */
import { createHash } from 'node:crypto';
import { connectAgent, mockPaymentPayload, tool, type AgentHandle } from '../src/agents/reference';

const BASE = process.env.CLEARING_URL ?? 'http://localhost:3300';
const APP_SECRET = process.env.APP_SECRET ?? 'dev-secret';

// ── narration ──────────────────────────────────────────────────────────────
const t0 = Date.now();
function say(who: string, msg: string, data?: unknown): void {
  const ms = String(Date.now() - t0).padStart(5, ' ');
  const detail = data === undefined ? '' : `  ${JSON.stringify(data)}`;
  console.log(`[${ms}ms] ${who.padEnd(14)} ${msg}${detail}`);
}
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

async function fund(wallet: string, credits: number): Promise<void> {
  const res = await fetch(`${BASE}/api/dev/fund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-secret': APP_SECRET },
    body: JSON.stringify({ wallet_address: wallet, amount_credits: credits }),
  });
  if (!res.ok) throw new Error(`fund failed: ${res.status} ${await res.text()}`);
}

// ── the actual services sellers perform (real work, deterministic) ───────────
type Service = {
  key: string;
  title: string;
  description: string;
  price: number;
  sampleInput: () => Record<string, unknown>;
  criteria: unknown;
  /** Do the real work. `sloppy` seller path returns broken output. */
  perform: (input: Record<string, unknown>, sloppy?: boolean) => Record<string, unknown>;
};

function csvEscape(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const SERVICES = {
  csv: {
    key: 'csv',
    title: 'JSON → CSV conversion',
    description: 'Send rows as JSON objects; get back well-formed RFC-4180 CSV. Output: {csv, row_count}.',
    price: 200,
    sampleInput: () => ({
      rows: [
        { city: 'Zürich', pop: 415367, note: 'has, comma' },
        { city: 'Genève', pop: 201818, note: 'multi\nline' },
      ],
    }),
    criteria: {
      criteria: [
        { id: 'shape', type: 'schema', spec: { json_schema: { type: 'object', required: ['csv', 'row_count'], properties: { csv: { type: 'string' }, row_count: { type: 'integer' } } } } },
        { id: 'parses', type: 'programmatic', spec: { check: 'csv_parsable', params: { field: 'csv' } } },
      ],
      pass_rule: 'all',
    },
    perform: (input, sloppy) => {
      const rows = (input.rows as Array<Record<string, unknown>>) ?? [];
      const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const body = rows.map((r) => headers.map((h) => csvEscape(r[h])).join(',')).join('\n');
      const csv = sloppy ? `${headers.join(',')}\nbroken,row,with,too,many,cols` : `${headers.join(',')}\n${body}`;
      return { csv, row_count: rows.length };
    },
  },
  contacts: {
    key: 'contacts',
    title: 'Contact extraction (emails + URLs)',
    description: 'Send raw text; get every email and URL, deduplicated. Output: {emails, urls}.',
    price: 150,
    sampleInput: () => ({ text: 'Ping ops@acme.io or sales@acme.io — pricing at https://acme.io/pricing and https://acme.io/docs' }),
    criteria: {
      criteria: [
        { id: 'shape', type: 'schema', spec: { json_schema: { type: 'object', required: ['emails', 'urls'], properties: { emails: { type: 'array' }, urls: { type: 'array' } } } } },
      ],
      pass_rule: 'all',
    },
    perform: (input) => {
      const text = String(input.text ?? '');
      return {
        emails: [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])],
        urls: [...new Set(text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [])],
      };
    },
  },
  stats: {
    key: 'stats',
    title: 'Document stats (words, chars, reading time)',
    description: 'Send text; get {word_count, char_count, reading_seconds} (200 wpm).',
    price: 90,
    sampleInput: () => ({ text: 'The quick brown fox jumps over the lazy dog. '.repeat(12) }),
    criteria: {
      criteria: [
        { id: 'shape', type: 'schema', spec: { json_schema: { type: 'object', required: ['word_count', 'char_count', 'reading_seconds'], properties: { word_count: { type: 'integer' }, char_count: { type: 'integer' }, reading_seconds: { type: 'integer' } } } } },
      ],
      pass_rule: 'all',
    },
    perform: (input) => {
      const text = String(input.text ?? '');
      const words = (text.trim().match(/\S+/g) ?? []).length;
      return { word_count: words, char_count: text.length, reading_seconds: Math.round((words / 200) * 60) };
    },
  },
  tags: {
    key: 'tags',
    title: 'Keyword tagging',
    description: 'Send text; get the top deduplicated keyword tags. Output: {tags, count}.',
    price: 120,
    sampleInput: () => ({ text: 'agents hire agents escrow verify settle agents marketplace escrow trust' }),
    criteria: {
      criteria: [
        { id: 'shape', type: 'schema', spec: { json_schema: { type: 'object', required: ['tags', 'count'], properties: { tags: { type: 'array' }, count: { type: 'integer' } } } } },
      ],
      pass_rule: 'all',
    },
    perform: (input) => {
      const freq = new Map<string, number>();
      for (const w of String(input.text ?? '').toLowerCase().match(/[a-z]{3,}/g) ?? []) freq.set(w, (freq.get(w) ?? 0) + 1);
      const tags = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
      return { tags, count: tags.length };
    },
  },
} satisfies Record<string, Service>;

// ── a seller agent: profile → listing → work loop ───────────────────────────
interface Seller {
  name: string;
  handle: AgentHandle;
  agentId: string;
  listingId: string;
  service: Service;
  sloppy: boolean;
  served: number;
}

async function launchSeller(name: string, service: Service, opts?: { sloppy?: boolean; pricing?: 'fixed' | 'quote'; price?: number; bio?: string }): Promise<Seller> {
  const handle = await connectAgent({ baseUrl: BASE, name });
  const agentId = (await tool<{ agent_id: string }>(handle, 'get_balance')).agent_id;
  const price = opts?.price ?? service.price;
  await tool(handle, 'update_profile', {
    bio: opts?.bio ?? `${service.title} specialist. Fast, deterministic, proof-backed.`,
    tags: [service.key, 'automation', name],
    website: `https://${name}.example`,
  });
  const listing = await tool<{ id: string; error?: unknown }>(handle, 'create_listing', {
    title: opts?.pricing === 'quote' ? `${service.title} (custom / RFQ)` : service.title,
    description: service.description,
    pricing_mode: opts?.pricing ?? 'fixed',
    price_credits: opts?.pricing === 'quote' ? 0 : price,
    turnaround_seconds: 600,
    acceptance_criteria: service.criteria,
  });
  if (!listing.id) throw new Error(`${name} listing failed: ${JSON.stringify(listing)}`);
  say(name, `📋 listed "${service.title}" @ ${opts?.pricing === 'quote' ? 'RFQ' : price + ' cr'}${opts?.sloppy ? ' (cut-rate)' : ''}`, { listing: listing.id });
  return { name, handle, agentId, listingId: listing.id, service, sloppy: opts?.sloppy ?? false, served: 0 };
}

/** The seller's work loop: pick up escrowed orders, do the task, upload proof. */
async function sellerWorkLoop(seller: Seller, running: () => boolean): Promise<void> {
  while (running()) {
    const mine = await tool<{ orders: Array<{ id: string; listing_id: string }> }>(seller.handle, 'list_my_orders', { state: 'escrowed' });
    for (const o of mine.orders ?? []) {
      if (o.listing_id !== seller.listingId) continue;
      const detail = await tool<{ input_payload: Record<string, unknown>; role: string }>(seller.handle, 'get_order', { id: o.id });
      if (detail.role !== 'seller') continue;
      const started = Date.now();
      const input = detail.input_payload ?? {};
      const artifact = seller.service.perform(input, seller.sloppy);
      // Real proof-of-work receipts: what was done, and verifiable hashes.
      const receipts = [
        { step: 'received', input_sha256: sha(input), input_keys: Object.keys(input) },
        { step: 'performed', service: seller.service.key, engine: `${seller.name}-v1`, sloppy: seller.sloppy || undefined },
        { step: 'produced', output_sha256: sha(artifact), output_bytes: JSON.stringify(artifact).length, ms: Date.now() - started },
      ];
      const res = await tool<{ verdict?: string; error?: unknown }>(seller.handle, 'submit_delivery', {
        order_id: o.id,
        artifacts: [{ inline: artifact }],
        receipts,
      });
      seller.served++;
      say(seller.name, `🔧 did the work for ${o.id.slice(0, 10)} → verdict ${res.verdict ?? JSON.stringify(res.error)}`, { proof: sha(artifact) });
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}

// ── a buyer agent: browse → choose → buy → react ────────────────────────────
interface MarketListing { id: string; title: string; price_credits: number; seller_agent_id: string; seller_reputation?: number; pricing_mode: string }

async function buyerShops(name: string, want: string, opts?: { tipIfDelighted?: boolean; strategy?: 'quality' | 'bargain'; lenient?: boolean }): Promise<void> {
  const strategy = opts?.strategy ?? 'quality';
  const buyer = await connectAgent({ baseUrl: BASE, name });
  try {
    // Browse the market and shortlist sellers of the wanted service.
    const { listings } = await tool<{ listings: MarketListing[] }>(buyer, 'search_listings', { query: want });
    const candidates = (listings ?? []).filter((l) => l.pricing_mode === 'fixed' && l.title.toLowerCase().includes(want.toLowerCase()));
    if (candidates.length === 0) { say(name, `🔎 found no "${want}" sellers`); return; }
    // Buyers shop differently. Bargain-hunters chase the lowest price;
    // quality-seekers weight proven reputation and treat a higher price as a
    // quality signal when reputations are still unproven.
    if (strategy === 'bargain') {
      candidates.sort((a, b) => a.price_credits - b.price_credits || (b.seller_reputation ?? 0) - (a.seller_reputation ?? 0));
    } else {
      candidates.sort((a, b) => (b.seller_reputation ?? 0) - (a.seller_reputation ?? 0) || b.price_credits - a.price_credits);
    }
    const pick = candidates[0];
    if (!pick) { say(name, `🔎 no "${want}" seller to pick`); return; }
    say(name, `🛒 [${strategy}] compared ${candidates.length} "${want}" sellers → chose the ${pick.price_credits}cr one`, { rep: pick.seller_reputation });

    const service = Object.values(SERVICES).find((s) => pick.title.startsWith(s.title));
    const input = service ? service.sampleInput() : {};
    const order = await tool<{ order_id: string }>(buyer, 'create_order', { listing_id: pick.id, input_payload: input });
    await fund(buyer.wallet, pick.price_credits);
    await tool(buyer, 'pay_order', { order_id: order.order_id, payment_payload: mockPaymentPayload(buyer.wallet) });
    say(name, `💳 paid ${pick.price_credits}cr into escrow for ${order.order_id.slice(0, 10)}`);

    // Wait for the seller to deliver and the verifier to rule.
    let state = 'escrowed';
    let verification: { verdict?: string; tier?: string } | undefined;
    for (let i = 0; i < 120; i++) {
      const s = await tool<{ state: string; verification?: { verdict?: string; tier?: string } }>(buyer, 'get_order', { id: order.order_id });
      state = s.state; verification = s.verification;
      if (state === 'failed' || state.startsWith('settled')) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    if (state === 'settled_released') {
      say(name, `✅ got a PASS deliverable for ${order.order_id.slice(0, 10)} — reviewing`, { tier: verification?.tier });
      await tool(buyer, 'submit_review', { order_id: order.order_id, rating: 5, comment: `Exactly as specified. Verified ${verification?.tier}.` });
      if (opts?.tipIfDelighted) {
        await fund(buyer.wallet, 25);
        await tool(buyer, 'tip_order', { order_id: order.order_id, amount_credits: 25, payment_payload: mockPaymentPayload(buyer.wallet) });
        say(name, `🎁 delighted — tipped 25cr straight to the seller's wallet`);
      }
    } else if (state === 'failed') {
      // Real decision: forgive-and-pay, or reject and take the refund?
      say(name, `❌ delivery FAILED verification for ${order.order_id.slice(0, 10)} — deciding`, { verdict: verification?.verdict });
      if (opts?.lenient) {
        // A lenient buyer inspects the work; if it's roughly usable they pay.
        await tool(buyer, 'override_accept', { order_id: order.order_id });
        await tool(buyer, 'submit_review', { order_id: order.order_id, rating: 3, comment: 'Failed the automated check but I salvaged it. Paid anyway.' }).catch(() => {});
        say(name, `🤝 forgave the FAIL (override_accept) and left a 3★ review`);
      } else {
        // Strict buyer rejects. In prod this auto-refunds after the 48h window;
        // here we settle the refund immediately (admin timer stand-in) so the
        // marketplace shows the terminal state + an honest low review.
        await fetch(`${BASE}/api/admin/orders/${order.order_id}/refund`, { method: 'POST', headers: { 'x-app-secret': APP_SECRET } }).catch(() => {});
        const after = await tool<{ state: string }>(buyer, 'get_order', { id: order.order_id });
        if (after.state.startsWith('settled')) {
          await tool(buyer, 'submit_review', { order_id: order.order_id, rating: 1, comment: 'Delivery did not meet the spec. Refunded — would not buy again.' }).catch(() => {});
          say(name, `🔁 rejected → refunded (${after.state}); left a 1★ review`);
        } else {
          say(name, `⏳ refund pending (${after.state})`);
        }
      }
    } else {
      say(name, `⚠️ order stuck in ${state}`);
    }
  } finally {
    await buyer.close();
  }
}

// ── a quote (RFQ) negotiation between two agents ─────────────────────────────
async function rfqNegotiation(seller: Seller, buyerName: string): Promise<void> {
  const buyer = await connectAgent({ baseUrl: BASE, name: buyerName });
  try {
    const q = await tool<{ id?: string; error?: unknown }>(buyer, 'request_quote', {
      listing_id: seller.listingId,
      input_payload: seller.service.sampleInput(),
      note: 'Bulk recurring job — quote me your best per-run price.',
    });
    if (!q.id) { say(buyerName, `RFQ not available`, q); return; }
    say(buyerName, `📨 requested a quote from ${seller.name}`, { quote: q.id.slice(0, 10) });
    const quoted = Math.round(seller.service.price * 0.85); // seller offers a bulk discount
    await tool(seller.handle, 'respond_quote', { quote_id: q.id, price_credits: quoted, turnaround_seconds: 600 });
    say(seller.name, `💬 responded with a bulk price`, { price: quoted });
    const accepted = await tool<{ order_id?: string; error?: unknown }>(buyer, 'accept_quote', { quote_id: q.id });
    if (!accepted.order_id) { say(buyerName, `couldn't accept quote`, accepted); return; }
    await fund(buyer.wallet, quoted);
    await tool(buyer, 'pay_order', { order_id: accepted.order_id, payment_payload: mockPaymentPayload(buyer.wallet) });
    say(buyerName, `🤝 accepted the quote and paid ${quoted}cr`, { order: accepted.order_id.slice(0, 10) });
    // seller's work loop will pick it up and deliver.
    for (let i = 0; i < 120; i++) {
      const s = await tool<{ state: string }>(buyer, 'get_order', { id: accepted.order_id });
      if (s.state.startsWith('settled') || s.state === 'failed') { say(buyerName, `📦 RFQ order ${s.state}`); break; }
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    await buyer.close();
  }
}

// ── run the marketplace ──────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n══════════ Clearing marketplace simulation @ ${BASE} ══════════\n`);

  // 1) Sellers open up shop.
  say('SIM', '— sellers setting up shop —');
  const sellers = await Promise.all([
    launchSeller('data-forge', SERVICES.csv, { bio: 'Premium JSON→CSV. RFC-4180 correct, proof-backed, 100% pass rate.' }),
    launchSeller('linkscout', SERVICES.contacts),
    launchSeller('polyglot', SERVICES.stats),
    launchSeller('scribe', SERVICES.tags),
    // A tempting cut-rate competitor that cuts corners and fails verification.
    launchSeller('bargain-bin', SERVICES.csv, { sloppy: true, price: 120, bio: 'Cheapest CSV in town! (quality not guaranteed)' }),
    launchSeller('data-forge-pro', SERVICES.csv, { pricing: 'quote' }), // RFQ shop
  ]);

  // 2) Seller work loops run in the background for the whole session.
  let running = true;
  const loops = sellers.map((s) => sellerWorkLoop(s, () => running));

  // 3) Buyers arrive and shop — concurrently, like a real market. A mix of
  //    quality-seekers (pay for the proven seller) and bargain-hunters (chase
  //    the cheapest, and get burned by the cut-rate shop).
  say('SIM', '— first wave: quality-seekers and bargain-hunters —');
  await Promise.all([
    buyerShops('buyer-nimbus', 'JSON → CSV', { strategy: 'quality', tipIfDelighted: true }),
    buyerShops('buyer-quill', 'Contact extraction'),
    buyerShops('buyer-vertex', 'Document stats', { tipIfDelighted: true }),
    buyerShops('buyer-ember', 'Keyword tagging'),
    buyerShops('buyer-flux', 'JSON → CSV', { strategy: 'bargain' }),   // → cut-rate → FAIL → refund
    buyerShops('buyer-jade', 'JSON → CSV', { strategy: 'bargain', lenient: true }), // → FAIL → forgives
  ]);

  // 4) A second wave now that sellers have reputation + reviews. Word got
  //    around: these buyers all shop on reputation and steer to the good seller.
  say('SIM', '— second wave: buyers now shop on reputation & reviews —');
  await Promise.all([
    buyerShops('buyer-oxide', 'JSON → CSV', { strategy: 'quality', tipIfDelighted: true }),
    buyerShops('buyer-cobalt', 'Keyword tagging'),
    buyerShops('buyer-slate', 'JSON → CSV', { strategy: 'quality' }),
    buyerShops('buyer-onyx', 'Contact extraction', { tipIfDelighted: true }),
  ]);

  // 5) A quote negotiation for custom bulk work.
  say('SIM', '— RFQ negotiation —');
  const rfqShop = sellers.find((s) => s.name === 'data-forge-pro')!;
  await rfqNegotiation(rfqShop, 'buyer-atlas');

  // Let the loops drain any last deliveries.
  await new Promise((r) => setTimeout(r, 2500));
  running = false;
  await Promise.all(loops);

  // 6) Marketplace report.
  console.log('\n══════════ marketplace report ══════════\n');
  for (const s of sellers) {
    const bal = await tool<{ entries?: Array<{ entry_type: string; amount: number }> }>(s.handle, 'get_balance');
    const earned = (bal.entries ?? []).filter((e) => e.entry_type === 'escrow_release' || e.entry_type === 'override_payment' || e.entry_type === 'tip').reduce((n, e) => n + e.amount, 0);
    const rep = await tool<{ reputation?: { score?: number; pass_rate?: number }; reviews?: { review_count?: number; average_rating?: number | null } }>(s.handle, 'get_agent_profile', { agent_id: s.agentId }).catch(() => ({}) as Record<string, never>);
    const passRate = rep.reputation?.pass_rate;
    say(s.name, `served ${s.served} · earned ~${earned}cr · rep ${rep.reputation?.score ?? '—'} · pass ${passRate === undefined ? '—' : `${Math.round(passRate * 100)}%`} · ${rep.reviews?.review_count ?? 0} reviews (avg ${rep.reviews?.average_rating ?? '—'})`);
    await s.handle.close();
  }

  const health = await (await fetch(`${BASE}/api/admin/health`, { headers: { 'x-app-secret': APP_SECRET } })).json();
  console.log('\n── platform health ──');
  console.log(JSON.stringify({ ledger: health.ledger, orders: health.orders, payouts: health.payouts, reviews: health.reviews }, null, 2));
  const ok = health.ledger?.sum === 0 && health.ledger?.unbalanced_pairs === 0 && health.payouts?.failed === 0;
  console.log(`\nledger balances to zero: ${health.ledger?.sum === 0}  ·  fees earned: ${health.ledger?.fees_earned}  ·  invariants: ${ok ? 'OK ✅' : 'VIOLATED ❌'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
