import type { ReactNode } from 'react';

export function money(credits: number | bigint): string {
  return `$${(Number(credits) / 100).toFixed(2)}`;
}

export function turnaround(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

const STATE_STYLES: Record<string, string> = {
  created: 'bg-zinc-500/15 text-zinc-400',
  escrowed: 'bg-sky-500/15 text-sky-400',
  delivered: 'bg-indigo-500/15 text-indigo-400',
  verifying: 'bg-amber-500/15 text-amber-400',
  passed: 'bg-emerald-500/15 text-emerald-400',
  failed: 'bg-rose-500/15 text-rose-400',
  expired: 'bg-zinc-500/15 text-zinc-400',
  appealed: 'bg-fuchsia-500/15 text-fuchsia-400',
  settled_released: 'bg-emerald-500/15 text-emerald-400',
  settled_refund: 'bg-orange-500/15 text-orange-400',
  settled_override: 'bg-teal-500/15 text-teal-400',
  open: 'bg-sky-500/15 text-sky-400',
  paid: 'bg-emerald-500/15 text-emerald-400',
  void: 'bg-zinc-500/15 text-zinc-400',
  pending: 'bg-amber-500/15 text-amber-400',
  quoted: 'bg-indigo-500/15 text-indigo-400',
  accepted: 'bg-emerald-500/15 text-emerald-400',
  declined: 'bg-rose-500/15 text-rose-400',
};

export function StateBadge({ state }: { state: string }) {
  return (
    <span className={`chip ${STATE_STYLES[state] ?? 'bg-zinc-500/15 text-zinc-400'}`}>
      {state.replaceAll('_', ' ')}
    </span>
  );
}

export function VerifiabilityBadge({ low }: { low: boolean }) {
  return low ? (
    <span className="chip bg-amber-500/15 text-amber-400">judge-verified</span>
  ) : (
    <span className="chip bg-emerald-500/15 text-emerald-400">machine-verified</span>
  );
}

export function PricingBadge({ mode }: { mode: string }) {
  return mode === 'quote' ? (
    <span className="chip bg-indigo-500/15 text-indigo-400">request a quote</span>
  ) : null;
}

export function Stars({ rating }: { rating: number }) {
  return (
    <span className="text-amber-400" aria-label={`${rating} out of 5`}>
      {'★'.repeat(Math.round(rating))}
      <span className="text-zinc-600">{'★'.repeat(5 - Math.round(rating))}</span>
    </span>
  );
}

const AVATAR_HUES = ['bg-indigo-500', 'bg-emerald-500', 'bg-rose-500', 'bg-amber-500', 'bg-sky-500', 'bg-fuchsia-500'];

export function Avatar({ name, seed, size = 10 }: { name: string; seed: string; size?: number }) {
  const hue = AVATAR_HUES[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_HUES.length];
  const initials = name
    .split(/[\s-_]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <div
      className={`flex h-${size} w-${size} shrink-0 items-center justify-center rounded-full ${hue} font-semibold text-white`}
      style={{ width: size * 4, height: size * 4, fontSize: size * 1.5 }}
    >
      {initials || '∅'}
    </div>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card px-5 py-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-white">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export function RepBadge({ score }: { score: number }) {
  const tone =
    score >= 75 ? 'text-emerald-400 border-emerald-500/40' : score >= 50 ? 'text-sky-400 border-sky-500/40' : 'text-amber-400 border-amber-500/40';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone}`}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 21l1.6-7L2 9.2l7.1-.6L12 2z" />
      </svg>
      {score}/100
    </span>
  );
}
