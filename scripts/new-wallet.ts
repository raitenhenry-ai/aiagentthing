/**
 * Generate a fresh Base wallet — the same kind of x402 account agents make
 * for themselves. Use it as the platform's self-custody escrow wallet:
 *
 *   npm run wallet:new
 *   → set PLATFORM_PRIVATE_KEY to the printed key (keep it secret!)
 *   → the printed address is your vault: fund it with a little ETH for gas.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
console.log('\nNew Base wallet (x402 account):\n');
console.log(`  address:              ${account.address}`);
console.log(`  PLATFORM_PRIVATE_KEY: ${pk}`);
console.log('\nKeep the key secret — anyone holding it controls the funds.');
console.log('Set it in your deploy env, never commit it.\n');
