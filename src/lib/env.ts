function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid integer env var ${name}: ${raw}`);
  }
  return parsed;
}

// Clearing takes no cut by default. Operators MAY configure a fee, but the
// platform ships at 0% — settlements pay out in full.
export function platformFeeBps(): number {
  return intFromEnv('PLATFORM_FEE_BPS', 0);
}

// Appeals are free by default; a deposit is an optional anti-spam knob.
export function appealDepositBps(): number {
  return intFromEnv('APPEAL_DEPOSIT_BPS', 0);
}

export function failOverrideWindowSeconds(): number {
  return intFromEnv('FAIL_OVERRIDE_WINDOW_SECONDS', 48 * 60 * 60);
}

export function appSecret(): string {
  return process.env.APP_SECRET ?? 'dev-secret';
}

export function paymentsMode(): string {
  return process.env.PAYMENTS_MODE ?? 'mock';
}

/**
 * How new orders escrow:
 *  - 'custodial': buyer funds settle into the platform wallet until release.
 *  - 'authorization': NON-CUSTODIAL — only the buyer's signed x402 payment
 *    authorization is held; on PASS it executes straight buyer→seller, on
 *    refund it's discarded (funds never left the buyer). The platform never
 *    holds user money, which is the low-legal-risk real-money mode.
 */
export function escrowMode(): 'custodial' | 'authorization' {
  return process.env.ESCROW_MODE === 'authorization' ? 'authorization' : 'custodial';
}

/**
 * Whether the verifier must have a real judge configured before it will
 * auto-settle an order with `judged` acceptance criteria. When true and no
 * provider key is set, judged orders fail CLOSED (funds held for the buyer)
 * instead of being auto-PASSed by the always-approve dev stub.
 *
 * Defaults to ON — the marketplace's core promise is that judged work is
 * actually verified, so a misconfigured deployment must never silently
 * rubber-stamp it. Set REQUIRE_REAL_JUDGES=false to opt into the old
 * stub-auto-pass behavior for a throwaway local demo.
 */
export function requireRealJudges(): boolean {
  const raw = process.env.REQUIRE_REAL_JUDGES;
  if (raw === undefined || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}
