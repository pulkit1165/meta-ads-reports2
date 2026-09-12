import { q, n } from './db';
import { PORTALS } from './ads';

/**
 * Portfolio by campaign age, against a ROAS target per band.
 *
 * A campaign's age is counted from the first day it actually SPENT, not from
 * when it was created. A campaign built on Monday and switched on Thursday is
 * on day 1 on Thursday — Meta's learning phase starts with delivery, and the
 * closing ladder gates on the same idea.
 *
 * "Day 1" overlaps "Day 1-3" deliberately: it is shown as a subset so today's
 * launches can be read on their own, which is why the bands below do not sum
 * to the total. TOTAL is Day 1-3 + Day 4-7 + Day 8+.
 */
export interface Band {
  key: string;
  label: string;
  /** inclusive day numbers */
  lo: number;
  hi: number;
  target: number;
  /** true when the band is a subset of another and must not be summed */
  subset?: boolean;
}

export const BANDS: Band[] = [
  { key: 'd1', label: 'Day 1 (today’s launches)', lo: 1, hi: 1, target: 1.15, subset: true },
  { key: 'd13', label: 'Day 1-3', lo: 1, hi: 3, target: 1.40 },
  { key: 'd47', label: 'Day 4-7', lo: 4, hi: 7, target: 1.60 },
  { key: 'd8', label: '7 days+', lo: 8, hi: 100000, target: 1.80 },
];

export const bandOfDay = (day: number): Band[] =>
  BANDS.filter((b) => day >= b.lo && day <= b.hi);

export interface PortfolioRow {
  date: string;
  bandKey: string;
  camps: number;
  budget: number;
  spend: number;
  revenue: number;
  /** budget switched off during that day, for campaigns in this band */
  closedBudget: number;
  closedCamps: number;
  closedSpend: number;
  closedRevenue: number;
}

/**
 * Per day, per age band: what the book looked like and how much of it closed.
 *
 * Budget is taken as the largest daily_budget seen in that day's snapshots —
 * a campaign whose budget was raised mid-day had that allowance available, and
 * the last snapshot alone would miss a campaign closed before it.
 */
export async function portfolio(
  from: string,
  to: string,
  portals: readonly string[] = PORTALS,
): Promise<PortfolioRow[]> {
  const rows = await q(
    `WITH first_spend AS (
       SELECT campaign_id, MIN(date) AS fd
         FROM meta_analysis_campaign_daily
        WHERE spend > 0
        GROUP BY 1
     ),
     daily AS (
       SELECT d.date, d.campaign_id, d.spend, d.revenue,
              (d.date - f.fd) + 1 AS day_no
         FROM meta_analysis_campaign_daily d
         JOIN first_spend f ON f.campaign_id = d.campaign_id
        WHERE d.date BETWEEN $1::date AND $2::date
          AND d.portal = ANY($3)
     ),
     -- camp_day_state is a daily rollup of the snapshots. Today is not in it
     -- until the next refresh, so today's row is computed live and unioned in —
     -- one day is cheap, a fortnight of raw snapshots is not.
     today_state AS (
       SELECT (snapshot_at AT TIME ZONE 'Asia/Kolkata')::date AS d, campaign_id,
              MAX(daily_budget) AS budget,
              BOOL_OR(effective_status = 'ACTIVE') AS ever_active,
              (ARRAY_AGG(effective_status ORDER BY snapshot_at DESC))[1] <> 'ACTIVE' AS closed_at_eod
         FROM meta_campaign_snapshot
        WHERE snapshot_at >= ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - INTERVAL '5 hours 30 minutes')
        GROUP BY 1, 2
     ),
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
     joined AS (
       SELECT dl.date, dl.campaign_id, dl.day_no, dl.spend, dl.revenue,
              COALESCE(b.budget, 0) AS budget,
              COALESCE(b.ever_active, false) AS ever_active,
              COALESCE(b.closed_at_eod, true) AS closed_now
         FROM daily dl
         LEFT JOIN state b ON b.d = dl.date AND b.campaign_id = dl.campaign_id
     )
     SELECT date::text AS date, day_no,
            COUNT(*)                                                   AS camps,
            SUM(budget)                                                AS budget,
            SUM(spend)                                                 AS spend,
            SUM(revenue)                                               AS revenue,
            SUM(budget) FILTER (WHERE ever_active AND closed_now)      AS closed_budget,
            COUNT(*)    FILTER (WHERE ever_active AND closed_now)      AS closed_camps,
            SUM(spend)  FILTER (WHERE ever_active AND closed_now)      AS closed_spend,
            SUM(revenue) FILTER (WHERE ever_active AND closed_now)     AS closed_revenue
       FROM joined
      WHERE spend > 0 OR budget > 0
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [from, to, portals as string[]],
  );

  // Expand each day_no into every band it belongs to, so Day 1 can be both its
  // own row and part of Day 1-3 without the query having to know that.
  const out: PortfolioRow[] = [];
  const acc = new Map<string, PortfolioRow>();
  for (const r of rows) {
    const dayNo = n(r.day_no);
    for (const b of bandOfDay(dayNo)) {
      const k = `${r.date}|${b.key}`;
      const cur = acc.get(k) ?? {
        date: String(r.date), bandKey: b.key, camps: 0, budget: 0, spend: 0, revenue: 0,
        closedBudget: 0, closedCamps: 0, closedSpend: 0, closedRevenue: 0,
      };
      cur.camps += n(r.camps);
      cur.budget += n(r.budget);
      cur.spend += n(r.spend);
      cur.revenue += n(r.revenue);
      cur.closedBudget += n(r.closed_budget);
      cur.closedCamps += n(r.closed_camps);
      cur.closedSpend += n(r.closed_spend);
      cur.closedRevenue += n(r.closed_revenue);
      acc.set(k, cur);
    }
  }
  for (const v of acc.values()) out.push(v);
  return out;
}

export const roasOf = (rev: number, sp: number) => (sp > 0 ? rev / sp : 0);

export type Verdict = 'Above' | 'Near' | 'Below';

/** Within 0.10 of target reads as Near — closer than that is noise, not a miss. */
export function verdictOf(actual: number, target: number): Verdict {
  const d = actual - target;
  if (d >= 0) return 'Above';
  return d > -0.10 ? 'Near' : 'Below';
}

/** Rows for one day, in band order, plus the non-overlapping total. */
export function forDay(rows: PortfolioRow[], date: string) {
  const byBand = new Map(rows.filter((r) => r.date === date).map((r) => [r.bandKey, r]));
  const bands = BANDS.map((b) => ({ band: b, row: byBand.get(b.key) }));
  const total = BANDS.filter((b) => !b.subset).reduce(
    (a, b) => {
      const r = byBand.get(b.key);
      if (!r) return a;
      return {
        camps: a.camps + r.camps, budget: a.budget + r.budget,
        spend: a.spend + r.spend, revenue: a.revenue + r.revenue,
        closedBudget: a.closedBudget + r.closedBudget,
        closedCamps: a.closedCamps + r.closedCamps,
      };
    },
    { camps: 0, budget: 0, spend: 0, revenue: 0, closedBudget: 0, closedCamps: 0 },
  );
  return { bands, total };
}
