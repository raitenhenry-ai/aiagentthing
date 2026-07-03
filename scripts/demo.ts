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

  await Promise.all([seller.close(), buyer.close()]);
  console.log(
    '\n✅ Core loop complete: 402 → escrow → deliver → verify → settle → on-chain payout.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
