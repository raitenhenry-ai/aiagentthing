// The money layer. Everything on-chain goes through this interface: the
// x402 rail (USDC on Base via Coinbase facilitator + CDP server wallets) in
// production, a deterministic mock rail in dev/CI. Internal accounting stays
// in the double-entry credits ledger — 1 credit = 1 USDC cent, integers only.

/** USDC has 6 decimals; credits are cents. 1 credit = 10^4 atomic units. */
export const ATOMIC_PER_CREDIT = 10_000n;

export function creditsToAtomic(credits: bigint): bigint {
  return credits * ATOMIC_PER_CREDIT;
}

export interface PaymentRequirements {
  scheme: 'exact';
  network: string; // 'base' | 'base-sepolia' | 'mock'
  asset: string; // USDC contract address (or 'mock-usdc')
  payTo: string; // platform escrow wallet
  maxAmountRequired: string; // atomic units, stringified bigint
  resource: string;
  description: string;
  mimeType: 'application/json';
  maxTimeoutSeconds: number;
  extra: Record<string, string>;
}

export interface InboundSettlement {
  /** Wallet that paid — must match the authenticated agent's wallet. */
  payer: string;
  txHash: string;
  amountAtomic: bigint;
}

export interface PayoutResult {
  txHash: string;
}

export class PaymentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
  }
}

export interface PaymentRail {
  readonly network: string;
  /** Build the x402 requirements returned with an HTTP 402 response.
   * `payTo` overrides the recipient: escrowed orders omit it (platform
   * custody wallet); direct payments (invoices, tips) pass the seller's own
   * wallet so funds never touch the platform. */
  buildRequirements(args: {
    amountCredits: bigint;
    resource: string;
    description: string;
    payTo?: string;
    extra?: Record<string, string>;
  }): Promise<PaymentRequirements>;
  /**
   * Verify + settle an inbound X-PAYMENT payload against requirements via
   * the facilitator. Throws PaymentError on any mismatch; success means the
   * funds are on-chain in the platform escrow wallet.
   */
  settleInbound(
    paymentHeader: string,
    requirements: PaymentRequirements,
  ): Promise<InboundSettlement>;
  /**
   * Transfer USDC from the platform wallet to an agent wallet. Idempotent
   * per idempotencyKey — retried calls must not double-send.
   */
  payout(args: {
    to: string;
    amountCredits: bigint;
    idempotencyKey: string;
  }): Promise<PayoutResult>;
}
