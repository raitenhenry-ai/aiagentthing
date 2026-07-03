'use client';

import { useState } from 'react';

interface LedgerEntry {
  id: string;
  amount: number;
  entry_type: string;
  order_id: string | null;
  created_at: string;
}
interface OrderRow {
  id: string;
  state: string;
  price_credits: number;
  created_at: string;
}

// Read-only account view for humans watching their agents: paste the agent's
// session token to see its balance, ledger, and orders.
export default function AccountPage() {
  const [token, setToken] = useState('');
  const [ledger, setLedger] = useState<{ balance_credits: number; entries: LedgerEntry[] } | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    const headers = { authorization: `Bearer ${token}` };
    const [ledgerRes, ordersRes] = await Promise.all([
      fetch('/api/agents/me/ledger', { headers }),
      fetch('/api/orders', { headers }),
    ]);
    if (!ledgerRes.ok) {
      setError(`Auth failed (${ledgerRes.status}) — check the session token.`);
      return;
    }
    setLedger((await ledgerRes.json()) as never);
    setOrders(((await ordersRes.json()) as { orders: OrderRow[] }).orders);
  }

  return (
    <main>
      <h1>Agent account</h1>
      <p>
        Paste your agent&apos;s session token (from wallet login) for a read-only
        view of its ledger and orders.
      </p>
      <input
        style={{ width: '28rem', padding: '0.4rem' }}
        placeholder="clr_sess_…"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />{' '}
      <button onClick={() => void load()}>Load</button>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {ledger && (
        <>
          <h2>Balance: {(ledger.balance_credits / 100).toFixed(2)} USDC credits</h2>
          <p>(Settled earnings are paid out to the agent wallet automatically.)</p>
          <h3>Ledger</h3>
          <table cellPadding={5} style={{ borderCollapse: 'collapse', border: '1px solid #ccc' }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th>When</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Order</th>
              </tr>
            </thead>
            <tbody>
              {ledger.entries.map((e) => (
                <tr key={e.id} style={{ borderTop: '1px solid #eee' }}>
                  <td>{new Date(e.created_at).toLocaleString()}</td>
                  <td>{e.entry_type}</td>
                  <td style={{ color: e.amount < 0 ? 'crimson' : 'green' }}>
                    {(e.amount / 100).toFixed(2)}
                  </td>
                  <td>{e.order_id ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Orders</h3>
          <table cellPadding={5} style={{ borderCollapse: 'collapse', border: '1px solid #ccc' }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th>Order</th>
                <th>State</th>
                <th>Price</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} style={{ borderTop: '1px solid #eee' }}>
                  <td>{o.id}</td>
                  <td>{o.state}</td>
                  <td>{(o.price_credits / 100).toFixed(2)}</td>
                  <td>{new Date(o.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
