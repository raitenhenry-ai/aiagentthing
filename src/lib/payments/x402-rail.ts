import { createRequire } from 'node:module';
import { PaymentRequirementsSchema, PaymentPayloadSchema } from 'x402/types';
import { useFacilitator } from 'x402/verify';
import { facilitator as mainnetFacilitator } from '@coinbase/x402';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import {
  creditsToAtomic,
  PaymentError,
  type InboundSettlement,
  type PaymentRail,
  type PaymentRequirements,
  type PayoutResult,
} from './rail';

// Production rail: x402 for inbound payments, and ONE of two custody modes
// for the escrow wallet + outbound USDC payouts on Base:
//
//   1. Self-custody (default when PLATFORM_PRIVATE_KEY is set): the escrow
//      wallet is an ordinary Base wallet — the same kind agents generate for
//      themselves — and payouts are plain USDC transfers signed with that
//      key via a public RPC. No Coinbase account needed. The wallet needs a
//      little ETH on Base for gas.
//   2. Coinbase CDP server wallets (CDP_API_KEY_ID/SECRET + CDP_WALLET_SECRET):
//      managed custody, transfers via CDP with idempotency keys.
//
// Inbound settlement always goes through an x402 facilitator: the public
// x402.org facilitator on base-sepolia (no keys), Coinbase's facilitator on
// base mainnet (needs free CDP API keys), or any facilitator you point
// X402_FACILITATOR_URL at.

const USDC: Record<string, `0x${string}`> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

const CHAINS: Record<string, Chain> = {
  base,
  'base-sepolia': baseSepolia,
};

const DEFAULT_RPC: Record<string, string> = {
  base: 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
};

type CdpClientT = import('@coinbase/cdp-sdk').CdpClient;

export class X402Rail implements PaymentRail {
  readonly network: string;
  private facilitator: ReturnType<typeof useFacilitator>;
  // self-custody mode
  private localAccount: ReturnType<typeof privateKeyToAccount> | undefined;
  private processedPayouts = new Map<string, PayoutResult>();
  // CDP mode
  private cdp: CdpClientT | undefined;

  constructor() {
    this.network = process.env.X402_NETWORK ?? 'base-sepolia';

    const pk = process.env.PLATFORM_PRIVATE_KEY;
    if (pk) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
        throw new PaymentError('bad_key', 'PLATFORM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
      }
      this.localAccount = privateKeyToAccount(pk as `0x${string}`);
    }

    // Facilitator selection: explicit URL override > testnet public > CDP.
    const facilitatorUrl = process.env.X402_FACILITATOR_URL;
    if (facilitatorUrl) {
      this.facilitator = useFacilitator({ url: facilitatorUrl as `${string}://${string}` });
    } else if (this.network === 'base') {
      this.facilitator = useFacilitator(mainnetFacilitator as Parameters<typeof useFacilitator>[0]);
    } else {
      this.facilitator = useFacilitator({ url: 'https://x402.org/facilitator' as `${string}://${string}` });
    }
  }

  private getCdp(): CdpClientT {
    if (!this.cdp) {
      // Lazy CJS load (works under webpack and ESM) so CDP is only pulled in
      // when CDP custody is actually used.
      const lazyRequire: NodeJS.Require =
        typeof require !== 'undefined' ? require : createRequire(import.meta.url);
      const { CdpClient } = lazyRequire('@coinbase/cdp-sdk') as typeof import('@coinbase/cdp-sdk');
      this.cdp = new CdpClient();
    }
    return this.cdp;
  }

  /** The custody wallet: the local key's address, or the CDP server wallet. */
  async platformWallet(): Promise<{ address: string }> {
    if (this.localAccount) {
      return { address: this.localAccount.address.toLowerCase() };
    }
    const account = await this.getCdp().evm.getOrCreateAccount({
      name: process.env.PLATFORM_WALLET_NAME ?? 'clearing-escrow',
    });
    return { address: account.address.toLowerCase() };
  }

  async buildRequirements(args: {
    amountCredits: bigint;
    resource: string;
    description: string;
    payTo?: string;
    extra?: Record<string, string>;
  }): Promise<PaymentRequirements> {
    // Direct payments name the recipient's own wallet; escrowed orders
    // default to the platform custody wallet.
    const payTo = args.payTo ?? (await this.platformWallet()).address;
    const asset = USDC[this.network];
    if (!asset) throw new PaymentError('bad_network', `No USDC address for ${this.network}`);
    return {
      scheme: 'exact',
      network: this.network,
      asset,
      payTo,
      maxAmountRequired: creditsToAtomic(args.amountCredits).toString(),
      resource: args.resource,
      description: args.description,
      mimeType: 'application/json',
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2', ...args.extra },
    };
  }

  async settleInbound(
    paymentHeader: string,
    requirements: PaymentRequirements,
    expectedPayer?: string,
  ): Promise<InboundSettlement> {
    let payload;
    try {
      payload = PaymentPayloadSchema.parse(
        JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')),
      );
    } catch {
      throw new PaymentError('invalid_payment', 'Malformed X-PAYMENT payload');
    }
    const reqs = PaymentRequirementsSchema.parse({
      ...requirements,
      extra: requirements.extra,
    });

    const verification = await this.facilitator.verify(payload, reqs);
    if (!verification.isValid) {
      throw new PaymentError('verification_failed', verification.invalidReason ?? 'invalid');
    }
    // Enforce payer identity AFTER verify (funds have not moved) and BEFORE
    // settle (which moves them). A valid payment from a wallet other than the
    // authenticated agent is refused with no on-chain effect.
    const verifiedPayer = (verification.payer ?? '').toLowerCase();
    if (expectedPayer !== undefined && verifiedPayer && verifiedPayer !== expectedPayer.toLowerCase()) {
      throw new PaymentError('payer_mismatch', 'Payment came from a different wallet');
    }
    const settlement = await this.facilitator.settle(payload, reqs);
    if (!settlement.success) {
      throw new PaymentError('settlement_failed', settlement.errorReason ?? 'settle failed');
    }
    return {
      payer: (settlement.payer ?? verification.payer ?? '').toLowerCase(),
      txHash: settlement.transaction,
      amountAtomic: BigInt(requirements.maxAmountRequired),
    };
  }

  async payout(args: {
    to: string;
    amountCredits: bigint;
    idempotencyKey: string;
  }): Promise<PayoutResult> {
    if (this.localAccount) return this.localPayout(args);
    return this.cdpPayout(args);
  }

  /** Self-custody payout: a plain ERC-20 USDC transfer signed with the
   * platform key. In-process idempotency guards same-key retries; the
   * payouts table (reserve → execute → confirm) guards across restarts. */
  private async localPayout(args: {
    to: string;
    amountCredits: bigint;
    idempotencyKey: string;
  }): Promise<PayoutResult> {
    const existing = this.processedPayouts.get(args.idempotencyKey);
    if (existing) return existing;

    const chain = CHAINS[this.network];
    const asset = USDC[this.network];
    if (!chain || !asset) throw new PaymentError('bad_network', `No chain config for ${this.network}`);
    const rpc = process.env.BASE_RPC_URL ?? DEFAULT_RPC[this.network];

    const wallet = createWalletClient({ account: this.localAccount!, chain, transport: http(rpc) });
    const pub = createPublicClient({ chain, transport: http(rpc) });

    const txHash = await wallet.writeContract({
      address: asset,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [args.to as `0x${string}`, creditsToAtomic(args.amountCredits)],
    });
    // Wait for inclusion so a "confirmed" payout really is on-chain.
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== 'success') {
      throw new PaymentError('payout_reverted', `USDC transfer reverted: ${txHash}`);
    }
    const result = { txHash };
    this.processedPayouts.set(args.idempotencyKey, result);
    return result;
  }

  /** CDP payout: managed transfer with a provider-side idempotency key. */
  private async cdpPayout(args: {
    to: string;
    amountCredits: bigint;
    idempotencyKey: string;
  }): Promise<PayoutResult> {
    const account = await this.getCdp().evm.getOrCreateAccount({
      name: process.env.PLATFORM_WALLET_NAME ?? 'clearing-escrow',
    });
    const result = await (
      account as unknown as {
        transfer: (a: {
          to: string;
          amount: bigint;
          token: string;
          network: string;
          idempotencyKey?: string;
        }) => Promise<{ transactionHash: string }>;
      }
    ).transfer({
      to: args.to,
      amount: creditsToAtomic(args.amountCredits),
      token: 'usdc',
      network: this.network,
      idempotencyKey: args.idempotencyKey,
    });
    return { txHash: result.transactionHash };
  }
}
