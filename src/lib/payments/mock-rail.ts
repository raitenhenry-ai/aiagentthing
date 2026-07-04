import { createHash, randomBytes } from 'node:crypto';
import {
  creditsToAtomic,
  PaymentError,
  type InboundSettlement,
  type PaymentRail,
  type PaymentRequirements,
  type PayoutResult,
} from './rail';

// Deterministic in-memory chain for dev and CI: wallets hold mock USDC,
// inbound payments debit the payer and credit the platform wallet, payouts
// do the reverse. Same interface, same failure modes (insufficient funds,
// wrong amount), no network.

const MOCK_PLATFORM_WALLET = '0xp1a7f0rm000000000000000000000000000000000'.toLowerCase();

export class MockRail implements PaymentRail {
  readonly network = 'mock';
  private balances = new Map<string, bigint>(); // atomic units
  private processedPayments = new Set<string>();
  private processedPayouts = new Map<string, PayoutResult>();

  /** Test/dev helper: put mock USDC in a wallet (atomic units via credits). */
  fund(wallet: string, credits: bigint): void {
    const w = wallet.toLowerCase();
    this.balances.set(w, (this.balances.get(w) ?? 0n) + creditsToAtomic(credits));
  }

  /** On-chain balance in credits (cents), for E2E assertions. */
  balanceOf(wallet: string): bigint {
    return (this.balances.get(wallet.toLowerCase()) ?? 0n) / 10_000n;
  }

  async buildRequirements(args: {
    amountCredits: bigint;
    resource: string;
    description: string;
    payTo?: string;
    extra?: Record<string, string>;
  }): Promise<PaymentRequirements> {
    return {
      scheme: 'exact',
      network: this.network,
      asset: 'mock-usdc',
      payTo: (args.payTo ?? MOCK_PLATFORM_WALLET).toLowerCase(),
      maxAmountRequired: creditsToAtomic(args.amountCredits).toString(),
      resource: args.resource,
      description: args.description,
      mimeType: 'application/json',
      maxTimeoutSeconds: 300,
      extra: args.extra ?? {},
    };
  }

  /** Mock X-PAYMENT payload: base64 JSON {payer, nonce}. */
  static paymentHeader(payerWallet: string): string {
    return Buffer.from(
      JSON.stringify({ payer: payerWallet.toLowerCase(), nonce: randomBytes(8).toString('hex') }),
    ).toString('base64');
  }

  async settleInbound(
    paymentHeader: string,
    requirements: PaymentRequirements,
    expectedPayer?: string,
  ): Promise<InboundSettlement> {
    let parsed: { payer?: string; nonce?: string };
    try {
      parsed = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
    } catch {
      throw new PaymentError('invalid_payment', 'Malformed X-PAYMENT payload');
    }
    if (!parsed.payer || !parsed.nonce) {
      throw new PaymentError('invalid_payment', 'X-PAYMENT missing payer or nonce');
    }
    const payer = parsed.payer.toLowerCase();
    // Reject a payer that isn't the authenticated agent BEFORE moving any
    // funds or consuming the nonce — a mismatch must have zero side effects.
    if (expectedPayer !== undefined && payer !== expectedPayer.toLowerCase()) {
      throw new PaymentError('payer_mismatch', 'Payment came from a different wallet');
    }
    const key = `${parsed.payer}:${parsed.nonce}`;
    if (this.processedPayments.has(key)) {
      throw new PaymentError('replayed_payment', 'Payment already settled');
    }
    const amount = BigInt(requirements.maxAmountRequired);
    const balance = this.balances.get(payer) ?? 0n;
    if (balance < amount) {
      throw new PaymentError('insufficient_funds', 'Payer wallet cannot cover the amount');
    }
    this.balances.set(payer, balance - amount);
    this.balances.set(
      requirements.payTo,
      (this.balances.get(requirements.payTo) ?? 0n) + amount,
    );
    this.processedPayments.add(key);
    return {
      payer,
      amountAtomic: amount,
      txHash: `0xmock${createHash('sha256').update(key).digest('hex').slice(0, 59)}`,
    };
  }

  async payout(args: {
    to: string;
    amountCredits: bigint;
    idempotencyKey: string;
  }): Promise<PayoutResult> {
    const existing = this.processedPayouts.get(args.idempotencyKey);
    if (existing) return existing; // idempotent replay
    const amount = creditsToAtomic(args.amountCredits);
    const platform = this.balances.get(MOCK_PLATFORM_WALLET) ?? 0n;
    if (platform < amount) {
      throw new PaymentError('platform_underfunded', 'Platform wallet cannot cover payout');
    }
    const to = args.to.toLowerCase();
    this.balances.set(MOCK_PLATFORM_WALLET, platform - amount);
    this.balances.set(to, (this.balances.get(to) ?? 0n) + amount);
    const result = {
      txHash: `0xmock${createHash('sha256').update(args.idempotencyKey).digest('hex').slice(0, 59)}`,
    };
    this.processedPayouts.set(args.idempotencyKey, result);
    return result;
  }
}
