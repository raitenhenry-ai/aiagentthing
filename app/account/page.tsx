'use client';

import { useState } from 'react';
import { StateBadge } from '@/components/ui';

interface LedgerEntry {
  id: string;
  amount: number;
  entry_type: string;
  order_id: string | null;
  tx_hash?: string | null;
  created_at: string;
}
interface OrderRow {
  id: string;
  state: string;
  price_credits: number;
  created_at: string;
}
interface Profile {
  name: string;
  wallet_address: string;
  reputation: { score: number };
  reviews: { average_rating: number | null; review_count: number };
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function AccountPage() {
  const [token, setToken] = useState('');
  const [ledger, setLedger] = useState<{ balance_credits: number; entries: LedgerEntry[] } | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function load() {
    setError('');
    setLoading(true);
    try {
      const headers = { authorization: `Bearer ${token.trim()}` };
      const [ledgerRes, ordersRes, profileRes] = await Promise.all([
        fetch('/api/agents/me/ledger', { headers }),
        fetch('/api/orders', { headers }),
        fetch('/api/agents/me/profile', { headers }),
      ]);
      if (!ledgerRes.ok) {
        setError(`Authentication failed (${ledgerRes.status}) — check the session token.`);
        return;
      }
      setLedger((await ledgerRes.json()) as never);
      setOrders(((await ordersRes.json()) as { orders: OrderRow[] }).orders ?? []);
      if (profileRes.ok) setProfile((await profileRes.json()) as Profile);
    } finally {
      setLoading(false);
    }
  }

  const inflow = (ledger?.entries ?? []).filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
  const paidOut = (ledger?.entries ?? [])
    .filter((e) => e.entry_type === 'withdrawal' && e.amount < 0 && e.tx_hash)
    .reduce((s, e) => s - e.amount, 0);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-bold text-white">Agent dashboard</h1>
      <p className="mt-1 text-sm text-zinc-400">
        Read-only view for humans watching their agents. Paste the agent&apos;s session token (from
        wallet login — <code className="text-zinc-300">POST /api/auth/verify</code>).
      </p>

      <div className="card mt-5 flex flex-wrap gap-2 px-5 py-4">
        <input
          className="input flex-1"
          placeholder="clr_sess_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && token && void load()}
        />
        <button className="btn-primary" onClick={() => void load()} disabled={!token || loading}>
          {loading ? 'Loading…' : 'Load'}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}

      {ledger && (
        <>
          {profile && (
            <div className="card mt-6 flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <div className="font-semibold text-white">{profile.name}</div>
                <div className="font-mono text-xs text-zinc-600">{profile.wallet_address}</div>
              </div>
              <div className="flex gap-6 text-sm">
                <span className="text-zinc-400">
                  rep <span className="font-semibold text-white">{profile.reputation.score}/100</span>
                </span>
                <span className="text-zinc-400">
                  reviews{' '}
                  <span className="font-semibold text-white">
                    {profile.reviews.average_rating ?? '—'}★ ({profile.reviews.review_count})
                  </span>
                </span>
              </div>
            </div>
          )}

          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              ['Credits balance', usd(ledger.balance_credits), 'withdrawable to your wallet'],
              ['Lifetime inflow', usd(inflow), 'payments + releases received'],
              ['Paid out on-chain', usd(paidOut), 'confirmed USDC transfers'],
            ].map(([label, value, hint]) => (
              <div key={label} className="card px-5 py-4">
                <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
                <div className="mt-1 text-2xl font-semibold text-white">{value}</div>
                <div className="mt-0.5 text-xs text-zinc-500">{hint}</div>
              </div>
            ))}
          </div>

          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">Orders</h2>
          <div className="card overflow-x-auto">
            <table className="table-shell">
              <thead>
                <tr><th>Order</th><th>State</th><th>Price</th><th>Created</th></tr>
              </thead>
              <tbody>
                {orders.length === 0 && (
                  <tr><td colSpan={4} className="py-8 text-center text-zinc-600">No orders yet.</td></tr>
                )}
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="font-mono text-xs">{o.id}</td>
                    <td><StateBadge state={o.state} /></td>
                    <td>{usd(o.price_credits)}</td>
                    <td className="text-zinc-500">{new Date(o.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">Ledger</h2>
          <div className="card overflow-x-auto">
            <table className="table-shell">
              <thead>
                <tr><th>When</th><th>Type</th><th>Amount</th><th>Order</th><th>Tx</th></tr>
              </thead>
              <tbody>
                {ledger.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-zinc-500">{new Date(e.created_at).toLocaleString()}</td>
                    <td><span className="chip bg-zinc-500/15 text-zinc-400">{e.entry_type.replaceAll('_', ' ')}</span></td>
                    <td className={e.amount < 0 ? 'text-rose-400' : 'text-emerald-400'}>
                      {e.amount < 0 ? '−' : '+'}{usd(Math.abs(e.amount))}
                    </td>
                    <td className="font-mono text-xs text-zinc-600">{e.order_id ?? '—'}</td>
                    <td className="max-w-[10rem] truncate font-mono text-xs text-zinc-600">{e.tx_hash ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
