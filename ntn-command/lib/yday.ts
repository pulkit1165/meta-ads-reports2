import { q, n } from './db';
import { PORTALS } from './ads';

/**
 * The "NTN Yesterday Final" figures, as the printed report defines them.
 *
 * Sales and orders come from Shopify, spend from Meta, and ROAS is the first
 * divided by the second — the blended number the team actually runs on, not the
 * pixel's own attribution.
 *
 * Budget is split live/closed at the 22:00 IST snapshot, falling back to the
 * last snapshot of the day when 22:00 is missing, which is how the existing
 * PNG has always drawn it. Keeping that definition means the dashboard and the
 * image can be put side by side without the numbers arguing.
 */
export interface YdayRow {
  portal: string;
  sales: number;
  orders: number;
  budget: number;
  spend: number;
  closed: number;
  live: number;
}

export async function ydayFinal(
  day: string,
  portals: readonly string[] = PORTALS,
): Promise<YdayRow[]> {
  const rows = await q(
    `WITH snaps AS (
       SELECT * FROM meta_campaign_snapshot
        WHERE snapshot_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
          AND snapshot_at <  ($1::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
     ),
     slot AS (
       -- the capture at or before 22:00 IST, else the last one of the day
       SELECT COALESCE(
         (SELECT max(snapshot_at) FROM snaps
           WHERE (snapshot_at AT TIME ZONE 'Asia/Kolkata')::time <= TIME '22:00'),
         (SELECT max(snapshot_at) FROM snaps)
       ) AS ts
     ),
     ever AS (
       -- a campaign counts as allocated if it was live at any point that day
       SELECT campaign_id, max(daily_budget) AS budget
         FROM snaps WHERE effective_status = 'ACTIVE' GROUP BY 1
     ),
     at_slot AS (
       SELECT s.campaign_id, s.effective_status
         FROM snaps s, slot WHERE s.snapshot_at = slot.ts
     ),
     portal_of AS (
       SELECT DISTINCT campaign_id, portal
         FROM meta_analysis_campaign_daily
        WHERE date = $1::date AND portal = ANY($2)
     ),
     budgets AS (
       SELECT p.portal,
              SUM(e.budget)                                                     AS budget,
              SUM(e.budget) FILTER (WHERE COALESCE(a.effective_status,'GONE') <> 'ACTIVE') AS closed,
              SUM(e.budget) FILTER (WHERE a.effective_status = 'ACTIVE')        AS live
         FROM ever e
         JOIN portal_of p ON p.campaign_id = e.campaign_id
         LEFT JOIN at_slot a ON a.campaign_id = e.campaign_id
        GROUP BY 1
     ),
     spends AS (
       SELECT portal, SUM(spend) AS spend
         FROM meta_analysis_campaign_daily
        WHERE date = $1::date AND portal = ANY($2)
        GROUP BY 1
     ),
     shop AS (
       SELECT store AS portal, COUNT(*) AS orders, COALESCE(SUM(total_price),0) AS sales
         FROM shopify_orders
        -- created_date is TEXT; $1 is cast to date elsewhere in this query, so
        -- without an explicit ::text the planner infers a date and the
        -- comparison fails with "operator does not exist: text = date".
        WHERE created_date = $1::text AND store = ANY($2)
          AND COALESCE(cancelled_at,'') = ''
          AND COALESCE(source_name,'') <> 'Matrixify App'
        GROUP BY 1
     )
     SELECT p AS portal,
            COALESCE(sh.sales,0)  AS sales,
            COALESCE(sh.orders,0) AS orders,
            COALESCE(b.budget,0)  AS budget,
            COALESCE(sp.spend,0)  AS spend,
            COALESCE(b.closed,0)  AS closed,
            COALESCE(b.live,0)    AS live
       FROM unnest($2::text[]) AS p
       LEFT JOIN budgets b  ON b.portal  = p
       LEFT JOIN spends  sp ON sp.portal = p
       LEFT JOIN shop    sh ON sh.portal = p`,
    [day, portals as string[]],
  );
  return rows.map((r) => ({
    portal: String(r.portal),
    sales: n(r.sales),
    orders: n(r.orders),
    budget: n(r.budget),
    spend: n(r.spend),
    closed: n(r.closed),
    live: n(r.live),
  }));
}

export function totalRow(rows: YdayRow[]): YdayRow {
  return rows.reduce(
    (a, r) => ({
      portal: 'All',
      sales: a.sales + r.sales,
      orders: a.orders + r.orders,
      budget: a.budget + r.budget,
      spend: a.spend + r.spend,
      closed: a.closed + r.closed,
      live: a.live + r.live,
    }),
    { portal: 'All', sales: 0, orders: 0, budget: 0, spend: 0, closed: 0, live: 0 },
  );
}

/** Percentage change, or null when there is no base to compare against. */
export const chg = (now: number, before: number): number | null =>
  before > 0 ? ((now - before) / before) * 100 : null;
