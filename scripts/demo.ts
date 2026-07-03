/**
 * Full marketplace demo — two autonomous agents transacting over MCP with
 * x402 payments (mock rail in dev):
 *
 *   Terminal 1: npm run dev
 *   Terminal 2: npm run demo
 *
 * seller lists a service → buyer discovers it, pays the 402, escrow holds →
 * seller delivers with receipts → machine checks + judge panel verify →
 * settlement pays the seller's wallet minus the 10% fee.
 */
import { connectAgent, mockPaymentPayload, performService, SEED_LISTINGS, tool } from '../src/agents/reference';

const BASE = process.env.CLEARING_URL ?? 'http://localhost:3000';
const APP_SECRET = process.env.APP_SECRET ?? 'dev-secret';

function log(step: string, detail?: unknown): void {
  console.log(`\n▸ ${step}`);
  if (detail !== undefined) console.log(`  ${JSON.stringify(detail)}`);
}

async function main(): Promise<void> {
  console.log(`Clearing demo against ${BASE} (wallet identity + x402 payments)`);

  const seller = await connectAgent({ baseUrl: BASE, name: 'demo-seller' });
  const buyer = await connectAgent({ baseUrl: BASE, name: 'demo-buyer' });
  log('agents online via wallet-signature login', {
    seller: seller.wallet,
    buyer: buyer.wallet,
  });

  const listingSpec = SEED_LISTINGS[0]; // JSON → CSV (fully machine-verifiable)
  const created = await tool<{ id: string }>(seller, 'create_listing', listingSpec as never);
  log('seller published listing', { id: created.id, title: listingSpec.title });

  const quote = await tool<{ order_id: string; accepts: unknown[] }>(buyer, 'create_order', {
    listing_id: created.id,
    input_payload: { rows: [{ city: 'Zürich', pop: 415367 }, { city: 'Basel', pop: 178120 }] },
  });
  log('order intent → HTTP 402 with x402 payment requirements', {
    order: quote.order_id,
    requirements: quote.accepts?.[0],
  });

  await fetch(`${BASE}/api/dev/fund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-secret': APP_SECRET },
    body: JSON.stringify({ wallet_address: buyer.wallet, amount_credits: listingSpec.price_credits }),
  });
  const paid = await tool<{ state: string; tx_hash: string }>(buyer, 'pay_order', {
    order_id: quote.order_id,
    payment_payload: mockPaymentPayload(buyer.wallet),
  });
  log('buyer paid — USDC in escrow', { state: paid.state, tx_hash: paid.tx_hash });

  const detail = await tool<{ input_payload: Record<string, unknown> }>(seller, 'get_order', {
    id: quote.order_id,
  });
  const { artifact, receipts } = performService(listingSpec.title, detail.input_payload);
  const delivery = await tool<{ verdict: string }>(seller, 'submit_delivery', {
    order_id: quote.order_id,
    artifacts: [{ inline: artifact }],
    receipts,
  });
  log('seller delivered; machine checks + judge panel verdict', { verdict: delivery.verdict });

  const settled = await tool<{ state: string; settled_at: string; verification: unknown }>(
    buyer,
    'get_order',
    { id: quote.order_id },
  );
  log('order settled', {
    state: settled.state,
    settled_at: settled.settled_at,
    verification: settled.verification,
  });

  const sellerLedger = await tool<{ balance_credits: number; entries: Array<{ entry_type: string; amount: number; tx_hash?: string }> }>(
    seller,
    'get_balance',
  );
  const payout = (sellerLedger.entries ?? []).find((e) => e.entry_type === 'withdrawal');
  log('seller ledger (earnings auto-paid to wallet)', {
    remaining_credits: sellerLedger.balance_credits,
    payout,
  });

  const rep = await tool(seller, 'get_reputation', {
    agent_id: (await tool<{ agent_id: string }>(seller, 'get_balance')).agent_id,
  });
  log('seller reputation after settlement', rep);

  const evidence = await tool<{ ledger_entries: unknown[] }>(buyer, 'get_evidence_pack', {
    order_id: quote.order_id,
  });
  log('evidence pack exported', {
    ledger_entries: (evidence.ledger_entries ?? []).length,
  });

  // --- reviews, tips, profiles ----------------------------------------------
  const review = await tool(buyer, 'submit_review', {
    order_id: quote.order_id,
    rating: 5,
    comment: 'Fast, correct CSV. Would buy again.',
  });
  log('buyer reviewed the seller', review);

  await fetch(`${BASE}/api/dev/fund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-secret': APP_SECRET },
    body: JSON.stringify({ wallet_address: buyer.wallet, amount_credits: 50 }),
  });
  const tip = await tool(buyer, 'tip_order', {
    order_id: quote.order_id,
    amount_credits: 50,
    payment_payload: mockPaymentPayload(buyer.wallet),
  });
  log('buyer tipped the seller', tip);

  await tool(seller, 'update_profile', {
    name: 'CSVForge',
    bio: 'Deterministic JSON→CSV conversion with machine-verifiable contracts.',
    tags: ['csv', 'data'],
  });
  const sellerAgentId = (await tool<{ agent_id: string }>(seller, 'get_balance')).agent_id;
  const profile = await tool<{ reviews: unknown; reputation: { score: number } }>(
    buyer,
    'get_agent_profile',
    { agent_id: sellerAgentId },
  );
  log('seller public profile (trust product)', {
    reputation: profile.reputation,
    reviews: profile.reviews,
  });

  // --- RFQ + invoice paths ----------------------------------------------------
  const rfqListing = await tool<{ id: string }>(seller, 'create_listing', {
    title: 'Custom data pipeline (quote-priced)',
    description: 'Bespoke work — request a quote.',
    pricing_mode: 'quote',
    price_credits: 0,
    turnaround_seconds: 3600,
    acceptance_criteria: SEED_LISTINGS[0].acceptance_criteria,
  });
  const rfq = await tool<{ id: string }>(buyer, 'request_quote', {
    listing_id: rfqListing.id,
    input_payload: { rows: [{ a: 1 }] },
    message: 'Price for ~1k rows nightly?',
  });
  await tool(seller, 'respond_quote', {
    quote_id: rfq.id,
    price_credits: 750,
    turnaround_seconds: 1800,
    message: 'Nightly batch rate',
  });
  const accepted = await tool<{ order_id: string }>(buyer, 'accept_quote', { quote_id: rfq.id });
  await fetch(`${BASE}/api/dev/fund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-secret': APP_SECRET },
    body: JSON.stringify({ wallet_address: buyer.wallet, amount_credits: 750 }),
  });
  const rfqPaid = await tool<{ state: string }>(buyer, 'pay_order', {
    order_id: accepted.order_id,
    payment_payload: mockPaymentPayload(buyer.wallet),
  });
  log('RFQ flow: request → respond → accept → paid at quoted terms', {
    quote: rfq.id,
    order: accepted.order_id,
    state: rfqPaid.state,
  });

  const invoice = await tool<{ id: string }>(seller, 'create_invoice', {
    buyer_agent_id: (await tool<{ agent_id: string }>(buyer, 'get_balance')).agent_id,
    line_items: [{ description: 'schema consulting call', amount_credits: 300 }],
    memo: 'One-off consulting',
  });
  await fetch(`${BASE}/api/dev/fund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-secret': APP_SECRET },
    body: JSON.stringify({ wallet_address: buyer.wallet, amount_credits: 300 }),
  });
  const invoicePaid = await tool<{ status: string; tx_hash: string }>(buyer, 'pay_invoice', {
    invoice_id: invoice.id,
    payment_payload: mockPaymentPayload(buyer.wallet),
  });
  log('invoice issued and paid (direct billing, instant payout)', invoicePaid);

  await Promise.all([seller.close(), buyer.close()]);
  console.log(
    '\n✅ Full marketplace verified: fixed price, RFQ, invoice, tip, review, profile — all on x402.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
