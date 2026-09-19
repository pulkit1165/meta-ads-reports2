import { q, n } from './db';
import { PORTALS, PORTAL_NAME } from './ads';

/**
 * Where every website stands right now, against the same point yesterday.
 *
 * The hour is the whole point of this module. At 11:00 a day is a third done,
 * so holding it against yesterday's FINAL numbers always reports a collapse
 * that has not happened. Yesterday is therefore cut at the same clock time,
 * and every comparison here is like for like.
 *
 * Sales come from Shopify with cancellations excluded, spend from Meta. They
 * are different systems measuring different things, and ROAS here is the
 * honest ratio of the two — shop revenue over ad spend — not Meta's own
 * attributed figure, which counts conversions the shop never recorded.
 */
export interface SiteNow {
  portal: string;
  name: string;
  sales: number;
  orders: number;
  spend: number;
  roas: number;
  /** same measures, yesterday up to this clock time */
  ySales: number;
  yOrders: number;
  ySpend: number;
  yRoas: number;
  /** yesterday's FULL day return, for context on where today may land */
  ydayFinal: number;
  budgetLive: number;
  budgetLeft: number;
  camps: number;
  activeCamps: number;
  closedBudget: number;
  allocated: number;
  products: number;
}

export interface HourRow {
  portal: string;
  name: string;
  sales: number;
  orders: number;
  spend: number;
  roas: number;
  budgetLive: number;
  pSales: number;
  pOrders: number;
  pSpend: number;
  pRoas: number;
}

export interface TodayRead {
  /** IST clock time of the newest campaign snapshot */
  cutIST: string;
  /** the complete hour the hourly table covers, e.g. "11:00-11:59" */
  hourLabel: string;
  sites: SiteNow[];
  hours: HourRow[];
}

const nameOf = (p: string) => PORTAL_NAME[p] ?? p;

export async function todayRead(portals: readonly string[] = PORTALS): Promise<TodayRead> {
  const codes = portals as string[];

  const [snap, sales, hourly, finals] = await Promise.all([
    // campaign state: today's newest snapshot, and yesterday's at the same
    // clock time so spend is compared over equal parts of the day
    q(
      // The day is expressed as a half-open range on snapshot_at rather than a
      // date cast of it. The cast is not sargable: it made every read of this
      // page scan all 766MB of meta_campaign_snapshot, which is why the page
      // got slower every day the table grew — 2.3s in September against 57ms
      // for the same answer through the (snapshot_at, campaign_id) index.
      // Yesterday's cut is likewise "the same instant a day earlier" instead
      // of a time-of-day comparison, which is the same thing and indexable.
      `WITH bounds AS (
         SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::timestamp
                  AT TIME ZONE 'Asia/Kolkata' AS t0,
                (((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 1))::timestamp
                  AT TIME ZONE 'Asia/Kolkata' AS t1,
                (((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 1))::timestamp
                  AT TIME ZONE 'Asia/Kolkata' AS y0
       ),
       today AS (
         SELECT s.* FROM meta_campaign_snapshot s, bounds b
          WHERE s.snapshot_at >= b.t0 AND s.snapshot_at < b.t1
       ),
       cut AS (SELECT MAX(snapshot_at) AS ts FROM today),
       ycut AS (
         SELECT MAX(s.snapshot_at) AS ts
           FROM meta_campaign_snapshot s, bounds b, cut c
          WHERE s.snapshot_at >= b.y0 AND s.snapshot_at < b.t0
            AND s.snapshot_at <= c.ts - INTERVAL '1 day'
       ),
       ever AS (SELECT DISTINCT campaign_id FROM today WHERE effective_status = 'ACTIVE'),
       dims AS (
         SELECT DISTINCT ON (campaign_id) campaign_id, portal
           FROM meta_analysis_campaign_daily
          WHERE date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND portal = ANY($1)
       )
       SELECT d.portal,
              COUNT(*)                                                   AS camps,
              COUNT(*) FILTER (WHERE s.effective_status = 'ACTIVE')       AS active_camps,
              SUM(s.daily_budget)                                         AS allocated,
              SUM(s.daily_budget) FILTER (WHERE s.effective_status = 'ACTIVE')  AS budget_live,
              SUM(s.daily_budget) FILTER (WHERE s.effective_status <> 'ACTIVE') AS closed_budget,
              SUM(s.spend_today)                                          AS spend,
              SUM(s.spend_today) FILTER (WHERE s.effective_status = 'ACTIVE')   AS spend_live,
              (SELECT COALESCE(SUM(y.spend_today), 0)
                 FROM meta_campaign_snapshot y, ycut
                WHERE y.snapshot_at = ycut.ts AND y.campaign_id IN
                      (SELECT campaign_id FROM dims WHERE portal = d.portal)) AS y_spend,
              (SELECT to_char(ts AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') FROM cut) AS cut
         FROM meta_campaign_snapshot s
         JOIN dims d ON d.campaign_id = s.campaign_id
         JOIN ever e ON e.campaign_id = s.campaign_id
        WHERE s.snapshot_at = (SELECT ts FROM cut)
        GROUP BY d.portal`,
      [codes],
    ),

    // Shopify, cancellations excluded. created_at is TEXT holding an ISO
    // string with the +05:30 offset, so it sorts lexically and a text range is
    // both correct and index-friendly — casting it would lose the index.
    //
    // Sales are cut at the SAME instant as the spend snapshot, not at NOW().
    // Spend above comes from the newest campaign snapshot (10-20 min old);
    // counting sales to the second while spend stops at the snapshot paired
    // fresh revenue with stale cost and read ~0.1-0.2 ROAS high all morning —
    // which is why this page used to disagree with the WhatsApp table, whose
    // :58 capture pairs both sides at one moment. Now both reports use the
    // same method: everything "data through" one instant.
    q(
      `WITH cut AS (
         SELECT COALESCE(
                  (SELECT MAX(snapshot_at) FROM meta_campaign_snapshot
                    WHERE snapshot_at >= ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::timestamp
                                           AT TIME ZONE 'Asia/Kolkata'),
                  NOW()) AS ts
       ),
       b AS (
         SELECT to_char((ts AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD')       AS t0,
                to_char(ts AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI')      AS t1,
                to_char((ts AT TIME ZONE 'Asia/Kolkata')::date - 1, 'YYYY-MM-DD')   AS y0,
                to_char((ts AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 day', 'YYYY-MM-DD"T"HH24:MI') AS y1,
                to_char((ts AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD')       AS yend
           FROM cut
       )
       SELECT o.store,
              COUNT(*)      FILTER (WHERE o.created_at >= b.t0 AND o.created_at < b.t1) AS orders,
              COALESCE(SUM(o.total_price) FILTER (WHERE o.created_at >= b.t0 AND o.created_at < b.t1), 0) AS sales,
              COUNT(*)      FILTER (WHERE o.created_at >= b.y0 AND o.created_at < b.y1) AS y_orders,
              COALESCE(SUM(o.total_price) FILTER (WHERE o.created_at >= b.y0 AND o.created_at < b.y1), 0) AS y_sales,
              COALESCE(SUM(o.total_price) FILTER (WHERE o.created_at >= b.y0 AND o.created_at < b.yend), 0) AS y_full
         FROM shopify_orders o, b
        WHERE o.store = ANY($1)
          AND COALESCE(o.cancelled_at, '') = ''
          AND o.created_at >= b.y0
        GROUP BY o.store`,
      [codes],
    ),

    // the last COMPLETE hour, and the one before it
    q(
      `WITH b AS (
         SELECT date_trunc('hour', NOW() AT TIME ZONE 'Asia/Kolkata') AS h0
       ),
       w AS (
         SELECT to_char(b.h0 - INTERVAL '1 hour', 'YYYY-MM-DD"T"HH24:MI') AS a,
                to_char(b.h0,                     'YYYY-MM-DD"T"HH24:MI') AS z,
                to_char(b.h0 - INTERVAL '2 hours', 'YYYY-MM-DD"T"HH24:MI') AS pa,
                to_char(b.h0 - INTERVAL '1 hour', 'HH24:MI') AS lbl
           FROM b
       )
       SELECT o.store,
              COUNT(*)      FILTER (WHERE o.created_at >= w.a  AND o.created_at < w.z) AS orders,
              COALESCE(SUM(o.total_price) FILTER (WHERE o.created_at >= w.a AND o.created_at < w.z), 0) AS sales,
              COUNT(*)      FILTER (WHERE o.created_at >= w.pa AND o.created_at < w.a) AS p_orders,
              COALESCE(SUM(o.total_price) FILTER (WHERE o.created_at >= w.pa AND o.created_at < w.a), 0) AS p_sales,
              (SELECT lbl FROM w) AS lbl
         FROM shopify_orders o, w
        WHERE o.store = ANY($1)
          AND COALESCE(o.cancelled_at, '') = ''
          AND o.created_at >= w.pa
        GROUP BY o.store`,
      [codes],
    ),

    // products carrying spend today, per portal
    q(
      `SELECT d.portal, COUNT(DISTINCT COALESCE(NULLIF(pr.product, ''), 'unmapped')) AS products
         FROM meta_analysis_campaign_daily d
         LEFT JOIN camp_product_resolved pr ON pr.campaign_id = d.campaign_id
        WHERE d.date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          AND d.portal = ANY($1) AND d.spend > 0
        GROUP BY d.portal`,
      [codes],
    ),
  ]);

  const byKey = <T extends Record<string, unknown>>(rows: T[], k: string) =>
    new Map(rows.map((r) => [String(r[k]), r]));
  const S = byKey(snap, 'portal');
  const O = byKey(sales, 'store');
  const H = byKey(hourly, 'store');
  const P = byKey(finals, 'portal');

  const cutIST = String(snap[0]?.cut ?? '—');
  const lbl = String(hourly[0]?.lbl ?? '');
  const hourLabel = lbl ? `${lbl}–${lbl.slice(0, 2)}:59` : 'last complete hour';

  const sites: SiteNow[] = codes.map((p) => {
    const s = S.get(p) ?? {};
    const o = O.get(p) ?? {};
    const spend = n(s.spend);
    const ySpend = n(s.y_spend);
    const sale = n(o.sales);
    const ySale = n(o.y_sales);
    const budgetLive = n(s.budget_live);
    return {
      portal: p,
      name: nameOf(p),
      sales: sale,
      orders: n(o.orders),
      spend,
      roas: spend > 0 ? sale / spend : 0,
      ySales: ySale,
      yOrders: n(o.y_orders),
      ySpend,
      yRoas: ySpend > 0 ? ySale / ySpend : 0,
      ydayFinal: ySpend > 0 ? n(o.y_full) / Math.max(ySpend, 1) : 0,
      budgetLive,
      budgetLeft: Math.max(0, budgetLive - n(s.spend_live)),
      camps: n(s.camps),
      activeCamps: n(s.active_camps),
      closedBudget: n(s.closed_budget),
      allocated: n(s.allocated),
      products: n(P.get(p)?.products),
    };
  }).filter((x) => x.camps > 0 || x.orders > 0);

  // Sales and orders only. Hourly SPEND would need two campaign snapshots
  // bracketing the hour, and they land 30-60 minutes apart — often not once
  // inside a given hour. An apportioned estimate would look measured and
  // would not be, so the column is left out rather than invented.
  const hours: HourRow[] = sites.map((site) => {
    const h = H.get(site.portal) ?? {};
    return {
      portal: site.portal,
      name: site.name,
      sales: n(h.sales),
      orders: n(h.orders),
      spend: 0,
      roas: 0,
      budgetLive: site.budgetLive,
      pSales: n(h.p_sales),
      pOrders: n(h.p_orders),
      pSpend: 0,
      pRoas: 0,
    };
  });

  return { cutIST, hourLabel, sites, hours };
}

export const delta = (now: number, was: number) => (was > 0 ? ((now - was) / was) * 100 : 0);
export const pctOf = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
