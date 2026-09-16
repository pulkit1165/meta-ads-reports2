import { q, n } from './db';
import { PORTALS, bandOf, roasOf, type BandKey, BAND_KEYS } from './ads';

/**
 * The book over a window, readable two ways from one pass of the data:
 * by calendar day, and by how old each campaign was on the day it ran.
 *
 * They answer different questions and neither substitutes for the other. The
 * calendar tells you which DAY went wrong; the age breakdown tells you which
 * COHORT it went wrong in. A day that closed 74% of its book and a cohort that
 * closes 87% of everything it is ever given are two separate problems that
 * happen to share the same rupees.
 *
 * One campaign-day is one row: a campaign that ran all seven days contributes
 * seven. That is what makes both cuts add up without double counting.
 */
export interface BookRow {
  date: string;
  campaignId: string;
  portal: string;
  /** 1 on the first day the campaign ever spent */
  dayNo: number;
  budget: number;
  spend: number;
  revenue: number;
  closed: boolean;
}

export interface BookAgg {
  key: string;
  /** sorts the row; for dates this is the date, for ages the day number */
  order: string | number;
  camps: number;
  allocated: number;
  spend: number;
  revenue: number;
  closedCamps: number;
  closedBudget: number;
  closedSpend: number;
  closedRevenue: number;
  /** how many CLOSED campaigns ended in each ROAS band */
  bands: Record<BandKey, number>;
  survived: number;
}

const empty = (key: string, order: string | number): BookAgg => ({
  key, order, camps: 0, allocated: 0, spend: 0, revenue: 0,
  closedCamps: 0, closedBudget: 0, closedSpend: 0, closedRevenue: 0,
  bands: Object.fromEntries(BAND_KEYS.map((k) => [k, 0])) as Record<BandKey, number>,
  survived: 0,
});

export async function closingBook(
  from: string,
  to: string,
  portals: readonly string[] = PORTALS,
): Promise<BookRow[]> {
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
     -- the rollup covers settled days; today is recomputed live because the
     -- rollup only refreshes each morning
     state AS (
       SELECT d, campaign_id, budget, ever_active, closed_at_eod
         FROM camp_day_state
        WHERE d BETWEEN $1::date AND $2::date
          AND d < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
       UNION ALL
       SELECT d, campaign_id, budget, ever_active, closed_at_eod
         FROM today_state WHERE d BETWEEN $1::date AND $2::date
     ),
     first_spend AS (
       SELECT campaign_id, MIN(date) AS fd
         FROM meta_analysis_campaign_daily WHERE spend > 0 GROUP BY 1
     )
     SELECT d.date::text AS date, d.campaign_id, d.portal,
            COALESCE((d.date - f.fd) + 1, 1) AS day_no,
            s.budget, d.spend, d.revenue, s.closed_at_eod AS closed
       FROM meta_analysis_campaign_daily d
       -- ever_active is the gate: budget parked on a campaign that never went
       -- live that day was never part of that day's book
       JOIN state s ON s.d = d.date AND s.campaign_id = d.campaign_id AND s.ever_active
       LEFT JOIN first_spend f ON f.campaign_id = d.campaign_id
      WHERE d.date BETWEEN $1::date AND $2::date AND d.portal = ANY($3)`,
    [from, to, portals as string[]],
  );

  return rows.map((r) => ({
    date: String(r.date),
    campaignId: String(r.campaign_id),
    portal: String(r.portal),
    dayNo: n(r.day_no),
    budget: n(r.budget),
    spend: n(r.spend),
    revenue: n(r.revenue),
    closed: Boolean(r.closed),
  }));
}

function fold(rows: BookRow[], keyOf: (r: BookRow) => [string, string | number]): BookAgg[] {
  const m = new Map<string, BookAgg>();
  for (const r of rows) {
    const [key, order] = keyOf(r);
    const a = m.get(key) ?? empty(key, order);
    a.camps += 1;
    a.allocated += r.budget;
    a.spend += r.spend;
    a.revenue += r.revenue;
    if (r.closed) {
      a.closedCamps += 1;
      a.closedBudget += r.budget;
      a.closedSpend += r.spend;
      a.closedRevenue += r.revenue;
      a.bands[bandOf(roasOf(r.revenue, r.spend))] += 1;
    } else {
      a.survived += 1;
    }
    m.set(key, a);
  }
  return [...m.values()];
}

/** One row per calendar day, newest first. */
export const byDate = (rows: BookRow[]): BookAgg[] =>
  fold(rows, (r) => [r.date, r.date]).sort((a, b) => String(b.order).localeCompare(String(a.order)));

/**
 * One row per campaign age, days 1-7 exactly and everything older folded into
 * a single row. Past a week the exact day stops meaning anything — day 23 and
 * day 41 are the same kind of campaign — and sparse single-campaign rows make
 * the table harder to read, not richer.
 */
export function byAge(rows: BookRow[]): BookAgg[] {
  return fold(rows, (r) => (r.dayNo >= 8 ? ['Day 8+', 8] : [`Day ${r.dayNo}`, r.dayNo]))
    .sort((a, b) => Number(a.order) - Number(b.order));
}

export function total(list: BookAgg[]): BookAgg {
  const t = empty('TOTAL', '');
  for (const a of list) {
    t.camps += a.camps; t.allocated += a.allocated; t.spend += a.spend; t.revenue += a.revenue;
    t.closedCamps += a.closedCamps; t.closedBudget += a.closedBudget;
    t.closedSpend += a.closedSpend; t.closedRevenue += a.closedRevenue;
    t.survived += a.survived;
    for (const b of BAND_KEYS) t.bands[b] += a.bands[b];
  }
  return t;
}

export const pctOfSafe = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
