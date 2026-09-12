import { q, n } from './db';
import { PORTALS } from './ads';

/**
 * The 7-days+ continuous book: campaigns old enough to have left learning,
 * still running, and delivering every day.
 *
 * "Continuous" is the load-bearing word. Age alone returns 355 campaigns —
 * most of them long dead. What the report is about is the stable book: still
 * ACTIVE, and spent on all seven of the last seven days. A campaign that
 * skipped days is not continuous even if it is old, and its 7-day ROAS is an
 * average over a different number of days than its neighbours'.
 */
export interface ContinuousRow {
  campaignId: string;
  campaignName: string;
  portal: string;
  age: number;
  budget: number;
  spend7: number;
  revenue7: number;
  roas7: number;
  daysSpent: number;
  spendToday: number;
  revenueToday: number;
}

export const MIN_AGE = 8;

export async function continuousBook(
  portals: readonly string[] = PORTALS,
  minDays = 7,
): Promise<ContinuousRow[]> {
  const rows = await q(
    `WITH fs AS (
       SELECT campaign_id, MIN(date) AS fd
         FROM meta_analysis_campaign_daily WHERE spend > 0 GROUP BY 1
     ),
     win AS (
       SELECT d.campaign_id,
              (ARRAY_AGG(d.portal ORDER BY d.date DESC))[1]        AS portal,
              (ARRAY_AGG(d.campaign_name ORDER BY d.date DESC))[1] AS campaign_name,
              COUNT(*) FILTER (WHERE d.spend > 0)                  AS days_spent,
              SUM(d.spend)                                         AS spend7,
              SUM(d.revenue)                                       AS revenue7,
              SUM(d.spend)   FILTER (WHERE d.date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS sp_today,
              SUM(d.revenue) FILTER (WHERE d.date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS rv_today
         FROM meta_analysis_campaign_daily d
        WHERE d.date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 8
          AND d.portal = ANY($1)
        GROUP BY 1
     ),
     live AS (
       SELECT DISTINCT ON (campaign_id) campaign_id, effective_status, daily_budget
         FROM meta_campaign_snapshot
        WHERE snapshot_at >= NOW() - INTERVAL '1 day'
        ORDER BY campaign_id, snapshot_at DESC
     )
     SELECT w.campaign_id, w.campaign_name, w.portal,
            ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - f.fd) + 1 AS age,
            COALESCE(l.daily_budget, 0) AS budget,
            w.days_spent, w.spend7, w.revenue7,
            COALESCE(w.sp_today, 0) AS sp_today,
            COALESCE(w.rv_today, 0) AS rv_today
       FROM win w
       JOIN fs f   ON f.campaign_id = w.campaign_id
       JOIN live l ON l.campaign_id = w.campaign_id
      WHERE l.effective_status = 'ACTIVE'
        AND ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - f.fd) + 1 >= $2::int
        AND w.days_spent >= $3::int
        AND w.spend7 > 0
      ORDER BY w.revenue7 / NULLIF(w.spend7, 0) DESC NULLS LAST`,
    [portals as string[], MIN_AGE, minDays],
  );
  return rows.map((r) => {
    const spend7 = n(r.spend7), revenue7 = n(r.revenue7);
    return {
      campaignId: String(r.campaign_id),
      campaignName: String(r.campaign_name ?? ''),
      portal: String(r.portal),
      age: n(r.age),
      budget: n(r.budget),
      spend7, revenue7,
      roas7: spend7 > 0 ? revenue7 / spend7 : 0,
      daysSpent: n(r.days_spent),
      spendToday: n(r.sp_today),
      revenueToday: n(r.rv_today),
    };
  });
}

/**
 * The bands the report uses. Ordered best first, and expressed as a lower
 * bound so "below 1.0" is the last row rather than a special case.
 */
export const ROAS_BANDS = [
  { key: 'b18', label: '≥ 1.8×', lo: 1.8, hi: Infinity },
  { key: 'b14', label: '1.4-1.8×', lo: 1.4, hi: 1.8 },
  { key: 'b115', label: '1.15-1.4×', lo: 1.15, hi: 1.4 },
  { key: 'b10', label: '1.0-1.15×', lo: 1.0, hi: 1.15 },
  { key: 'b0', label: '< 1.0×', lo: -Infinity, hi: 1.0 },
];

export const bandOf = (roas: number) =>
  ROAS_BANDS.find((b) => roas >= b.lo && roas < b.hi) ?? ROAS_BANDS[ROAS_BANDS.length - 1];

export interface Agg {
  camps: number; budget: number; spend7: number; revenue7: number;
}

export function sum(rows: ContinuousRow[]): Agg {
  return rows.reduce(
    (a, r) => ({
      camps: a.camps + 1,
      budget: a.budget + r.budget,
      spend7: a.spend7 + r.spend7,
      revenue7: a.revenue7 + r.revenue7,
    }),
    { camps: 0, budget: 0, spend7: 0, revenue7: 0 },
  );
}

/** Weighted ROAS — total revenue over total spend, never a mean of ratios. */
export const wtdRoas = (a: Agg) => (a.spend7 > 0 ? a.revenue7 / a.spend7 : 0);
