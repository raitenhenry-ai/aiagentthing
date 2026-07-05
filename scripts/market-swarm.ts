/**
 * Market swarm: 10 seller agents + 10 buyer agents running the ENTIRE
 * platform at once, over MCP, like a real economy:
 *
 *   sellers — profiles, portfolios (links/uploads/samples), 1–3 listings
 *             each (multi-service), work loops that read the order thread,
 *             perform the real task, deliver with proof receipts, reply to
 *             messages; one cut-rate sloppy seller (fails verification), one
 *             busy seller that declines with a reason, one RFQ-only shop.
 *   buyers  — search, compare price vs reputation, order (several attach a
 *             note + uploaded file), pay the 402, react to outcomes: 5★ +
 *             tips on PASS, refund + 1★ on sloppy FAILs, 2★ on declines;
 *             one negotiates an RFQ; one asks a pre-sale question and gets
 *             an answer before buying.
 *
 *   Server: npm run dev → APP_SECRET=dev-secret CLEARING_URL=... npx tsx scripts/market-swarm.ts
 */
import { createHash } from 'node:crypto';
import { connectAgent, mockPaymentPayload, tool, type AgentHandle } from '../src/agents/reference';

const BASE = process.env.CLEARING_URL ?? 'http://localhost:3003';
const APP_SECRET = process.env.APP_SECRET ?? 'dev-secret';

const t0 = Date.now();
function say(who: string, msg: string): void {
  console.log(`[${String(Date.now() - t0).padStart(6, ' ')}ms] ${who.padEnd(13)} ${msg}`);
}
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 12);

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 200)}` : ''}`);
  }
}

async function fund(wallet: string, credits: number): Promise<void> {
  const res = await fetch(`${BASE}/api/dev/fund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-secret': APP_SECRET },
    body: JSON.stringify({ wallet_address: wallet, amount_credits: credits }),
  });
  if (!res.ok) throw new Error(`fund failed: ${await res.text()}`);
}

// ── services (real deterministic work) ──────────────────────────────────────
function csvEscape(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
interface Service {
  key: string;
  title: string;
  price: number;
  criteria: unknown;
  input: () => Record<string, unknown>;
  perform: (input: Record<string, unknown>, sloppy?: boolean) => Record<string, unknown>;
}
const schema = (required: string[], props: Record<string, unknown>) => ({
  criteria: [{ id: 'shape', type: 'schema', spec: { json_schema: { type: 'object', required, properties: props } } }],
  pass_rule: 'all',
});
const SERVICES: Service[] = [
  {
    key: 'csv', title: 'JSON → CSV conversion', price: 200,
    criteria: {
      criteria: [
        { id: 'shape', type: 'schema', spec: { json_schema: { type: 'object', required: ['csv', 'row_count'], properties: { csv: { type: 'string' }, row_count: { type: 'integer' } } } } },
        { id: 'parses', type: 'programmatic', spec: { check: 'csv_parsable', params: { field: 'csv' } } },
      ],
      pass_rule: 'all',
    },
    input: () => ({ rows: [{ sku: 'A-1', qty: 3, note: 'fragile, keep flat' }, { sku: 'B-2', qty: 7, note: 'multi\nline' }] }),
    perform: (input, sloppy) => {
      const rows = (input.rows as Array<Record<string, unknown>>) ?? [];
      const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const body = rows.map((r) => headers.map((h) => csvEscape(r[h])).join(',')).join('\n');
      return { csv: sloppy ? 'a,b\n1,2,3,4,5' : `${headers.join(',')}\n${body}`, row_count: rows.length };
    },
  },
  {
    key: 'contacts', title: 'Contact extraction', price: 150,
    criteria: schema(['emails', 'urls'], { emails: { type: 'array' }, urls: { type: 'array' } }),
    input: () => ({ text: 'Write ops@vendor.io or ceo@vendor.io — docs at https://vendor.io/docs' }),
    perform: (input) => {
      const text = String(input.text ?? '');
      return { emails: [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])], urls: [...new Set(text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [])] };
    },
  },
  {
    key: 'stats', title: 'Document stats', price: 90,
    criteria: schema(['word_count', 'char_count'], { word_count: { type: 'integer' }, char_count: { type: 'integer' } }),
    input: () => ({ text: 'The quick brown fox jumps over the lazy dog. '.repeat(6) }),
    perform: (input) => {
      const text = String(input.text ?? '');
      return { word_count: (text.trim().match(/\S+/g) ?? []).length, char_count: text.length };
    },
  },
  {
    key: 'tags', title: 'Keyword tagging', price: 120,
    criteria: schema(['tags', 'count'], { tags: { type: 'array' }, count: { type: 'integer' } }),
    input: () => ({ text: 'escrow ledger settle verify escrow judge marketplace ledger' }),
    perform: (input) => {
      const freq = new Map<string, number>();
      for (const w of String(input.text ?? '').toLowerCase().match(/[a-z]{3,}/g) ?? []) freq.set(w, (freq.get(w) ?? 0) + 1);
      const tags = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
      return { tags, count: tags.length };
    },
  },
];
const svcByTitle = (title: string) => SERVICES.find((s) => title.startsWith(s.title));

// ── sellers ──────────────────────────────────────────────────────────────────
interface Seller {
  name: string;
  handle: AgentHandle;
  agentId: string;
  listingIds: string[];
  kind: 'honest' | 'sloppy' | 'decliner' | 'rfq';
  served: number;
  declined: number;
  replied: Set<string>;
}

const SELLER_SPECS: Array<{ name: string; services: number[]; kind: Seller['kind']; discount?: number }> = [
  { name: 'forge', services: [0], kind: 'honest' },
  { name: 'quill', services: [1], kind: 'honest' },
  { name: 'abacus', services: [2], kind: 'honest' },
  { name: 'lexicon', services: [3], kind: 'honest' },
  { name: 'omnibus', services: [0, 1, 2], kind: 'honest' },          // multi-service shop
  { name: 'nightowl', services: [3, 1], kind: 'honest' },            // multi-service shop
  { name: 'cutrate', services: [0], kind: 'sloppy', discount: 60 },  // cheap, broken output
  { name: 'swamped', services: [2], kind: 'decliner', discount: 30 },// cheap but declines all
  { name: 'bespoke', services: [0], kind: 'rfq' },                   // quote-priced
  { name: 'artisan', services: [3], kind: 'honest', discount: -30 }, // premium
];

async function launchSeller(spec: (typeof SELLER_SPECS)[number]): Promise<Seller> {
  const handle = await connectAgent({ baseUrl: BASE, name: spec.name });
  const agentId = (await tool<{ agent_id: string }>(handle, 'get_balance')).agent_id;
  await tool(handle, 'update_profile', {
    bio: `${spec.kind === 'sloppy' ? 'Cheapest in town!' : spec.kind === 'rfq' ? 'Bespoke pipelines, quote-priced.' : 'Deterministic, proof-backed work.'}`,
    tags: spec.services.map((i) => SERVICES[i]!.key),
  });
  // Every seller uploads a small portfolio before selling.
  await tool(handle, 'add_portfolio_item', {
    title: `${spec.name}: sample output`,
    sample: SERVICES[spec.services[0]!]!.perform(SERVICES[spec.services[0]!]!.input()),
  });
  await tool(handle, 'add_portfolio_item', {
    title: `${spec.name}: capabilities sheet`,
    url: `data:text/plain;base64,${Buffer.from(`services: ${spec.services.map((i) => SERVICES[i]!.title).join(', ')}`).toString('base64')}`,
  });
  const listingIds: string[] = [];
  for (const i of spec.services) {
    const svc = SERVICES[i]!;
    const created = await tool<{ id: string }>(handle, 'create_listing', {
      title: spec.kind === 'rfq' ? `${svc.title} (custom / RFQ)` : `${svc.title} — ${spec.name}`,
      description: `${svc.title} by ${spec.name}.`,
      pricing_mode: spec.kind === 'rfq' ? 'quote' : 'fixed',
      price_credits: spec.kind === 'rfq' ? 0 : svc.price - (spec.discount ?? 0),
      turnaround_seconds: 600,
      acceptance_criteria: svc.criteria,
    } as never);
    if (created.id) listingIds.push(created.id);
  }
  say(spec.name, `open: ${listingIds.length} listing(s), portfolio up [${spec.kind}]`);
  return { name: spec.name, handle, agentId, listingIds, kind: spec.kind, served: 0, declined: 0, replied: new Set() };
}

async function sellerLoop(s: Seller, running: () => boolean): Promise<void> {
  while (running()) {
    try {
      // Serve (or decline) escrowed orders on my listings.
      const mine = await tool<{ orders: Array<{ id: string; listing_id: string }> }>(s.handle, 'list_my_orders', { state: 'escrowed' });
      for (const o of mine.orders ?? []) {
        if (!s.listingIds.includes(o.listing_id)) continue;
        if (s.kind === 'decliner') {
          const r = await tool<{ state?: string }>(s.handle, 'decline_order', { order_id: o.id, reason: 'Queue is full this week — refunding you in full.' });
          if (r.state === 'settled_refund') { s.declined++; say(s.name, `declined ${o.id.slice(0, 10)}`); }
          continue;
        }
        const detail = await tool<{ input_payload: Record<string, unknown>; role: string }>(s.handle, 'get_order', { id: o.id });
        if (detail.role !== 'seller') continue;
        const listing = await tool<{ title: string }>(s.handle, 'get_listing', { id: o.listing_id });
        const svc = svcByTitle(listing.title);
        if (!svc) continue;
        const started = Date.now();
        const artifact = svc.perform(detail.input_payload ?? {}, s.kind === 'sloppy');
        const res = await tool<{ verdict?: string }>(s.handle, 'submit_delivery', {
          order_id: o.id,
          artifacts: [{ inline: artifact }],
          receipts: [
            { step: 'received', input_sha256: sha(detail.input_payload) },
            { step: 'produced', output_sha256: sha(artifact), ms: Date.now() - started },
          ],
        });
        s.served++;
        say(s.name, `served ${o.id.slice(0, 10)} → ${res.verdict}`);
      }
      // Answer unread messages once per counterparty.
      const inbox = await tool<{ conversations: Array<{ with_agent_id: string; unread: number }> }>(s.handle, 'list_conversations');
      for (const c of inbox.conversations ?? []) {
        if (c.unread > 0 && !s.replied.has(c.with_agent_id)) {
          await tool(s.handle, 'read_conversation', { with_agent_id: c.with_agent_id });
          await tool(s.handle, 'send_message', {
            to_agent_id: c.with_agent_id,
            body: `Thanks for reaching out — yes, happy to take the job. (auto-reply from ${s.name})`,
          });
          s.replied.add(c.with_agent_id);
        }
      }
    } catch (e) {
      say(s.name, `loop error: ${String(e).slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ── buyers ───────────────────────────────────────────────────────────────────
interface BuyerOutcome { name: string; released: number; refunded: number; overridden: number; declinedSeen: number }

async function buyerRun(name: string, wants: string[], opts: { strategy: 'quality' | 'bargain'; attach?: boolean; tip?: boolean; presale?: boolean; lenient?: boolean }): Promise<BuyerOutcome> {
  const b = await connectAgent({ baseUrl: BASE, name });
  const out: BuyerOutcome = { name, released: 0, refunded: 0, overridden: 0, declinedSeen: 0 };
  try {
    for (const want of wants) {
      const { listings } = await tool<{ listings: Array<{ id: string; title: string; price_credits: number; seller_agent_id: string; seller_reputation?: number; pricing_mode: string }> }>(b, 'search_listings', { query: want });
      const fixed = (listings ?? []).filter((l) => l.pricing_mode === 'fixed' && l.title.includes(want));
      if (fixed.length === 0) continue;
      fixed.sort(opts.strategy === 'bargain'
        ? (x, y) => x.price_credits - y.price_credits
        : (x, y) => (y.seller_reputation ?? 0) - (x.seller_reputation ?? 0) || y.price_credits - x.price_credits);
      const pick = fixed[0]!;

      // Optional pre-sale question → wait briefly for the seller's reply.
      if (opts.presale) {
        await tool(b, 'send_message', { to_agent_id: pick.seller_agent_id, body: `Before I order: can you handle ${want} today?` });
        let replied = false;
        for (let i = 0; i < 30 && !replied; i++) {
          const th = await tool<{ messages: Array<{ mine: boolean }> }>(b, 'read_conversation', { with_agent_id: pick.seller_agent_id });
          replied = (th.messages ?? []).some((m) => !m.mine);
          if (!replied) await new Promise((r) => setTimeout(r, 500));
        }
        check(`${name}: got a pre-sale reply`, replied);
        say(name, replied ? 'pre-sale question answered' : 'no pre-sale reply');
      }

      const svc = svcByTitle(pick.title);
      const orderArgs: Record<string, unknown> = { listing_id: pick.id, input_payload: svc ? svc.input() : {} };
      if (opts.attach) {
        orderArgs.message = 'Context attached — please follow the notes.';
        orderArgs.attachments = [{ name: 'notes.txt', url: `data:text/plain;base64,${Buffer.from(`notes for ${want}`).toString('base64')}` }];
      }
      const order = await tool<{ order_id: string }>(b, 'create_order', orderArgs);
      await fund(b.wallet, pick.price_credits);
      await tool(b, 'pay_order', { order_id: order.order_id, payment_payload: mockPaymentPayload(b.wallet) });
      say(name, `paid ${pick.price_credits}cr for "${pick.title}"`);

      let state = 'escrowed';
      for (let i = 0; i < 120; i++) {
        const st = await tool<{ state: string }>(b, 'get_order', { id: order.order_id });
        state = st.state;
        if (state === 'failed' || state.startsWith('settled')) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      if (state === 'settled_released') {
        out.released++;
        await tool(b, 'submit_review', { order_id: order.order_id, rating: 5, comment: 'Delivered exactly to spec.' });
        if (opts.tip) {
          await fund(b.wallet, 20);
          await tool(b, 'tip_order', { order_id: order.order_id, amount_credits: 20, payment_payload: mockPaymentPayload(b.wallet) });
        }
      } else if (state === 'settled_refund') {
        // Seller declined before delivering.
        out.declinedSeen++;
        await tool(b, 'submit_review', { order_id: order.order_id, rating: 2, comment: 'Declined my job — refunded quickly at least.' }).catch(() => {});
        say(name, 'job declined by seller, refunded');
      } else if (state === 'failed') {
        if (opts.lenient) {
          await tool(b, 'override_accept', { order_id: order.order_id });
          out.overridden++;
          await tool(b, 'submit_review', { order_id: order.order_id, rating: 3, comment: 'Failed checks but usable; paid anyway.' }).catch(() => {});
        } else {
          await fetch(`${BASE}/api/admin/orders/${order.order_id}/refund`, { method: 'POST', headers: { 'x-app-secret': APP_SECRET } }).catch(() => {});
          out.refunded++;
          await tool(b, 'submit_review', { order_id: order.order_id, rating: 1, comment: 'Broken delivery. Refunded.' }).catch(() => {});
          say(name, 'sloppy delivery FAILED → refunded, 1★');
        }
      } else {
        check(`${name}: order reached a terminal state`, false, state);
      }
    }
    return out;
  } finally {
    await b.close();
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n════════ market swarm: 10 sellers × 10 buyers @ ${BASE} ════════\n`);

  // Sellers in two batches of five (each is an MCP subprocess).
  const sellers: Seller[] = [];
  for (const half of [SELLER_SPECS.slice(0, 5), SELLER_SPECS.slice(5)]) {
    sellers.push(...(await Promise.all(half.map(launchSeller))));
  }
  check('all 10 sellers online with listings', sellers.length === 10 && sellers.every((s) => s.listingIds.length > 0));

  let running = true;
  const loops = sellers.map((s) => sellerLoop(s, () => running));

  // Buyers in two waves of five.
  say('SWARM', '— buyer wave 1 —');
  const wave1 = await Promise.all([
    buyerRun('b-hazel', ['JSON → CSV', 'Keyword tagging'], { strategy: 'quality', attach: true, tip: true }),
    buyerRun('b-rowan', ['Contact extraction', 'Document stats'], { strategy: 'quality' }),
    buyerRun('b-piper', ['JSON → CSV'], { strategy: 'bargain' }),                    // → cutrate → FAIL → refund
    buyerRun('b-sage', ['Document stats'], { strategy: 'bargain' }),                 // → swamped → declined
    buyerRun('b-indie', ['Keyword tagging', 'Contact extraction'], { strategy: 'quality', presale: true, attach: true }),
  ]);
  say('SWARM', '— buyer wave 2 (reputation now differentiates sellers) —');
  const wave2 = await Promise.all([
    buyerRun('b-cleo', ['JSON → CSV', 'Document stats'], { strategy: 'quality', tip: true }),
    buyerRun('b-arlo', ['JSON → CSV'], { strategy: 'bargain', lenient: true }),      // → cutrate → FAIL → override
    buyerRun('b-wren', ['Keyword tagging'], { strategy: 'quality', attach: true }),
    buyerRun('b-nico', ['Contact extraction', 'Keyword tagging'], { strategy: 'quality' }),
    buyerRun('b-vesper', ['Document stats'], { strategy: 'bargain' }),               // → swamped → declined
  ]);
  const outcomes = [...wave1, ...wave2];

  // RFQ negotiation with the bespoke shop.
  say('SWARM', '— RFQ negotiation —');
  const bespoke = sellers.find((s) => s.kind === 'rfq')!;
  const atlas = await connectAgent({ baseUrl: BASE, name: 'b-atlas' });
  try {
    const q = await tool<{ id?: string }>(atlas, 'request_quote', {
      listing_id: bespoke.listingIds[0]!,
      input_payload: SERVICES[0]!.input(),
      note: 'Recurring weekly batch — best price?',
    });
    if (q.id) {
      await tool(bespoke.handle, 'respond_quote', { quote_id: q.id, price_credits: 170, turnaround_seconds: 600 });
      const acc = await tool<{ order_id?: string }>(atlas, 'accept_quote', { quote_id: q.id });
      if (acc.order_id) {
        await fund(atlas.wallet, 170);
        await tool(atlas, 'pay_order', { order_id: acc.order_id, payment_payload: mockPaymentPayload(atlas.wallet) });
        let st = '';
        for (let i = 0; i < 90; i++) {
          st = (await tool<{ state: string }>(atlas, 'get_order', { id: acc.order_id })).state;
          if (st.startsWith('settled') || st === 'failed') break;
          await new Promise((r) => setTimeout(r, 500));
        }
        check('RFQ order settled', st === 'settled_released', st);
        say('b-atlas', `RFQ order ${st}`);
      }
    }
  } finally {
    await atlas.close();
  }

  await new Promise((r) => setTimeout(r, 2000));
  running = false;
  await Promise.all(loops);

  // ── report + assertions ────────────────────────────────────────────────────
  console.log('\n════════ swarm report ════════\n');
  const released = outcomes.reduce((n, o) => n + o.released, 0);
  const refunded = outcomes.reduce((n, o) => n + o.refunded, 0);
  const overridden = outcomes.reduce((n, o) => n + o.overridden, 0);
  const declinedSeen = outcomes.reduce((n, o) => n + o.declinedSeen, 0);
  console.log(`buyers: ${released} released · ${refunded} refunded(sloppy) · ${overridden} overridden · ${declinedSeen} declined-by-seller\n`);

  for (const s of sellers) {
    const prof = await tool<{ reputation?: { score?: number; pass_rate?: number }; reviews?: { review_count?: number; average_rating?: number | null }; portfolio?: unknown[] }>(
      s.handle, 'get_agent_profile', { agent_id: s.agentId },
    ).catch(() => ({}) as Record<string, never>);
    console.log(
      `  ${s.name.padEnd(10)} [${s.kind.padEnd(8)}] served ${String(s.served).padStart(2)} · declined ${s.declined} · rep ${prof.reputation?.score ?? '—'} · ` +
      `pass ${prof.reputation?.pass_rate === undefined ? '—' : Math.round((prof.reputation.pass_rate ?? 0) * 100) + '%'} · ` +
      `${prof.reviews?.review_count ?? 0} reviews (avg ${prof.reviews?.average_rating ?? '—'}) · portfolio ${(prof.portfolio ?? []).length}`,
    );
    await s.handle.close();
  }

  const health = await (await fetch(`${BASE}/api/admin/health`, { headers: { 'x-app-secret': APP_SECRET } })).json();
  console.log(`\nplatform: ${JSON.stringify(health.orders)} · reviews ${health.reviews} · agents ${health.agents}`);
  console.log(`ledger: sum ${health.ledger?.sum} · unbalanced ${health.ledger?.unbalanced_pairs} · fees ${health.ledger?.fees_earned} · failed payouts ${health.payouts?.failed}\n`);

  check('most orders settled PASS', released >= 10, released);
  check('sloppy seller produced FAIL(s)', refunded + overridden >= 2, { refunded, overridden });
  check('decliner declined jobs (buyers refunded)', declinedSeen >= 2, declinedSeen);
  check('ledger sums to zero', health.ledger?.sum === 0);
  check('no unbalanced pairs', health.ledger?.unbalanced_pairs === 0);
  check('zero fees taken', health.ledger?.fees_earned === 0);
  check('no failed payouts', health.payouts?.failed === 0);

  console.log(`═══ ${pass} checks passed, ${fail} failed ═══`);
  if (fail > 0) { console.log('Failures:', failures.join('; ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
