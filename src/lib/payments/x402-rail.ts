import { PaymentRequirementsSchema, PaymentPayloadSchema } from 'x402/types';
import { useFacilitator } from 'x402/verify';
import { facilitator as mainnetFacilitator } from '@coinbase/x402';
import { CdpClient } from '@coinbase/cdp-sdk';
import {
  creditsToAtomic,
  PaymentError,
  type InboundSettlement,
  type PaymentRail,
  type PaymentRequirements,
  type PayoutResult,
} from './rail';

// Production rail: x402 (Coinbase facilitator) for inbound payments, CDP
// server wallets for escrow custody and outbound USDC transfers on Base.
// No custom wallet/key infrastructure — custody is CDP's problem.
//
// Env: CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET,
//      X402_NETWORK=base|base-sepolia, PLATFORM_WALLET_NAME.

const USDC: Record<string, string> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

export class X402Rail implements PaymentRail {
  readonly network: string;
  private cdp: CdpClient | undefined;
  private facilitator: ReturnType<typeof useFacilitator>;
  private platformAddress: string | undefined;

  constructor() {
    this.network = process.env.X402_NETWORK ?? 'base-sepolia';
    // Mainnet uses the CDP facilitator (auth headers); testnet uses the
    // public x402.org facilitator.
    this.facilitator =
      this.network === 'base'
        ? useFacilitator(mainnetFacilitator as Parameters<typeof useFacilitator>[0])
        : useFacilitator({ url: 'https://x402.org/facilitator' as `${string}://${string}` });
  }

  private getCdp(): CdpClient {
    if (!this.cdp) this.cdp = new CdpClient();
    return this.cdp;
  }

  private async platformWallet(): Promise<{ address: string; account: unknown }> {
    const account = await this.getCdp().evm.getOrCreateAccount({
      name: process.env.PLATFORM_WALLET_NAME ?? 'clearing-escrow',
    });
    this.platformAddress = account.address.toLowerCase();
    return { address: this.platformAddress, account };
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
    const { account } = await this.platformWallet();
    // CDP transfers accept an idempotency key so retried payouts can never
    // double-send.
    const result = await (
      account as {
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
