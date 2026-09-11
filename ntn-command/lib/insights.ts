/**
 * The analysis layer.
 *
 * This is arithmetic, not a language model. There is no LLM key on this
 * project, and a fabricated narrative over real money would be worse than no
 * narrative at all — so every finding below is computed from the numbers on the
 * page and states the figures it rests on. The UI labels it as computed rather
 * than calling it AI.
 *
 * A finding earns its place by being actionable or surprising. "Spend was
 * Rs 8L" is not a finding; "one block holds 41% of spend and returns 0.3" is.
 */
export type Severity = 'critical' | 'watch' | 'good' | 'neutral';

export interface Finding {
  severity: Severity;
  headline: string;
  detail: string;
  /** What to do about it, when there is something to do. */
  action?: string;
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0, watch: 1, good: 2, neutral: 3,
};

export function rank(findings: Finding[], limit = 6): Finding[] {
  return [...findings]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, limit);
}

/* ── shared statistics ──────────────────────────────────────────────────── */

export const pctOf = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

/**
 * Wilson score interval — a hit rate of 1/1 is not 100%, and a naive
 * proportion invites exactly that mistake on small samples.
 */
export function wilson(hits: number, n: number): { rate: number; lo: number; hi: number } {
  if (n <= 0) return { rate: 0, lo: 0, hi: 0 };
  const z = 1.96, p = hits / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { rate: p * 100, lo: Math.max(0, ((c - s) / d) * 100), hi: Math.min(1, (c + s) / d) * 100 };
}

/** Enough evidence to say something at all. */
export const enough = (n: number, min = 12) => n >= min;

/** Median absolute deviation — outlier detection that a single spike cannot move. */
export function outliers<T>(rows: T[], value: (r: T) => number, k = 3): T[] {
  if (rows.length < 5) return [];
  const vs = rows.map(value).sort((a, b) => a - b);
  const med = vs[Math.floor(vs.length / 2)];
  const devs = vs.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = devs[Math.floor(devs.length / 2)] || 1;
  return rows.filter((r) => Math.abs(value(r) - med) > k * mad);
}

/**
 * How concentrated a distribution is: the share held by the largest member.
 * High concentration is a risk statement, not a verdict — one block carrying
 * most of the spend is fine if it returns, and fatal if it does not.
 */
export function concentration<T>(rows: T[], weight: (r: T) => number) {
  const total = rows.reduce((s, r) => s + weight(r), 0);
  if (!total) return { topShare: 0, top: null as T | null, total: 0 };
  const sorted = [...rows].sort((a, b) => weight(b) - weight(a));
  return { topShare: pctOf(weight(sorted[0]), total), top: sorted[0], total };
}

/** Slope of a series, as % change per step, using a least-squares fit. */
export function trend(values: number[]): number | null {
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 4) return null;
  const n = pts.length;
  const meanX = (n - 1) / 2;
  const meanY = pts.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  pts.forEach((y, x) => {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  });
  if (!den || !meanY) return null;
  return ((num / den) / meanY) * 100;
}

export const money = (v: number) =>
  Math.abs(v) >= 100000 ? `Rs ${(v / 100000).toFixed(2)}L` : `Rs ${Math.round(v).toLocaleString('en-IN')}`;

/* ── volatility ─────────────────────────────────────────────────────────── */

/**
 * Coefficient of variation: standard deviation as a share of the mean.
 *
 * This is the right measure for comparing the steadiness of things that run at
 * different levels — a campaign averaging 3.0 ROAS and one averaging 0.5 cannot
 * be compared on standard deviation alone, because the same absolute swing means
 * something very different at each level.
 *
 * Returns null below `min` points: volatility over three days is noise about
 * noise, and reporting it would rank the thinnest series as the most extreme.
 */
export function cv(values: number[], min = 5): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < min) return null;
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  if (mean <= 0) return null;
  const variance = xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length;
  return (Math.sqrt(variance) / mean) * 100;
}

export interface Steadiness<T> {
  key: string;
  item: T;
  mean: number;
  cvPct: number;
  points: number;
}

/**
 * Rank a set of series by how steady they are. `steady` is ascending CV — the
 * things you can plan around — and `erratic` descending.
 */
export function steadiness<T>(
  items: T[],
  keyOf: (t: T) => string,
  seriesOf: (t: T) => number[],
  minPoints = 5,
): { steady: Steadiness<T>[]; erratic: Steadiness<T>[] } {
  const scored: Steadiness<T>[] = [];
  for (const item of items) {
    const xs = seriesOf(item).filter((v) => Number.isFinite(v));
    const c = cv(xs, minPoints);
    if (c == null) continue;
    scored.push({
      key: keyOf(item),
      item,
      mean: xs.reduce((s, v) => s + v, 0) / xs.length,
      cvPct: c,
      points: xs.length,
    });
  }
  return {
    steady: [...scored].sort((a, b) => a.cvPct - b.cvPct),
    erratic: [...scored].sort((a, b) => b.cvPct - a.cvPct),
  };
}
