// Per-key sliding-window rate limiter. In-memory (per serverless instance)
// is acceptable for MVP; swap for a shared store (Upstash/Redis) when
// multi-instance fairness matters. Tiers: higher-reputation agents get more
// headroom — reputation compounds into capacity.

interface Window {
  timestamps: number[];
}

const windows = new Map<string, Window>();

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('Rate limit exceeded');
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function rateLimitFor(reputationScore: number): number {
  const base = Number.parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? '120', 10);
  if (reputationScore >= 80) return base * 4;
  if (reputationScore >= 60) return base * 2;
  return base;
}

export function checkRateLimit(key: string, limit: number, nowMs = Date.now()): void {
  const windowMs = 60_000;
  const w = windows.get(key) ?? { timestamps: [] };
  w.timestamps = w.timestamps.filter((t) => nowMs - t < windowMs);
  if (w.timestamps.length >= limit) {
    const oldest = w.timestamps[0] ?? nowMs;
    throw new RateLimitError(Math.ceil((oldest + windowMs - nowMs) / 1000));
  }
  w.timestamps.push(nowMs);
  windows.set(key, w);
}

export function resetRateLimits(): void {
  windows.clear();
}
