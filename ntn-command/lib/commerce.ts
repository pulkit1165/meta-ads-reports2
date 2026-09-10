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

export interface PayRow {
  date: string; store: string; mode: string; gateway: string;
  orders: number; revenue: number;
}

/**
 * Prepaid/COD from payment_mode, processor from tags.
 *
 * The dedicated payment_gateway column is empty on every row, but the processor
 * is written into `tags` alongside everything else — Billdesk, Cashfree, PayU,
 * Razorpay and Credit/Debit Card all appear there. An earlier version of this
 * module reported that per-processor detail was unavailable; it was looking at
 * the wrong column.
 */
export async function paymentsByDay(
  from: string, to: string, stores: readonly string[] = STORES,
): Promise<PayRow[]> {
  const rows = await q(
    `SELECT o.created_date AS date, o.store,
            COALESCE(NULLIF(TRIM(o.payment_mode), ''), 'unrecorded') AS mode,
            CASE
              WHEN o.tags ILIKE '%Billdesk%'          THEN 'Billdesk'
              WHEN o.tags ILIKE '%Cashfree%'          THEN 'Cashfree'
              WHEN o.tags ILIKE '%PayU%'              THEN 'PayU'
              WHEN o.tags ILIKE '%Razorpay%'          THEN 'Razorpay'
              WHEN o.tags ILIKE '%Credit/Debit Card%' THEN 'Card'
              ELSE 'unrecorded'
            END AS gateway,
            COUNT(*)                       AS orders,
            COALESCE(SUM(o.total_price),0) AS revenue
       FROM shopify_orders o
      WHERE o.created_date BETWEEN $1 AND $2 AND o.store = ANY($3)
        AND COALESCE(o.cancelled_at, '') = ''
        AND COALESCE(o.source_name, '') <> 'Matrixify App'
      GROUP BY 1,2,3,4
      ORDER BY 1`,
    [from, to, stores as string[]],
  );
  return rows.map((r) => ({
    date: String(r.date),
    store: String(r.store),
    mode: String(r.mode),
    gateway: String(r.gateway),
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
 * App versus website, from the order's tags.
 *
 * Corrects an earlier reading of this table. The app marker is not in
 * note_attributes as the checkout permalink suggested — Shopify writes it into
 * `tags` as `appmaker` and `App_android_device`, which are present on roughly
 * 2,000 orders a month. source_name only ever holds the sales-channel id, which
 * is identical for app and web, so it can never answer this question.
 */
/** Tag fragments that identify an order placed through the mobile app. */
export const APP_TAG_SQL = `(o.tags ILIKE '%appmaker%' OR o.tags ILIKE '%App\\_android\\_device%' ESCAPE '\\' OR o.tags ILIKE '%App\\_ios\\_device%' ESCAPE '\\')`;

export async function channelsByDay(
  from: string, to: string, stores: readonly string[] = STORES,
): Promise<ChannelRow[]> {
  const rows = await q(
    `SELECT o.created_date AS date, o.store,
            CASE WHEN ${APP_TAG_SQL} THEN 'app' ELSE 'web' END AS channel,
            COUNT(*)                       AS orders,
            COALESCE(SUM(o.total_price),0) AS revenue
       FROM shopify_orders o
      WHERE o.created_date BETWEEN $1 AND $2 AND o.store = ANY($3)
        AND COALESCE(o.cancelled_at, '') = ''
        AND COALESCE(o.source_name, '') <> 'Matrixify App'
      GROUP BY 1,2,3
      ORDER BY 1`,
    [from, to, stores as string[]],
  );
  return rows.map((r) => ({
    date: String(r.date),
    store: String(r.store),
    channel: String(r.channel) === 'app' ? 'Mobile app' : 'Website',
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
