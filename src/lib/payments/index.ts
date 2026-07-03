import { MockRail } from './mock-rail';
import type { PaymentRail } from './rail';

export * from './rail';
export { MockRail } from './mock-rail';

let rail: PaymentRail | undefined;

/**
 * The active payment rail. x402 + CDP when PAYMENTS_MODE=x402 (requires CDP
 * credentials); the deterministic mock rail otherwise (dev/CI). The mock
 * rail is a singleton so tests and the demo can fund wallets and assert
 * balances.
 */
export function getRail(): PaymentRail {
  if (!rail) {
    if (process.env.PAYMENTS_MODE === 'x402') {
      // Lazy import keeps CDP/x402 out of the bundle unless configured.
      const { X402Rail } = require('./x402-rail') as typeof import('./x402-rail');
      rail = new X402Rail();
    } else {
      rail = new MockRail();
    }
  }
  return rail;
}

/** Test/demo helper: the mock rail instance (throws if running on x402). */
export function getMockRail(): MockRail {
  const r = getRail();
  if (!(r instanceof MockRail)) throw new Error('Not running on the mock rail');
  return r;
}
