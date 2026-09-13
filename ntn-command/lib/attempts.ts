import { q, n } from './db';
import { PORTALS, bandOf, type BandKey, BAND_KEYS } from './ads';

/**
 * How often a shape gets tried, and at what ROAS it dies.
 *
 * An ATTEMPT is one campaign-day that actually went live. The same campaign
 * running for five days is five attempts, because each day is a fresh bet: it
 * was funded again that morning and could have been switched off instead.
 * Counting distinct campaigns instead would say a product was "tried twice"
 * when it burnt budget for a fortnight.
 *
 * An attempt either ENDED THE DAY CLOSED or survived it. Only the closed ones
 * carry a ROAS band here — that is the question being asked: of everything we
 * tried, how much of it died, and how badly.
 */
export interface AttemptRow {
  product: string;
  saleBlock: string;
  creativeType: string;
  portals: string[];
  camps: number;
  attempts: number;
  closed: number;
  survived: number;
  /** counts of CLOSED attempts per ROAS band, lowest band first */
  bands: Record<BandKey, number>;
  budgetClosed: number;
  spend: number;
  revenue: number;
  roas: number;
}

const emptyBands = (): Record<BandKey, number> =>
  Object.fromEntries(BAND_KEYS.map((k) => [k, 0])) as Record<BandKey, number>;

export async function attempts(
  from: string,
  to: string,
  portals: readonly string[] = PORTALS,
): Promise<AttemptRow[]> {
  const rows = await q(
    `WITH today_state AS (
       SELECT (snapshot_at AT TIME ZONE 'Asia/Kolkata')::date AS d, campaign_id,
              MAX(daily_budget) AS budget,
              BOOL_OR(effective_status = 'ACTIVE') AS ever_active,
              (ARRAY_AGG(effective_status ORDER BY snapshot_at DESC))[1] <> 'ACTIVE' AS closed_at_eod
         FROM meta_campaign_snapshot
        WHERE snapshot_at >= ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - INTERVAL '5 hours 30 minutes')
        GROUP BY 1, 2
     ),
     -- camp_day_state is the daily rollup; today is not in it until the next
     -- refresh, so today is recomputed live and unioned in.
     state AS (
       SELECT d, campaign_id, budget, ever_active, closed_at_eod
         FROM camp_day_state
        WHERE d BETWEEN $1::date AND $2::date
          AND d < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
       UNION ALL
       SELECT d, campaign_id, budget, ever_active, closed_at_eod
         FROM today_state
        WHERE d BETWEEN $1::date AND $2::date
     ),
     daily AS (
       SELECT date, campaign_id, portal,
              COALESCE(NULLIF(sale_block, ''), 'Loose')      AS sale_block,
              COALESCE(NULLIF(creative_type, ''), 'unknown') AS creative_type,
              spend, revenue
         FROM meta_analysis_campaign_daily
        WHERE date BETWEEN $1::date AND $2::date AND portal = ANY($3)
     ),
     j AS (
       SELECT COALESCE(NULLIF(pr.product, ''), 'unmapped') AS product,
              dl.sale_block, dl.creative_type, dl.portal, dl.campaign_id,
              dl.spend, dl.revenue,
              CASE WHEN dl.spend > 0 THEN dl.revenue / dl.spend ELSE 0 END AS roas,
              COALESCE(s.budget, 0) AS budget,
              s.closed_at_eod AS closed
         FROM daily dl
         -- ever_active is the gate: budget parked on a campaign that never went
         -- live that day was not an attempt at anything.
         JOIN state s ON s.d = dl.date AND s.campaign_id = dl.campaign_id AND s.ever_active
         LEFT JOIN camp_product_resolved pr ON pr.campaign_id = dl.campaign_id
     )
     SELECT product, sale_block, creative_type,
            ARRAY_AGG(DISTINCT portal)      AS portals,
            COUNT(DISTINCT campaign_id)     AS camps,
            COUNT(*)                        AS attempts,
            COUNT(*) FILTER (WHERE closed)  AS closed,
            COUNT(*) FILTER (WHERE closed AND roas <= 0)                    AS zero,
            COUNT(*) FILTER (WHERE closed AND roas > 0    AND roas < 0.25)  AS b1,
            COUNT(*) FILTER (WHERE closed AND roas >= 0.25 AND roas < 0.5)  AS b2,
            COUNT(*) FILTER (WHERE closed AND roas >= 0.5  AND roas < 0.75) AS b3,
            COUNT(*) FILTER (WHERE closed AND roas >= 0.75 AND roas < 1)    AS b4,
            COUNT(*) FILTER (WHERE closed AND roas >= 1    AND roas < 1.5)  AS b5,
            COUNT(*) FILTER (WHERE closed AND roas >= 1.5  AND roas < 2.5)  AS b6,
            COUNT(*) FILTER (WHERE closed AND roas >= 2.5)                  AS b7,
            SUM(budget)  FILTER (WHERE closed) AS budget_closed,
            SUM(spend)   AS spend,
            SUM(revenue) AS revenue
       FROM j
      GROUP BY 1, 2, 3`,
    [from, to, portals as string[]],
  );

  return rows.map((r) => {
    const spend = n(r.spend), revenue = n(r.revenue);
    const tried = n(r.attempts), closed = n(r.closed);
    return {
      product: String(r.product),
      saleBlock: String(r.sale_block),
      creativeType: String(r.creative_type),
      portals: ((r.portals as string[]) ?? []).slice().sort(),
      camps: n(r.camps),
      attempts: tried,
      closed,
      survived: tried - closed,
      bands: {
        zero: n(r.zero), b1: n(r.b1), b2: n(r.b2), b3: n(r.b3),
        b4: n(r.b4), b5: n(r.b5), b6: n(r.b6), b7: n(r.b7),
      },
      budgetClosed: n(r.budget_closed),
      spend, revenue,
      roas: spend > 0 ? revenue / spend : 0,
    };
  });
}

/* ── grain ──────────────────────────────────────────────────────────────── */

export type Grain = 'pbc' | 'pb' | 'p' | 'b' | 'c';

export const GRAINS: { key: Grain; label: string }[] = [
  { key: 'pbc', label: 'Product × block × creative' },
  { key: 'pb', label: 'Product × block' },
  { key: 'p', label: 'Product' },
  { key: 'b', label: 'Sales block' },
  { key: 'c', label: 'Creative type' },
];

const keyOf = (r: AttemptRow, g: Grain) =>
  g === 'pbc' ? JSON.stringify([r.product, r.saleBlock, r.creativeType])
    : g === 'pb' ? JSON.stringify([r.product, r.saleBlock])
      : g === 'p' ? r.product
        : g === 'b' ? r.saleBlock
          : r.creativeType;

/**
 * Roll the finest grain up to a coarser one.
 *
 * The fine rows are disjoint — one campaign-day lands in exactly one
 * (product, block, creative) cell — so every count adds without double
 * counting. That is also why the creative type stays the whole pipe-joined
 * string here rather than being split into tags the way the reports that rank
 * styles do: "Paras | Motion" is one shape somebody chose, not two.
 */
export function rollup(rows: AttemptRow[], g: Grain): AttemptRow[] {
  if (g === 'pbc') return rows;
  const m = new Map<string, AttemptRow>();
  for (const r of rows) {
    const k = keyOf(r, g);
    let a = m.get(k);
    if (!a) {
      a = {
        product: g === 'b' || g === 'c' ? '—' : r.product,
        saleBlock: g === 'pb' || g === 'b' ? r.saleBlock : '—',
        creativeType: g === 'c' ? r.creativeType : '—',
        portals: [], camps: 0, attempts: 0, closed: 0, survived: 0,
        bands: emptyBands(), budgetClosed: 0, spend: 0, revenue: 0, roas: 0,
      };
      m.set(k, a);
    }
    a.camps += r.camps;
    a.attempts += r.attempts;
    a.closed += r.closed;
    a.survived += r.survived;
    a.budgetClosed += r.budgetClosed;
    a.spend += r.spend;
    a.revenue += r.revenue;
    for (const b of BAND_KEYS) a.bands[b] += r.bands[b];
    for (const p of r.portals) if (!a.portals.includes(p)) a.portals.push(p);
  }
  return [...m.values()].map((a) => ({
    ...a, portals: a.portals.sort(), roas: a.spend > 0 ? a.revenue / a.spend : 0,
  }));
}

/* ── reading a row ──────────────────────────────────────────────────────── */

/** Closed at a ROAS the closing ladder treats as failure — under 0.75. */
export const diedBad = (r: AttemptRow) => r.bands.zero + r.bands.b1 + r.bands.b2 + r.bands.b3;
/** Closed while at or above break-even. */
export const diedGood = (r: AttemptRow) => r.bands.b5 + r.bands.b6 + r.bands.b7;
export const closeRate = (r: AttemptRow) => (r.attempts > 0 ? (r.closed / r.attempts) * 100 : 0);
/** Share of every attempt that ended dead under 0.75 — the waste rate. */
export const wasteRate = (r: AttemptRow) => (r.attempts > 0 ? (diedBad(r) / r.attempts) * 100 : 0);

export { bandOf };
