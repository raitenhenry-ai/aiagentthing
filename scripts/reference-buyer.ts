/**
 * Reference buyer agent: searches the marketplace over MCP, buys a service
 * through the x402 flow, and reports the settled result.
 *
 *   npm run agent:buyer -- "csv"
 *
 * Dev/mock rail only funds via /api/dev/fund; on Base the wallet just needs
 * USDC and an x402 client.
 */
import { connectAgent, mockPaymentPayload, tool } from '../src/agents/reference';

const BASE = process.env.CLEARING_URL ?? 'http://localhost:3000';
const APP_SECRET = process.env.APP_SECRET ?? 'dev-secret';

const INPUTS: Record<string, Record<string, unknown>> = {
  csv: { rows: [{ name: 'ada', score: 99 }, { name: 'grace', score: 97 }] },
  contact: { text: 'Reach ada@lovelace.dev or https://analytical.engine — grace@hopper.navy too.' },
  summar: { document: 'Q3 revenue grew 12%.\n\nCosts fell 3% on infra savings.\n\nOutlook: cautious.' },
};

async function main(): Promise<void> {
  const query = process.argv[2] ?? 'csv';
  const buyer = await connectAgent({ baseUrl: BASE, name: 'reference-buyer' });
  console.log(`reference buyer online: ${buyer.wallet}`);

  const found = await tool<{ listings: Array<{ id: string; title: string; price_credits: number }> }>(
    buyer,
    'search_listings',
    { query },
  );
  const listing = found.listings?.[0];
  if (!listing) throw new Error(`no listing matches "${query}" — run npm run seed first`);
  console.log(`buying: ${listing.title} for ${listing.price_credits} credits`);

  const inputKey = Object.keys(INPUTS).find((k) => listing.title.toLowerCase().includes(k)) ?? 'csv';
  const quote = await tool<{ order_id: string }>(buyer, 'create_order', {
    listing_id: listing.id,
    input_payload: INPUTS[inputKey],
  });
  console.log(`order ${quote.order_id} quoted — funding wallet + paying the 402…`);

  // Mock chain funding (dev). On Base: skip this, your wallet holds USDC.
  await fetch(`${BASE}/api/dev/fund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-secret': APP_SECRET },
    body: JSON.stringify({ wallet_address: buyer.wallet, amount_credits: listing.price_credits }),
  });

  const paid = await tool(buyer, 'pay_order', {
    order_id: quote.order_id,
    payment_payload: mockPaymentPayload(buyer.wallet),
  });
  console.log(`escrowed (tx ${String((paid as Record<string, unknown>).tx_hash)}) — waiting for delivery…`);

  for (let i = 0; i < 60; i++) {
    const order = await tool<{ state: string; verification: unknown }>(buyer, 'get_order', {
      id: quote.order_id,
    });
    if (order.state.startsWith('settled') || order.state === 'failed') {
      console.log(`final state: ${order.state}`);
      console.log('verification:', JSON.stringify(order.verification, null, 2));
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await buyer.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
