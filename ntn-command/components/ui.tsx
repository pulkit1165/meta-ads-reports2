import Link from 'next/link';
import type { ReactNode } from 'react';

/* ── formatting ─────────────────────────────────────────────────────────── */

export const rs = (v: number) =>
  'Rs ' + Math.round(v).toLocaleString('en-IN');

/** Lakh form for headline figures — the unit the team actually speaks in. */
export const lakh = (v: number) =>
  Math.abs(v) >= 100000 ? `Rs ${(v / 100000).toFixed(2)}L` : rs(v);

export const pct = (v: number, digits = 0) => `${v.toFixed(digits)}%`;
export const num = (v: number) => Math.round(v).toLocaleString('en-IN');

/* ── layout ─────────────────────────────────────────────────────────────── */

export function Page({
  title, subtitle, children, actions,
}: { title: string; subtitle?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-edge bg-ink/85 px-6 py-4 backdrop-blur">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-xl leading-tight text-gold">{title}</h1>
            {subtitle && <p className="mt-0.5 text-[12px] text-muted">{subtitle}</p>}
          </div>
          {actions}
        </div>
      </header>
      <div className="space-y-5 p-6">{children}</div>
    </div>
  );
}

export function Card({
  title, note, children, className = '',
}: { title?: string; note?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-edge bg-panel/50 ${className}`}>
      {title && (
        <div className="flex items-baseline gap-3 border-b border-edge px-4 py-3">
          <h2 className="text-[13px] font-medium tracking-wide text-[#dbe3ec]">{title}</h2>
          {note && <span className="text-[11px] text-muted">{note}</span>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Grid({ cols = 4, children }: { cols?: number; children: ReactNode }) {
  const map: Record<number, string> = {
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-2 lg:grid-cols-3',
    4: 'sm:grid-cols-2 lg:grid-cols-4',
    5: 'sm:grid-cols-3 lg:grid-cols-5',
  };
  return <div className={`grid grid-cols-1 gap-3 ${map[cols] ?? map[4]}`}>{children}</div>;
}

/* ── numbers on screen ──────────────────────────────────────────────────── */

/**
 * `tone` is only ever passed where up-is-better is genuinely true. Closure
 * metrics pass 'flat': closing more budget can mean the protocol caught more
 * losers or that the day was worse, and a green arrow would assert a verdict
 * the number cannot support.
 */
export function Stat({
  label, value, sub, delta, tone = 'auto', unit,
}: {
  label: string; value: string; sub?: string;
  delta?: number | null; tone?: 'auto' | 'flat' | 'invert'; unit?: string;
}) {
  return (
    <div className="rounded-xl border border-edge bg-panel/50 p-4">
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="font-display text-[26px] leading-none text-[#eef3f9]">{value}</span>
        {delta != null && <Delta v={delta} tone={tone} unit={unit} />}
      </div>
      {sub && <div className="mt-1.5 text-[11.5px] text-muted">{sub}</div>}
    </div>
  );
}

export function Delta({
  v, tone = 'auto', unit = '%',
}: { v: number; tone?: 'auto' | 'flat' | 'invert'; unit?: string }) {
  const up = v > 0;
  const flatish = Math.abs(v) < 0.05;
  const color =
    tone === 'flat' || flatish
      ? 'text-muted'
      : tone === 'invert'
        ? up ? 'text-bad' : 'text-good'
        : up ? 'text-good' : 'text-bad';
  const arrow = flatish ? '=' : up ? '▲' : '▼';
  return (
    <span className={`text-[11.5px] font-medium ${color}`}>
      {arrow}
      {flatish ? '' : `${Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)}${unit}`}
    </span>
  );
}

/** ROAS pill, banded the way the closing protocol bands it. */
export function Roas({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted">–</span>;
  const cls =
    v >= 1.6 ? 'bg-good/15 text-good'
      : v >= 1.0 ? 'bg-warn/15 text-warn'
        : 'bg-bad/15 text-bad';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[12px] font-medium tabular-nums ${cls}`}>
      {v.toFixed(2)}
    </span>
  );
}

/* ── table ──────────────────────────────────────────────────────────────── */

export type Col<T> = {
  key: string;
  head: string;
  align?: 'l' | 'r';
  render: (row: T) => ReactNode;
  /** Column width hint, e.g. 'w-40'. */
  w?: string;
};

export function Table<T>({
  cols, rows, footer, empty = 'Nothing here yet.',
}: { cols: Col<T>[]; rows: T[]; footer?: T; empty?: string }) {
  if (!rows.length) return <p className="py-6 text-center text-[12px] text-muted">{empty}</p>;
  const cell = (c: Col<T>) =>
    `px-3 py-2 ${c.align === 'r' ? 'text-right tabular-nums' : 'text-left'} ${c.w ?? ''}`;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-edge">
            {cols.map((c) => (
              <th key={c.key} className={`${cell(c)} text-[10.5px] uppercase tracking-[0.12em] text-muted font-medium`}>
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-edge/50 last:border-0 hover:bg-white/[0.03]">
              {cols.map((c) => <td key={c.key} className={cell(c)}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr className="border-t border-edge bg-white/[0.04] font-medium">
              {cols.map((c) => <td key={c.key} className={cell(c)}>{c.render(footer)}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/* ── state ──────────────────────────────────────────────────────────────── */

export function Note({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'warn' }) {
  const cls = kind === 'warn'
    ? 'border-warn/30 bg-warn/[0.07] text-[#e8d3a8]'
    : 'border-edge bg-panel/40 text-muted';
  return <div className={`rounded-lg border px-3.5 py-2.5 text-[12px] leading-relaxed ${cls}`}>{children}</div>;
}

export function Planned({ what, source }: { what: string; source: string }) {
  return (
    <Card>
      <div className="py-8 text-center">
        <div className="text-[13px] text-[#dbe3ec]">Not built yet</div>
        <p className="mx-auto mt-2 max-w-md text-[12px] leading-relaxed text-muted">
          {what} It will read from <span className="text-[#c3ccd7]">{source}</span>. Showing
          nothing is deliberate — an empty chart here would read as a zero.
        </p>
      </div>
    </Card>
  );
}

export function Crumb({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-[12px] text-muted underline-offset-2 hover:text-gold hover:underline">
      {children}
    </Link>
  );
}
