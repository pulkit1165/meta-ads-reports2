import type { ReactNode } from 'react';

/**
 * Hand-rolled SVG charts.
 *
 * A charting library would add ~150KB to every module for shapes this simple,
 * and none of them render server-side without a client boundary. These are
 * plain server components: no hydration, no bundle, and the palette stays the
 * one the printed reports already use.
 *
 * Palette is CVD-safe and matches the existing report images.
 */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#9b6ad4', '#5aa9a3'];

/** Bands used everywhere ROAS is bucketed, lowest first. */
export const ROAS_BANDS = [
  { key: 'zero', label: '0.00', color: '#7c2b26' },
  { key: 'b1', label: '0–0.25', color: '#b3402f' },
  { key: 'b2', label: '0.25–0.50', color: '#eb6834' },
  { key: 'b3', label: '0.50–0.75', color: '#eda100' },
  { key: 'b4', label: '0.75–1.00', color: '#b9b13c' },
  { key: 'b5', label: '1.00–1.50', color: '#5aa9a3' },
  { key: 'b6', label: '1.50–2.50', color: '#1baf7a' },
  { key: 'b7', label: '2.50+', color: '#2a78d6' },
];

function niceTicks(max: number, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const mult = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * mag >= raw) ?? 10;
  const step = mult * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

/* ── horizontal bars: ranked comparisons ────────────────────────────────── */

export function BarList({
  rows, fmt, max, color = SERIES[0],
}: {
  rows: { label: string; value: number; sub?: string; color?: string }[];
  fmt: (v: number) => string;
  max?: number;
  color?: string;
}) {
  const top = max ?? Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[12px]">
            <span className="truncate text-text-strong" title={r.label}>{r.label}</span>
            <span className="shrink-0 tabular-nums text-muted">
              {fmt(r.value)}{r.sub && <span className="ml-2 text-[11px]">{r.sub}</span>}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-tint">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(1.5, (r.value / top) * 100)}%`, background: r.color ?? color }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── stacked composition over time ──────────────────────────────────────── */

export function StackedBars({
  categories, series, fmt, height = 200,
}: {
  categories: string[];
  series: { key: string; label: string; color: string; values: number[] }[];
  fmt: (v: number) => string;
  height?: number;
}) {
  const totals = categories.map((_, i) => series.reduce((s, x) => s + (x.values[i] || 0), 0));
  const max = Math.max(...totals, 1);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const W = 100; // percentage-space; the svg scales with its box
  const bw = W / categories.length;

  return (
    <div>
      <div className="relative" style={{ height }}>
        {/* gridlines */}
        {ticks.map((t) => (
          <div
            key={t}
            className="absolute inset-x-0 border-t border-edge/50"
            style={{ bottom: `${(t / top) * 100}%` }}
          >
            <span className="absolute -top-2 left-0 bg-ink pr-1 text-[10px] text-muted">{fmt(t)}</span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end">
          {categories.map((c, i) => (
            <div key={c} className="flex h-full flex-col justify-end px-[3px]" style={{ width: `${bw}%` }}>
              {series.map((s) => {
                const v = s.values[i] || 0;
                if (v <= 0) return null;
                return (
                  <div
                    key={s.key}
                    title={`${c} · ${s.label} · ${fmt(v)}`}
                    style={{ height: `${(v / top) * 100}%`, background: s.color }}
                    className="w-full first:rounded-t"
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex">
        {categories.map((c) => (
          <div key={c} className="text-center text-[10px] text-muted" style={{ width: `${bw}%` }}>{c}</div>
        ))}
      </div>
    </div>
  );
}

/* ── 100% composition bar: where the spend sits ─────────────────────────── */

export function ShareBar({
  parts, fmt,
}: { parts: { label: string; value: number; color: string }[]; fmt: (v: number) => string }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div>
      <div className="flex h-7 overflow-hidden rounded-lg">
        {parts.map((p) =>
          p.value <= 0 ? null : (
            <div
              key={p.label}
              title={`${p.label} · ${fmt(p.value)} · ${((p.value / total) * 100).toFixed(1)}%`}
              style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
            />
          ),
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {parts.map((p) => (
          <div key={p.label} className="flex items-center gap-1.5 text-[11px]">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: p.color }} />
            <span className="text-text">{p.label}</span>
            <span className="tabular-nums text-muted">{((p.value / total) * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── line: a metric across days ─────────────────────────────────────────── */

export function Line({
  categories, series, fmt, height = 190, baseline,
}: {
  categories: string[];
  series: { label: string; color: string; values: (number | null)[] }[];
  fmt: (v: number) => string;
  height?: number;
  /** Draws a reference rule, e.g. ROAS 1.0. */
  baseline?: { value: number; label: string };
}) {
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const max = Math.max(...all, baseline?.value ?? 0, 0.0001);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const W = 1000, H = 300, PAD = 4;
  const x = (i: number) =>
    categories.length === 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (categories.length - 1);
  const y = (v: number) => H - (v / top) * H;

  return (
    <div>
      <div className="relative" style={{ height }}>
        {ticks.map((t) => (
          <div key={t} className="absolute inset-x-0 border-t border-edge/50" style={{ bottom: `${(t / top) * 100}%` }}>
            <span className="absolute -top-2 left-0 bg-ink pr-1 text-[10px] text-muted">{fmt(t)}</span>
          </div>
        ))}
        {baseline && (
          <div
            className="absolute inset-x-0 border-t border-dashed border-gold/50"
            style={{ bottom: `${(baseline.value / top) * 100}%` }}
          >
            <span className="absolute -top-2 right-0 bg-ink pl-1 text-[10px] text-gold/80">{baseline.label}</span>
          </div>
        )}
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {series.map((s) => {
            // Start the path at the first point that actually has a value —
            // beginning with an L on a null leaves a dot with no line.
            let d = '';
            s.values.forEach((v, i) => {
              if (v == null) return;
              d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
            });
            return (
              <path key={s.label} d={d.trim()} fill="none" stroke={s.color}
                    strokeWidth={2.5} vectorEffect="non-scaling-stroke"
                    strokeLinejoin="round" strokeLinecap="round" />
            );
          })}
          {series.map((s) =>
            s.values.map((v, i) =>
              v == null ? null : (
                <circle key={`${s.label}-${i}`} cx={x(i)} cy={y(v)} r={3.5}
                        fill="var(--panel)" stroke={s.color} strokeWidth={2}
                        vectorEffect="non-scaling-stroke" />
              ),
            ),
          )}
        </svg>
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted">
        {categories.map((c) => <span key={c}>{c}</span>)}
      </div>
      {series.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {series.map((s) => (
            <div key={s.label} className="flex items-center gap-1.5 text-[11px]">
              <span className="h-0.5 w-4" style={{ background: s.color }} />
              <span className="text-text">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1.5 text-[11px]">
          <span className="h-2 w-2 rounded-sm" style={{ background: i.color }} />
          <span className="text-text">{i.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-[12px] text-muted">{children}</p>;
}
