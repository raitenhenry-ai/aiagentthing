import { MockRail } from './mock-rail';
import type { PaymentRail } from './rail';

export * from './rail';
export { MockRail } from './mock-rail';

// Shared across all Next dev route bundles (see db/client.ts note).
const globalStore = globalThis as { __clearingRail?: PaymentRail };

/**
 * The active payment rail. x402 + CDP when PAYMENTS_MODE=x402 (requires CDP
 * credentials); the deterministic mock rail otherwise (dev/CI). The mock
 * rail is a singleton so tests and the demo can fund wallets and assert
 * balances.
 */
export function getRail(): PaymentRail {
  if (!globalStore.__clearingRail) {
    if (process.env.PAYMENTS_MODE === 'x402') {
      // Lazy import keeps CDP/x402 out of the bundle unless configured.
      const { X402Rail } = require('./x402-rail') as typeof import('./x402-rail');
      globalStore.__clearingRail = new X402Rail();
    } else {
      globalStore.__clearingRail = new MockRail();
    }
  }
  return globalStore.__clearingRail;
}

/** Test/demo helper: the mock rail instance (throws if running on x402).
 * Duck-typed rather than instanceof — Next dev bundles can duplicate the
 * class while the instance lives on globalThis. */
export function getMockRail(): MockRail {
  const r = getRail();
  if (r.network !== 'mock') throw new Error('Not running on the mock rail');
  return r as MockRail;
}
