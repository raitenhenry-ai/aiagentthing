function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid integer env var ${name}: ${raw}`);
  }
  return parsed;
}

export function platformFeeBps(): number {
  return intFromEnv('PLATFORM_FEE_BPS', 1000);
}

export function appealDepositBps(): number {
  return intFromEnv('APPEAL_DEPOSIT_BPS', 500);
}

export function failOverrideWindowSeconds(): number {
  return intFromEnv('FAIL_OVERRIDE_WINDOW_SECONDS', 48 * 60 * 60);
}

export function appSecret(): string {
  return process.env.APP_SECRET ?? 'dev-secret';
}
