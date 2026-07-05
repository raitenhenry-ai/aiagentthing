/**
 * Provision + verify the real x402 custody wallet. Run after setting the
 * payment env vars (locally with a .env, or `railway run npx tsx
 * scripts/verify-x402.ts` in production). Never moves funds — a safe
 * pre-flight, not a payment.
 *
 * Two custody modes:
 *   • Self-custody (recommended): set PLATFORM_PRIVATE_KEY to a Base wallet
 *     key — the same kind of x402 wallet agents generate for themselves
 *     (make one with `npm run wallet:new`). No Coinbase account needed on
 *     base-sepolia; base mainnet still needs free CDP API keys (or an
 *     X402_FACILITATOR_URL) for inbound payment verification only.
 *   • Coinbase CDP: set CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET.
 */
import { getRail } from '../src/lib/payments';

function fail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log('\n── x402 custody pre-flight ──\n');

  if (process.env.PAYMENTS_MODE !== 'x402') {
    fail(`PAYMENTS_MODE is "${process.env.PAYMENTS_MODE ?? '(unset)'}", not "x402". Set PAYMENTS_MODE=x402 to use the real rail.`);
  }
  const network = process.env.X402_NETWORK ?? 'base-sepolia';
  const selfCustody = !!process.env.PLATFORM_PRIVATE_KEY;
  if (!selfCustody) {
    const missing = ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET'].filter((k) => !process.env[k]);
    if (missing.length) {
      fail(
        `No custody configured. Either set PLATFORM_PRIVATE_KEY (self-custody — generate one with \`npm run wallet:new\`), ` +
        `or CDP credentials (missing: ${missing.join(', ')}).`,
      );
    }
  }
  console.log(`network:   ${network}${network === 'base' ? '  (MAINNET — real money)' : '  (testnet)'}`);
  console.log(`custody:   ${selfCustody ? 'self-custody (PLATFORM_PRIVATE_KEY)' : 'Coinbase CDP server wallet'}`);
  if (network === 'base' && selfCustody && !process.env.CDP_API_KEY_ID && !process.env.X402_FACILITATOR_URL) {
    console.log('\n⚠️  base mainnet inbound payments verify through the Coinbase facilitator,');
    console.log('   which needs free CDP API keys (CDP_API_KEY_ID/SECRET) — or set X402_FACILITATOR_URL.');
    console.log('   Payouts + custody stay fully on your own key either way.');
  }
  console.log('\nresolving the custody wallet …');

  const rail = getRail();
  if (rail.network === 'mock') {
    fail('Rail resolved to mock despite PAYMENTS_MODE=x402 — check the process env.');
  }

  let reqs;
  try {
    reqs = await rail.buildRequirements({
      amountCredits: 100n,
      resource: '/preflight',
      description: 'x402 custody pre-flight (no funds move)',
    });
  } catch (e) {
    fail(`Custody wallet resolution failed: ${(e as Error).message}`);
  }

  console.log('\n✅ custody wallet is live\n');
  console.log(`  escrow wallet address:  ${reqs.payTo}`);
  console.log(`  network:                ${reqs.network}`);
  console.log(`  USDC asset:             ${reqs.asset}`);
  console.log('\nThis wallet receives escrowed order payments and pays out settlements.');
  if (selfCustody) {
    console.log('Fund it with a little ETH on this network for payout gas (~$5 covers thousands of transfers).');
  }
  if (network === 'base-sepolia') {
    console.log('Test USDC: https://faucet.circle.com · test ETH: any Base Sepolia faucet.');
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
