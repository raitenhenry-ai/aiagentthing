/**
 * Provision + verify the real x402 custody wallet. Run this once you've set
 * the CDP credentials (locally with a .env, or on Railway with
 * `railway run npx tsx scripts/verify-x402.ts`). It does the non-human half
 * of going live:
 *
 *   1. checks every required env var is present,
 *   2. provisions the `clearing-escrow` CDP server wallet (auto-created on
 *      first use — no manual key handling),
 *   3. prints its on-chain address + the USDC asset for the network,
 *   4. confirms the wallet answers, so you know custody is live before any
 *      real order flows through it.
 *
 * It never moves funds — it's a safe pre-flight, not a payment.
 */
import { getRail } from '../src/lib/payments';

const REQUIRED = ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET'] as const;

function fail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log('\n── x402 custody pre-flight ──\n');

  if (process.env.PAYMENTS_MODE !== 'x402') {
    fail(`PAYMENTS_MODE is "${process.env.PAYMENTS_MODE ?? '(unset)'}", not "x402". Set PAYMENTS_MODE=x402 to use the real rail.`);
  }
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    fail(`Missing CDP credentials: ${missing.join(', ')}. Get them at https://portal.cdp.coinbase.com → API Keys.`);
  }
  const network = process.env.X402_NETWORK ?? 'base-sepolia';
  const walletName = process.env.PLATFORM_WALLET_NAME ?? 'clearing-escrow';
  console.log(`network:        ${network}${network === 'base' ? '  (MAINNET — real money)' : '  (testnet)'}`);
  console.log(`wallet name:    ${walletName}`);
  console.log(`credentials:    all present ✓`);
  console.log('\nprovisioning the custody wallet via Coinbase CDP …');

  const rail = getRail();
  if (rail.network === 'mock') {
    fail('Rail resolved to mock despite PAYMENTS_MODE=x402 — check the process env.');
  }

  // buildRequirements() with no payTo triggers getOrCreateAccount() and
  // returns the custody wallet as payTo. This is what provisions the wallet.
  let reqs;
  try {
    reqs = await rail.buildRequirements({
      amountCredits: 100n,
      resource: '/preflight',
      description: 'x402 custody pre-flight (no funds move)',
    });
  } catch (e) {
    fail(`CDP call failed: ${(e as Error).message}\nCheck the API key/secret/wallet-secret are correct and the key has wallet permissions.`);
  }

  console.log('\n✅ custody wallet is live\n');
  console.log(`  escrow wallet address:  ${reqs.payTo}`);
  console.log(`  network:                ${reqs.network}`);
  console.log(`  USDC asset:             ${reqs.asset}`);
  console.log('\nThis wallet now receives escrowed order payments and pays out settlements.');
  if (network === 'base-sepolia') {
    console.log('Fund it with test USDC from https://faucet.circle.com (Base Sepolia) to try a live testnet order.');
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
