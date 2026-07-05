/**
 * Live agent smoke of the newest features, all together, over MCP:
 *   1. seller sets up a profile + PORTFOLIO (link, uploaded file, verified item)
 *   2. seller runs MULTIPLE SERVICES (three listings at once)
 *   3. buyer orders WITH A MESSAGE + FILE UPLOAD attached to the order
 *   4. seller reads the message (with attachment), does the work, delivers
 *   5. seller DECLINES a second job with a reason → buyer refunded + messaged
 *   6. buyer searches listings; both sides use conversations end-to-end
 *
 *   Server: npm run dev  →  CLEARING_URL=... npx tsx scripts/feature-smoke.ts
 */
import { connectAgent, mockPaymentPayload, tool } from '../src/agents/reference';

const BASE = process.env.CLEARING_URL ?? 'http://localhost:3002';
const APP_SECRET = process.env.APP_SECRET ?? 'dev-secret';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
}

async function fund(wallet: string, credits: number): Promise<void> {
  const res = await fetch(`${BASE}/api/dev/fund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-secret': APP_SECRET },
    body: JSON.stringify({ wallet_address: wallet, amount_credits: credits }),
  });
  if (!res.ok) throw new Error(`fund failed: ${await res.text()}`);
}

const LISTING = (title: string, price: number) => ({
  title,
  description: `${title}. Input {"text": "..."} → output {"tags": [...], "count": n}.`,
  pricing_mode: 'fixed',
  price_credits: price,
  turnaround_seconds: 600,
  acceptance_criteria: {
    criteria: [
      { id: 'shape', type: 'schema', spec: { json_schema: { type: 'object', required: ['tags', 'count'], properties: { tags: { type: 'array' }, count: { type: 'integer' } } } } },
    ],
    pass_rule: 'all',
  },
});

async function main(): Promise<void> {
  console.log(`\n=== feature smoke (portfolio · multi-service · order message+upload · decline) @ ${BASE} ===\n`);

  const seller = await connectAgent({ baseUrl: BASE, name: 'atelier' });
  const buyer = await connectAgent({ baseUrl: BASE, name: 'patron' });
  const sellerId = (await tool<{ agent_id: string }>(seller, 'get_balance')).agent_id;
  const buyerId = (await tool<{ agent_id: string }>(buyer, 'get_balance')).agent_id;

  // ── 1. multiple services ──────────────────────────────────────────────────
  console.log('-- seller opens shop with THREE services --');
  const l1 = await tool<{ id: string }>(seller, 'create_listing', LISTING('Keyword tagging — basic', 100) as never);
  const l2 = await tool<{ id: string }>(seller, 'create_listing', LISTING('Keyword tagging — pro', 300) as never);
  const l3 = await tool<{ id: string }>(seller, 'create_listing', LISTING('Keyword tagging — bulk', 800) as never);
  check('seller published 3 listings', !!l1.id && !!l2.id && !!l3.id);

  const search = await tool<{ listings: Array<{ id: string }> }>(buyer, 'search_listings', { query: 'keyword tagging' });
  check('buyer finds all 3 services via search', [l1.id, l2.id, l3.id].every((id) => (search.listings ?? []).some((l) => l.id === id)), search.listings?.length);

  const profile1 = await tool<{ active_listing_count?: number }>(buyer, 'get_agent_profile', { agent_id: sellerId });
  check('profile shows 3 active listings', profile1.active_listing_count === 3, profile1.active_listing_count);

  // ── 2. portfolio ──────────────────────────────────────────────────────────
  console.log('\n-- seller uploads work examples to its profile --');
  const upload = `data:image/png;base64,${Buffer.from('pretend-this-is-a-png').toString('base64')}`;
  const p1 = await tool<{ id?: string; error?: unknown }>(seller, 'add_portfolio_item', {
    title: 'Case study: 2M-row tagging pipeline',
    description: 'Built for an ecommerce catalog.',
    url: 'https://atelier.example/case-study',
  });
  const p2 = await tool<{ id?: string; error?: unknown }>(seller, 'add_portfolio_item', {
    title: 'Output screenshot',
    url: upload, // an uploaded file
  });
  const p3 = await tool<{ id?: string; error?: unknown }>(seller, 'add_portfolio_item', {
    title: 'Example output',
    sample: { tags: ['espresso', 'grinder'], count: 2 },
  });
  check('portfolio: link + uploaded file + inline sample added', !!p1.id && !!p2.id && !!p3.id, { p1, p2, p3 });

  const profile2 = await tool<{ portfolio?: Array<{ title: string; is_image: boolean }> }>(buyer, 'get_agent_profile', { agent_id: sellerId });
  check('buyer sees the portfolio on the profile (3 items)', (profile2.portfolio ?? []).length === 3, profile2.portfolio?.length);
  check('uploaded file detected as an image', profile2.portfolio?.some((p) => p.is_image) === true);

  // ── 3. order with message + upload ────────────────────────────────────────
  console.log('\n-- buyer orders WITH a note + file attached --');
  const csvUpload = `data:text/plain;base64,${Buffer.from('espresso grinder burr timer scale').toString('base64')}`;
  const order1 = await tool<{ order_id: string }>(buyer, 'create_order', {
    listing_id: l1.id,
    input_payload: { text: 'espresso grinder burr timer scale espresso' },
    message: 'Focus on coffee-gear terms; ignore stop-words. Source attached.',
    attachments: [{ name: 'source.txt', url: csvUpload }],
  });
  check('order created with message + attachment', !!order1.order_id);

  // Seller checks messages before touching the job.
  const inbox = await tool<{ conversations: Array<{ with_agent_id: string; unread: number }> }>(seller, 'list_conversations');
  check('seller inbox shows the buyer note as unread', inbox.conversations?.[0]?.unread === 1, inbox.conversations);
  const thread1 = await tool<{ messages: Array<{ body: string; order_id: string | null; attachments: Array<{ name: string; url: string }> }> }>(seller, 'read_conversation', { with_agent_id: buyerId });
  const note = thread1.messages?.[0];
  check('note is pinned to the order and carries the upload', note?.order_id === order1.order_id && note?.attachments?.[0]?.name === 'source.txt', note);
  const attachedText = note ? Buffer.from(note.attachments[0]!.url.split(',')[1]!, 'base64').toString() : '';
  check('seller can decode the uploaded file content', attachedText.includes('espresso'), attachedText);

  // Buyer pays; seller performs using the message + attachment as context.
  await fund(buyer.wallet, 100);
  await tool(buyer, 'pay_order', { order_id: order1.order_id, payment_payload: mockPaymentPayload(buyer.wallet) });
  const tags = [...new Set(attachedText.split(/\s+/))].slice(0, 8);
  const delivered = await tool<{ verdict?: string }>(seller, 'submit_delivery', {
    order_id: order1.order_id,
    artifacts: [{ inline: { tags, count: tags.length } }],
    receipts: [{ step: 'used buyer note + attachment', source: 'source.txt' }],
  });
  check('delivery PASSes using the uploaded source', delivered.verdict === 'PASS', delivered);

  // Showcase the settled job as a VERIFIED portfolio item.
  const p4 = await tool<{ id?: string; error?: unknown }>(seller, 'add_portfolio_item', {
    title: 'Verified: coffee-gear tagging job',
    sample: { tags, count: tags.length },
    order_id: order1.order_id,
  });
  check('settled order showcased as verified portfolio item', !!p4.id, p4);
  const profile3 = await tool<{ portfolio?: Array<{ verified: boolean }> }>(buyer, 'get_agent_profile', { agent_id: sellerId });
  check('profile shows the verified badge', profile3.portfolio?.some((p) => p.verified) === true);

  // ── 4. seller declines a job ──────────────────────────────────────────────
  console.log('\n-- seller declines a second job (with reason) --');
  const order2 = await tool<{ order_id: string }>(buyer, 'create_order', {
    listing_id: l3.id,
    input_payload: { text: 'a bulk job the seller will turn down' },
  });
  await fund(buyer.wallet, 800);
  await tool(buyer, 'pay_order', { order_id: order2.order_id, payment_payload: mockPaymentPayload(buyer.wallet) });
  const buyerLedgerBefore = await tool<{ balance_credits: number }>(buyer, 'get_balance');

  const declined = await tool<{ state?: string; error?: unknown }>(seller, 'decline_order', {
    order_id: order2.order_id,
    reason: 'Bulk queue is full this week — sorry!',
  });
  check('seller declined → settled_refund', declined.state === 'settled_refund', declined);

  const o2 = await tool<{ state: string }>(buyer, 'get_order', { id: order2.order_id });
  check('buyer sees the order refunded', o2.state === 'settled_refund', o2.state);
  const thread2 = await tool<{ messages: Array<{ body: string; order_id: string | null }> }>(buyer, 'read_conversation', { with_agent_id: sellerId });
  check('decline reason arrived as a message on the order', thread2.messages?.some((m) => m.body.includes('Bulk queue is full') && m.order_id === order2.order_id), thread2.messages?.map((m) => m.body));
  void buyerLedgerBefore;

  // A declined seller cannot decline twice / decline settled orders.
  const again = await tool<{ error?: unknown }>(seller, 'decline_order', { order_id: order2.order_id });
  check('double-decline rejected', !!again.error);

  // Buyer cannot decline (wrong role).
  const order3 = await tool<{ order_id: string }>(buyer, 'create_order', { listing_id: l2.id, input_payload: { text: 'x' } });
  await fund(buyer.wallet, 300);
  await tool(buyer, 'pay_order', { order_id: order3.order_id, payment_payload: mockPaymentPayload(buyer.wallet) });
  const wrongRole = await tool<{ error?: unknown }>(buyer, 'decline_order', { order_id: order3.order_id });
  check('buyer cannot decline a job', !!wrongRole.error);

  // ── verdict ───────────────────────────────────────────────────────────────
  const health = await (await fetch(`${BASE}/api/admin/health`, { headers: { 'x-app-secret': APP_SECRET } })).json();
  check('ledger sums to zero', health.ledger?.sum === 0, health.ledger);
  check('no failed payouts', health.payouts?.failed === 0);

  await seller.close();
  await buyer.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) { console.log('Failures:', failures.join('; ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
