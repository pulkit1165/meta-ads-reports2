'use client';

import { useState } from 'react';
import { rs, pct } from '@/components/ui';

/**
 * Yesterday's profit, typed in.
 *
 * Nothing in the warehouse knows landed cost, RTO or shipping, so profit
 * cannot be derived here — it is entered by hand and stored per day and
 * portal, which is why a portal running at a loss inside a profitable total
 * stays visible instead of averaging away.
 *
 * Sales and ad spend beside each box come from the report, so the margin and
 * the profit-per-rupee-of-ad-spend update the moment a figure is saved.
 */
export interface ProfitSite {
  portal: string;
  name: string;
  sales: number;
  spend: number;
  profit: number | null;
  note: string;
  updatedAt: string | null;
}

const money = (v: number) => rs(Math.round(v));

export default function ProfitBoard({ day, sites }: { day: string; sites: ProfitSite[] }) {
  const [rows, setRows] = useState(sites);
  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(sites.map((s) => [s.portal, s.profit == null ? '' : String(s.profit)])),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const save = async (portal: string) => {
    setBusy(portal); setErr('');
    try {
      const r = await fetch('/api/profit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: day, portal, profit: draft[portal] ?? '' }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? `save failed (${r.status})`);
      const saved: { portal: string; profit: number | null; updatedAt: string | null }[] =
        d.entries ?? [];
      setRows((cur) => cur.map((s) => {
        const hit = saved.find((e) => e.portal === s.portal);
        return hit ? { ...s, profit: hit.profit, updatedAt: hit.updatedAt } : s;
      }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // The "All three" row is the total row: it shows the sum of the sites that
  // have a figure until someone types one of their own over it.
  const perSite = rows.filter((r) => r.portal !== 'ALL');
  const entered = perSite.filter((s) => s.profit != null);
  const profitSum = entered.reduce((a, s) => a + (s.profit ?? 0), 0);

  const cell = 'px-3 py-2 text-right tabular-nums';
  const head = 'px-3 py-2 text-[10.5px] uppercase tracking-[0.12em] text-muted font-medium';

  return (
    <div>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-edge">
              <th className={`${head} text-left`}>Website</th>
              <th className={head}>Sales</th>
              <th className={head}>Ad spend</th>
              <th className={`${head} text-left`}>Profit (typed in)</th>
              <th className={head}>Margin</th>
              <th className={head}>Per Rs of ad spend</th>
              <th className={`${head} text-left`}>Saved</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const p = s.portal === 'ALL' && s.profit == null && entered.length
                ? profitSum : s.profit;
              return (
                <tr key={s.portal} className="border-b border-edge/50 last:border-0 hover:bg-hover">
                  <td className={`px-3 py-2 ${s.portal === 'ALL' ? 'font-medium' : ''}`}>{s.name}</td>
                  <td className={cell}>{s.sales ? money(s.sales) : '–'}</td>
                  <td className={cell}>{s.spend ? money(s.spend) : '–'}</td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span className="text-muted">Rs</span>
                      <input
                        id={`profit-${s.portal}`}
                        inputMode="numeric"
                        value={draft[s.portal] ?? ''}
                        placeholder="—"
                        onChange={(e) => setDraft((d) => ({ ...d, [s.portal]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') save(s.portal); }}
                        className="w-28 rounded-md border border-edge bg-panel px-2 py-1 text-right text-[13px] tabular-nums text-text-strong outline-none focus:border-gold"
                      />
                      <button
                        type="button"
                        onClick={() => save(s.portal)}
                        disabled={busy === s.portal}
                        className="rounded-md border border-edge px-2 py-1 text-[11px] text-muted transition hover:border-gold hover:text-gold disabled:opacity-50"
                      >
                        {busy === s.portal ? 'saving' : 'save'}
                      </button>
                    </span>
                  </td>
                  <td className={cell}>
                    {p != null && s.sales > 0
                      ? <span className={p < 0 ? 'text-bad' : 'text-good'}>{pct((p / s.sales) * 100, 1)}</span>
                      : <span className="text-muted">–</span>}
                  </td>
                  <td className={cell}>
                    {p != null && s.spend > 0
                      ? <span className={p < 0 ? 'text-bad' : ''}>{(p / s.spend).toFixed(2)}</span>
                      : <span className="text-muted">–</span>}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-muted">{s.updatedAt ?? 'not yet'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {err && <p className="mt-2 text-[12px] text-bad">{err}</p>}
      <p className="mt-2 text-[11px] text-muted">
        Typed figures are stored on the box against {day}, so they are the same on every device and
        stay with the day. Leave a box empty for “not worked out yet” — a zero would read as a day
        that broke exactly even. Fill <span className="text-text">All three</span> to override the
        sum with a figure of your own.
      </p>
    </div>
  );
}
