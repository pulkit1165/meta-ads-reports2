import { q, n } from './db';

/**
 * The three storefront codes. shopify_orders.store uses the same values as
 * meta_analysis_campaign_daily.portal, so one scope parameter filters both the
 * ads modules and the commerce ones.
 */
export const STORES = ['SM', 'SML', 'NBP'] as const;

/**
 * Store codes as they appear in shopify_orders.store.
 * Resolved once at query time so a new store never silently vanishes from a
 * report — anything unmapped shows under its raw code rather than being dropped.
 */
export const STORE_NAME: Record<string, string> = {
  SM: 'Studd Muffyn',
  SML: 'SM Life',
  NBP: 'Nuskhe by Paras',
  studdmuffyn: 'Studd Muffyn',
  smlife: 'SM Life',
  nuskhebyparas: 'Nuskhe by Paras',
};

export const storeLabel = (s: string) => STORE_NAME[s] ?? s;

/**
 * Cancelled orders are stored as an empty string, not NULL — a plain
 * `cancelled_at IS NULL` filter drops almost the entire book (it once returned
 * Rs 1,521 against a real Rs 15L day). Matrixify rows are bulk re-imports of
 * historical orders, not sales, and inflate any day they land on.
 */
export const SALES_FILTER = `
  COALESCE(cancelled_at, '') = ''
  AND COALESCE(source_name, '') <> 'Matrixify App'
`;

export interface DayRange { from: string; to: string; label: string }

/** Yesterday in IST, as the shop counts it. */
export async function istDates(): Promise<{ today: string; yesterday: string }> {
  const r = await q<{ today: string; yesterday: string }>(
    `SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text            AS today,
            ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 1)::text      AS yesterday`,
  );
  return r[0];
}

/* ── payments ───────────────────────────────────────────────────────────── */

export interface PayRow { date: string; store: string; mode: string; orders: number; revenue: number }

/**
 * payment_gateway is empty on every row in this database — verified across a
 * quarter of orders — so the split is built on payment_mode, which is fully
 * populated with exactly Prepaid and COD. Per-processor detail would have to
 * come from the Shopify API; it is not captured here.
 */
export async function paymentsByDay(
  from: string, to: string, stores: readonly string[] = STORES,
): Promise<PayRow[]> {
  const rows = await q(
    `SELECT created_date AS date, store,
            COALESCE(NULLIF(TRIM(payment_mode), ''), 'unrecorded') AS mode,
            COUNT(*)                     AS orders,
            COALESCE(SUM(total_price),0) AS revenue
       FROM shopify_orders
      WHERE created_date BETWEEN $1 AND $2 AND store = ANY($3) AND ${SALES_FILTER}
      GROUP BY 1,2,3
      ORDER BY 1`,
    [from, to, stores as string[]],
  );
  return rows.map((r) => ({
    date: String(r.date),
    store: String(r.store),
    mode: String(r.mode),
    orders: n(r.orders),
    revenue: n(r.revenue),
  }));
}

export const isCOD = (mode: string) => mode.toLowerCase() === 'cod';

/* ── sales channel ──────────────────────────────────────────────────────── */

export interface ChannelRow {
  date: string;
  store: string;
  channel: string;
  orders: number;
  revenue: number;
}

/**
 * Sales channel, from source_name.
 *
 * This is NOT an app-versus-website split. The mobile app marks its carts with
 * utm_medium=mobile_app, but that marker lives in note_attributes and
 * landing_site, and the ingest stores neither — so the warehouse genuinely
 * cannot tell an app order from a web one. What source_name does hold is the
 * Shopify sales-channel id: one dominant numeric id per store (the headless
 * storefront), plus 'web', 'shopify_draft_order' and the Matrixify importer.
 * Reporting that faithfully is better than inventing a split, and the fix is a
 * one-line ingest change rather than anything on this page.
 */
export function channelLabel(store: string, src: string): string {
  if (!src) return 'unrecorded';
  if (src === 'web') return 'Online store (web)';
  if (src === 'shopify_draft_order') return 'Draft order (manual)';
  if (/^\d+$/.test(src)) return 'Headless storefront';
  return src;
}

export async function channelsByDay(
  from: string, to: string, stores: readonly string[] = STORES,
): Promise<ChannelRow[]> {
  const rows = await q(
    `SELECT created_date AS date, store,
            COALESCE(NULLIF(source_name, ''), 'unrecorded') AS src,
            COUNT(*)                     AS orders,
            COALESCE(SUM(total_price),0) AS revenue
       FROM shopify_orders
      WHERE created_date BETWEEN $1 AND $2 AND store = ANY($3) AND ${SALES_FILTER}
      GROUP BY 1,2,3
      ORDER BY 1`,
    [from, to, stores as string[]],
  );
  return rows.map((r) => ({
    date: String(r.date),
    store: String(r.store),
    channel: channelLabel(String(r.store), String(r.src)),
    orders: n(r.orders),
    revenue: n(r.revenue),
  }));
}

/* ── new vs returning ───────────────────────────────────────────────────── */

export interface RepeatRow {
  date: string;
  store: string;
  newOrders: number;
  repeatOrders: number;
  newRevenue: number;
  repeatRevenue: number;
}

/**
 * An order is "returning" when that phone number has an earlier order anywhere
 * in the history, so the comparison is against the full 3.4M-row book rather
 * than the window on screen. Orders with no phone cannot be attributed either
 * way and are excluded rather than defaulted to "new", which would inflate the
 * new rate every time checkout dropped a number.
 */
export async function repeatRate(
  from: string, to: string, stores: readonly string[] = STORES,
): Promise<RepeatRow[]> {
  const rows = await q(
    `WITH win AS (
       SELECT id, store, created_date, total_price,
              NULLIF(regexp_replace(COALESCE(customer_phone,''), '\\D', '', 'g'), '') AS phone
         FROM shopify_orders
        WHERE created_date BETWEEN $1 AND $2 AND store = ANY($3) AND ${SALES_FILTER}
     ),
     firsts AS (
       -- customer_lifetime is a materialised view over the same sales filter.
       -- Computing first_date live costs ~13s across 3.4M orders with no index
       -- on customer_phone; against the matview it is an indexed join.
       SELECT phone, first_date FROM customer_lifetime
     )
     SELECT w.created_date AS date, w.store,
            COUNT(*) FILTER (WHERE f.first_date = w.created_date)  AS new_orders,
            COUNT(*) FILTER (WHERE f.first_date < w.created_date)  AS repeat_orders,
            COALESCE(SUM(w.total_price) FILTER (WHERE f.first_date = w.created_date), 0) AS new_revenue,
            COALESCE(SUM(w.total_price) FILTER (WHERE f.first_date < w.created_date), 0) AS repeat_revenue
       FROM win w
       JOIN firsts f ON f.phone = w.phone
      WHERE w.phone IS NOT NULL
      GROUP BY 1,2
      ORDER BY 1`,
    [from, to, stores as string[]],
  );
  return rows.map((r) => ({
    date: String(r.date),
    store: String(r.store),
    newOrders: n(r.new_orders),
    repeatOrders: n(r.repeat_orders),
    newRevenue: n(r.new_revenue),
    repeatRevenue: n(r.repeat_revenue),
  }));
}
