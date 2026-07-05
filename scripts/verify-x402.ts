/**
 * Provision + verify the real x402 custody wallet, and check it's ready for
 * real money. Run after setting the payment env vars (locally with a .env,
 * or `railway run npx tsx scripts/verify-x402.ts` in production). Never
 * moves funds — a safe pre-flight, not a payment.
 *
 * Custody modes:
 *   • Self-custody (recommended): PLATFORM_PRIVATE_KEY = a Base wallet key
 *     (make one with `npm run wallet:new`). Inbound payments are verified
 *     and settled by the platform wallet itself (built-in facilitator) —
 *     no third-party accounts on testnet OR mainnet. Needs a little ETH
 *     for gas.
 *   • Coinbase CDP: CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET.
 */
import { createPublicClient, erc20Abi, formatEther, formatUnits, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { getRail } from '../src/lib/payments';

const USDC: Record<string, `0x${string}`> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};
const DEFAULT_RPC: Record<string, string> = {
  base: 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
};

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
  console.log(`network:     ${network}${network === 'base' ? '  (MAINNET — real money)' : '  (testnet)'}`);
  console.log(`custody:     ${selfCustody ? 'self-custody (built-in facilitator, no third-party accounts)' : 'Coinbase CDP server wallet'}`);
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

  // On-chain readiness: does the vault have gas (and any USDC)? Read-only.
  if (selfCustody) {
    const chain = network === 'base' ? base : baseSepolia;
    const rpc = process.env.BASE_RPC_URL ?? DEFAULT_RPC[network]!;
    try {
      const pub = createPublicClient({ chain, transport: http(rpc) });
      const address = reqs.payTo as `0x${string}`;
      const [eth, usdc] = await Promise.all([
        pub.getBalance({ address }),
        pub.readContract({ address: USDC[network]!, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
      ]);
      console.log(`  ETH (gas):              ${formatEther(eth)} ETH`);
      console.log(`  USDC held:              ${formatUnits(usdc as bigint, 6)} USDC`);
      if (eth === 0n) {
        console.log('\n⚠️  The vault has NO ETH — payouts and inbound settlement need gas.');
        console.log(network === 'base'
          ? '   Send ~$5 of ETH on Base to the address above (covers thousands of transfers).'
          : '   Get free Base Sepolia ETH from any faucet, sent to the address above.');
      } else {
        console.log('\n✅ vault has gas — ready to settle and pay out.');
      }
    } catch (e) {
      console.log(`\n⚠️  Could not read on-chain balances (${(e as Error).message.split('\n')[0]}).`);
      console.log('   This is normal in a sandboxed environment; run this command where the app');
      console.log('   is deployed (e.g. `railway run npx tsx scripts/verify-x402.ts`).');
    }
  }
  if (network === 'base-sepolia') {
    console.log('\nTest USDC: https://faucet.circle.com · test ETH: any Base Sepolia faucet.');
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
