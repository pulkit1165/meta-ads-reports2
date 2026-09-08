'use client';
import { useCallback, useEffect, useState } from 'react';
import Stat from '@/components/Stat';

const INR = (n: number) => '₹' + n.toLocaleString('en-IN');
const WINDOWS = [
  { h: 24, label: '24h' },
  { h: 72, label: '3d' },
  { h: 168, label: '7d' },
  { h: 720, label: '30d' },
];

export default function Orders() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [only, setOnly] = useState<'all' | 'app'>('all');

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/orders?hours=${hours}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
      setErr(null);
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }, [hours]);

  useEffect(() => { load(); }, [load]);
  // keep it live without hammering Shopify's rate limit
  useEffect(() => {
    const id = setInterval(load, 120_000);
    return () => clearInterval(id);
  }, [load]);

  const t = data?.totals;
  const rows = (data?.orders || []).filter((o: any) => only === 'all' || o.channel === 'app');

  return (
    <div className="p-5">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl">Orders</h1>
          <p className="text-[11.5px] text-muted">
            Live from Shopify across all three stores · app orders identified by the
            checkout marker the apps set
            {data && ` · updated ${new Date(data.generatedAt).toLocaleTimeString('en-IN')}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-edge p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.h}
                onClick={() => setHours(w.h)}
                className={`rounded-md px-2.5 py-1 text-[12px] ${
                  hours === w.h ? 'bg-gold/20 text-gold' : 'text-muted hover:text-[#e6ebf1]'
                }`}
              >{w.label}</button>
            ))}
          </div>
          <button
            onClick={load}
            className="rounded-lg border border-edge px-3 py-1.5 text-[12px] text-muted hover:text-gold"
          >{busy ? '…' : 'Refresh'}</button>
        </div>
      </header>

      {err && (
        <div className="mb-4 rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-[13px] text-bad">
          {err}
        </div>
      )}

      {t && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Stat label="Orders" value={String(t.orders)} sub={`last ${WINDOWS.find(w=>w.h===hours)?.label}`} />
            <Stat label="Revenue" value={INR(t.revenue)} />
            <Stat label="AOV" value={INR(t.aov)} />
            <Stat label="App orders" value={String(t.appOrders)} tone="gold"
                  sub={t.orders ? `${Math.round((t.appOrders / t.orders) * 100)}% of orders` : undefined} />
            <Stat label="App revenue" value={INR(t.appRevenue)} tone="gold"
                  sub={t.revenue ? `${Math.round((t.appRevenue / t.revenue) * 100)}% of revenue` : undefined} />
            <Stat label="App AOV" value={INR(t.appAov)} tone="gold"
                  sub={t.appAov && t.aov ? (t.appAov >= t.aov ? `+${INR(t.appAov - t.aov)} vs web` : `${INR(t.appAov - t.aov)} vs web`) : undefined} />
          </div>

          <div className="mb-5 grid gap-3 md:grid-cols-3">
            {data.byStore.map((s: any) => (
              <div key={s.key} className="rounded-xl border border-edge bg-panel p-4">
                <div className="flex items-baseline justify-between">
                  <div className="text-[13px] font-medium">{s.name}</div>
                  {!s.configured && (
                    <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">no token</span>
                  )}
                </div>
                <div className="mt-2 flex items-end justify-between">
                  <div>
                    <div className="font-display text-xl">{INR(s.revenue)}</div>
                    <div className="text-[11px] text-muted">{s.orders} orders</div>
                  </div>
                  <div className="text-right">
                    <div className="font-display text-base text-gold">{s.appOrders}</div>
                    <div className="text-[11px] text-muted">from app</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mb-2 flex items-center gap-2">
        <h2 className="font-display text-base">Recent orders</h2>
        <div className="flex rounded-lg border border-edge p-0.5">
          {(['all', 'app'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setOnly(k)}
              className={`rounded-md px-2.5 py-1 text-[11.5px] ${
                only === k ? 'bg-gold/20 text-gold' : 'text-muted hover:text-[#e6ebf1]'
              }`}
            >{k === 'all' ? 'All' : 'App only'}</button>
          ))}
        </div>
        <span className="text-[11px] text-muted">{rows.length} shown</span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-edge">
        <table className="w-full min-w-[860px] text-[12.5px]">
          <thead className="bg-panel text-left text-[10.5px] uppercase tracking-wider text-muted">
            <tr>
              {['Order', 'Time', 'Store', 'Channel', 'Customer', 'City', 'Items', 'Total', 'Payment', 'Fulfilment'].map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((o: any) => (
              <tr key={`${o.store}${o.name}`}
                  className={`border-t border-edge/60 ${o.cancelled ? 'opacity-45' : ''}`}>
                <td className="whitespace-nowrap px-3 py-2">
                  <a href={o.adminUrl} target="_blank" rel="noreferrer" className="hover:text-gold">{o.name}</a>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">
                  {new Date(o.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{o.store}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10.5px] ${
                    o.channel === 'app' ? 'bg-gold/20 text-gold' : 'bg-white/5 text-muted'}`}>
                    {o.channel === 'app' ? 'App' : 'Web'}
                  </span>
                </td>
                <td className="max-w-[160px] truncate px-3 py-2">{o.customer}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{o.city}</td>
                <td className="max-w-[260px] truncate px-3 py-2 text-muted">
                  {o.items.map((i: any) => `${i.title}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ')}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-medium">{INR(Math.round(o.total))}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className={o.financialStatus === 'paid' ? 'text-good' : 'text-warn'}>
                    {o.cancelled ? 'cancelled' : o.financialStatus}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{o.fulfillmentStatus || 'unfulfilled'}</td>
              </tr>
            ))}
            {!rows.length && !busy && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-muted">No orders in this window.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
