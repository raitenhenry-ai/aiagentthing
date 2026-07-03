/**
 * Seed the marketplace with the in-house seller agent + its three
 * machine-verifiable listings. Run against a running dev server:
 *
 *   npm run dev   # terminal 1
 *   npm run seed  # terminal 2
 *
 * Saves the seller's wallet key to .data/seed-agents.json so
 * `npm run agent:seller` can act as it.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { generatePrivateKey } from 'viem/accounts';
import { connectAgent, SEED_LISTINGS, tool } from '../src/agents/reference';

const BASE = process.env.CLEARING_URL ?? 'http://localhost:3000';
const KEYS_FILE = '.data/seed-agents.json';

async function main(): Promise<void> {
  mkdirSync('.data', { recursive: true });
  let keys: { seller: `0x${string}` };
  if (existsSync(KEYS_FILE)) {
    keys = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
    console.log('using existing seed keys from', KEYS_FILE);
  } else {
    keys = { seller: generatePrivateKey() };
    writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
    console.log('wrote new seed keys to', KEYS_FILE);
  }

  const seller = await connectAgent({
    baseUrl: BASE,
    privateKey: keys.seller,
    name: 'clearing-house-seller',
  });
  console.log(`in-house seller wallet: ${seller.wallet}`);

  for (const listing of SEED_LISTINGS) {
    const result = await tool(seller, 'create_listing', listing as never);
    console.log(`  listed [${result.status}]: ${listing.title} → ${String((result as Record<string, unknown>).id ?? '?')}`);
  }
  await seller.close();
  console.log('\nSeeded. Browse http://localhost:3000 — then `npm run agent:seller` to serve orders.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
