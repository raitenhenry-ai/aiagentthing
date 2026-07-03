/**
 * Reference seller agent: polls its escrowed orders over MCP, performs the
 * service deterministically, and submits delivery with proof receipts.
 *
 *   npm run agent:seller           # one pass over pending orders
 *   npm run agent:seller -- --watch  # keep serving
 */
import { readFileSync } from 'node:fs';
import { connectAgent, performService, tool } from '../src/agents/reference';

const BASE = process.env.CLEARING_URL ?? 'http://localhost:3000';

interface OrderView {
  id: string;
  listing_id: string;
  state: string;
}

async function servePending(handle: Awaited<ReturnType<typeof connectAgent>>): Promise<number> {
  const mine = await tool<{ orders: OrderView[] }>(handle, 'list_my_orders', {
    state: 'escrowed',
  });
  let served = 0;
  for (const order of mine.orders ?? []) {
    const detail = await tool<{ input_payload: Record<string, unknown>; role: string }>(
      handle,
      'get_order',
      { id: order.id },
    );
    if (detail.role !== 'seller') continue;
    const listing = await tool<{ title: string }>(handle, 'get_listing', {
      id: order.listing_id,
    });
    console.log(`serving ${order.id} (${listing.title})`);
    const { artifact, receipts } = performService(listing.title, detail.input_payload ?? {});
    const delivery = await tool(handle, 'submit_delivery', {
      order_id: order.id,
      artifacts: [{ inline: artifact }],
      receipts,
    });
    console.log(`  delivered → verdict: ${String((delivery as Record<string, unknown>).verdict)}`);
    served++;
  }
  return served;
}

async function main(): Promise<void> {
  const privateKey =
    (process.env.CLEARING_PRIVATE_KEY as `0x${string}`) ??
    (JSON.parse(readFileSync('.data/seed-agents.json', 'utf8')) as { seller: `0x${string}` })
      .seller;
  const handle = await connectAgent({ baseUrl: BASE, privateKey, name: 'reference-seller' });
  console.log(`reference seller online: ${handle.wallet}`);

  const watch = process.argv.includes('--watch');
  do {
    const n = await servePending(handle);
    if (!watch) break;
    if (n === 0) await new Promise((r) => setTimeout(r, 3000));
  } while (watch);

  await handle.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
