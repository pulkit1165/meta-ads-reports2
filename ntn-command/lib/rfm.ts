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
  const rows = await q(
    `WITH o AS (
       SELECT NULLIF(regexp_replace(COALESCE(customer_phone,''), '\\D', '', 'g'), '') AS phone,
              created_date::date AS d
         FROM shopify_orders
        WHERE COALESCE(cancelled_at,'') = ''
          AND COALESCE(source_name,'') <> 'Matrixify App'
          AND created_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
          AND ($2::text[] IS NULL OR store = ANY($2))
          AND created_date::date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date - ($1::int + 400)
     ),
     seq AS (
       SELECT phone, d,
              LAG(d) OVER (PARTITION BY phone ORDER BY d) AS prev_d
         FROM (SELECT DISTINCT phone, d FROM o WHERE phone IS NOT NULL) x
     )
     SELECT d::text AS date,
            COUNT(*)                                                    AS entered,
            COUNT(*) FILTER (WHERE prev_d IS NOT NULL AND d - prev_d > 45) AS reactivated
       FROM seq
      WHERE d > (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int
      GROUP BY 1 ORDER BY 1`,
    [days, stores.length ? (stores as string[]) : null],
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
