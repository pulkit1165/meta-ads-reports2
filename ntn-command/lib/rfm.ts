import { q, n } from './db';

/**
 * Recency cohorts, using the windows the WhatsApp cohort work already runs on:
 * c1 0-15d, c2 15-45, c3 45-90, c4 90-180, c5 180-365, c6 365+ since the
 * customer's last order. Keeping the same boundaries means a list pulled here
 * and a list pulled there describe the same people.
 */
export const BANDS = [
  { key: 'c1', label: 'C1 · 0–15d', color: '#1baf7a', blurb: 'peak repurchase window' },
  { key: 'c2', label: 'C2 · 15–45d', color: '#5aa9a3', blurb: 'still warm' },
  { key: 'c3', label: 'C3 · 45–90d', color: '#2a78d6', blurb: 'cooling' },
  { key: 'c4', label: 'C4 · 90–180d', color: '#eda100', blurb: 'lapsing' },
  { key: 'c5', label: 'C5 · 180–365d', color: '#eb6834', blurb: 'low-yield win-back' },
  { key: 'c6', label: 'C6 · 365d+', color: '#7c2b26', blurb: 'dormant' },
] as const;

export type BandKey = (typeof BANDS)[number]['key'];

export interface CohortPoint {
  asOf: string;
  band: string;
  customers: number;
  orders: number;
  revenue: number;
}

/**
 * Snapshot history for one store, or the group.
 *
 * Customers are attributed to the store of their most recent order — the same
 * order the recency band is measured from. 'ALL' is stored as its own row
 * rather than summed from the three stores, because a customer who buys across
 * brands would otherwise be counted more than once.
 */
export async function cohortHistory(store = 'ALL'): Promise<CohortPoint[]> {
  const rows = await q(
    `SELECT as_of::text AS as_of, band, customers, orders, revenue
       FROM cohort_daily WHERE store = $1 ORDER BY as_of, band`,
    [store],
  );
  return rows.map((r) => ({
    asOf: String(r.as_of),
    band: String(r.band),
    customers: n(r.customers),
    orders: n(r.orders),
    revenue: n(r.revenue),
  }));
}

export interface Inflow {
  date: string;
  entered: number;
  reactivated: number;
}

/**
 * C1 intake, day by day.
 *
 * Anyone who orders lands in C1 that day, so intake is simply "customers who
 * ordered". The useful cut is whether they were already warm or came back from
 * the cold: `reactivated` counts those whose previous order was more than 45
 * days earlier, which is a genuine win-back rather than a regular repeating.
 */
export async function c1Inflow(days: number, stores: readonly string[] = []): Promise<Inflow[]> {
  const store = stores.length === 1 ? stores[0] : 'ALL';
  const rows = await q(
    `SELECT date::text AS date, entered, reactivated
       FROM c1_inflow_mv
      WHERE store = $1
        AND date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $2::int
      ORDER BY date`,
    [store, days],
  );
  return rows.map((r) => ({
    date: String(r.date),
    entered: n(r.entered),
    reactivated: n(r.reactivated),
  }));
}

export interface LifetimeShape {
  orders: number;
  customers: number;
  revenue: number;
}

/** Frequency distribution — the F in RFM. Scoped by the customer's last store. */
export async function frequency(stores: readonly string[] = []): Promise<LifetimeShape[]> {
  const rows = await q(
    `SELECT LEAST(orders, 6) AS orders, COUNT(*) AS customers, SUM(revenue) AS revenue
       FROM customer_lifetime
      WHERE ($1::text[] IS NULL OR last_store = ANY($1))
      GROUP BY 1 ORDER BY 1`,
    [stores.length ? (stores as string[]) : null],
  );
  return rows.map((r) => ({
    orders: n(r.orders),
    customers: n(r.customers),
    revenue: n(r.revenue),
  }));
}

/* ── value segments ─────────────────────────────────────────────────────── */

/**
 * Segment order is deliberate: it is the order they appear in the UI and it
 * runs from most valuable to least, so a reader scans down into the problem.
 */
export const SEGMENTS = [
  { key: 'VIP',         color: '#1baf7a', blurb: '5+ orders, top-value, bought within 90 days' },
  { key: 'Loyal',       color: '#5aa9a3', blurb: '3+ orders, bought within 90 days' },
  { key: 'Big spender', color: '#2a78d6', blurb: 'top-value, bought within 180 days' },
  { key: 'Promising',   color: '#9b6ad4', blurb: 'second order placed, still warm' },
  { key: 'New',         color: '#6fb1e8', blurb: 'first order inside 45 days' },
  { key: 'Occasional',  color: '#b9b13c', blurb: 'bought within 180 days, no pattern yet' },
  { key: 'At risk',     color: '#eda100', blurb: '3+ orders but nothing for 90-365 days' },
  { key: 'Cannot lose', color: '#eb6834', blurb: 'top-value, silent over a year' },
  { key: 'Hibernating', color: '#b3402f', blurb: 'light buyer, silent 180-365 days' },
  { key: 'Lost',        color: '#7c2b26', blurb: 'nothing for over a year' },
] as const;

export interface SegmentRow {
  segment: string;
  customers: number;
  orders: number;
  revenue: number;
  avgOrders: number;
  avgValue: number;
  avgRecency: number;
}

export async function segments(stores: readonly string[] = []): Promise<SegmentRow[]> {
  const rows = await q(
    `SELECT segment, COUNT(*) AS customers, SUM(orders) AS orders, SUM(revenue) AS revenue,
            AVG(orders) AS avg_orders, AVG(revenue) AS avg_value, AVG(recency_days) AS avg_recency
       FROM customer_lifetime
      WHERE ($1::text[] IS NULL OR last_store = ANY($1))
      GROUP BY 1`,
    [stores.length ? (stores as string[]) : null],
  );
  return rows.map((r) => ({
    segment: String(r.segment),
    customers: n(r.customers),
    orders: n(r.orders),
    revenue: n(r.revenue),
    avgOrders: n(r.avg_orders),
    avgValue: n(r.avg_value),
    avgRecency: n(r.avg_recency),
  }));
}

/* ── returning-customer product patterns ────────────────────────────────── */

export interface ProductRepeat {
  sku: string;
  title: string;
  buyers: number;
  reorders: number;
  units: number;
  revenue: number;
  reorderRate: number;
}

/**
 * Which products get bought again.
 *
 * `buyers` counts distinct customers; `reorders` counts those who bought the
 * same sku on more than one separate order. Reorder rate is the second number
 * over the first, which is the only honest reading of "repeat product" — a high
 * unit count can just mean people buy three at a time.
 */
export async function productRepeat(
  stores: readonly string[] = [],
  limit = 40,
): Promise<ProductRepeat[]> {
  const store = stores.length === 1 ? stores[0] : 'ALL';
  const rows = await q(
    `SELECT sku, title, buyers, reorders, units, revenue
       FROM product_repeat_mv
      WHERE store = $1 AND buyers >= 200
      ORDER BY reorders::numeric / NULLIF(buyers,0) DESC
      LIMIT $2`,
    [store, limit],
  );
  return rows.map((r) => {
    const buyers = n(r.buyers), reorders = n(r.reorders);
    return {
      sku: String(r.sku),
      title: String(r.title ?? r.sku),
      buyers, reorders,
      units: n(r.units),
      revenue: n(r.revenue),
      reorderRate: buyers ? (reorders / buyers) * 100 : 0,
    };
  });
}

export interface GapBucket { bucket: string; orders: number }

/**
 * How long returning customers wait before ordering again — the C1-C6 windows
 * applied to the gap between consecutive orders rather than to recency.
 */
export async function repeatGaps(stores: readonly string[] = []): Promise<GapBucket[]> {
  const store = stores.length === 1 ? stores[0] : 'ALL';
  const rows = await q(
    `SELECT bucket, orders FROM repeat_gap_mv WHERE store = $1 ORDER BY bucket`,
    [store],
  );
  return rows.map((r) => ({ bucket: String(r.bucket), orders: n(r.orders) }));
}
