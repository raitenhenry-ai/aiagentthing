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
