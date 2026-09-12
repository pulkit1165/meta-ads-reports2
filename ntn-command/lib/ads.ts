import { q, n } from './db';

export const PORTALS = ['SM', 'NBP', 'SML'] as const;
export type Portal = (typeof PORTALS)[number];

export const PORTAL_NAME: Record<string, string> = {
  SM: 'Studd Muffyn',
  SML: 'SM Life',
  NBP: 'Nuskhe by Paras',
};

/* ── ROAS banding ───────────────────────────────────────────────────────── */

export const BAND_KEYS = ['zero', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'] as const;
export type BandKey = (typeof BAND_KEYS)[number];

export function bandOf(roas: number): BandKey {
  if (roas <= 0) return 'zero';
  if (roas < 0.25) return 'b1';
  if (roas < 0.5) return 'b2';
  if (roas < 0.75) return 'b3';
  if (roas < 1) return 'b4';
  if (roas < 1.5) return 'b5';
  if (roas < 2.5) return 'b6';
  return 'b7';
}

/** The five bands the closing protocol treats as failure. */
export const LOSING: BandKey[] = ['zero', 'b1', 'b2', 'b3', 'b4'];

/* ── daily campaign rows ────────────────────────────────────────────────── */

export interface CampDay {
  date: string;
  portal: string;
  campaignId: string;
  campaignName: string;
  saleBlock: string;
  creativeType: string;
  campType: string;
  budget: number;
  spend: number;
  revenue: number;
  roas: number;
  clicks: number;
  impressions: number;
}

/**
 * `date` in meta_analysis_campaign_daily is already the ad account's own day,
 * so it is compared as a date and never against CURRENT_DATE — the session is
 * UTC and would silently shift the boundary by five and a half hours.
 */
export async function campDays(from: string, to: string, portals: readonly string[] = PORTALS): Promise<CampDay[]> {
  const rows = await q(
    `SELECT date::text AS date, portal, campaign_id, campaign_name,
            COALESCE(NULLIF(sale_block, ''), 'Loose')      AS sale_block,
            COALESCE(NULLIF(creative_type, ''), 'unknown') AS creative_type,
            COALESCE(NULLIF(camp_type, ''), 'unknown')     AS camp_type,
            budget_rs, spend, revenue, clicks, impressions
       FROM meta_analysis_campaign_daily
      WHERE date BETWEEN $1::date AND $2::date
        AND portal = ANY($3)
      ORDER BY date`,
    [from, to, portals as string[]],
  );
  return rows.map((r) => {
    const spend = n(r.spend), revenue = n(r.revenue);
    return {
      date: String(r.date),
      portal: String(r.portal),
      campaignId: String(r.campaign_id),
      campaignName: String(r.campaign_name ?? ''),
      saleBlock: String(r.sale_block),
      creativeType: String(r.creative_type),
      campType: String(r.camp_type),
      budget: n(r.budget_rs),
      spend,
      revenue,
      roas: spend > 0 ? revenue / spend : 0,
      clicks: n(r.clicks),
      impressions: n(r.impressions),
    };
  });
}

/* ── live closing state ─────────────────────────────────────────────────── */

export interface CampState {
  portal: string;
  campaignId: string;
  campaignName: string;
  saleBlock: string;
  creativeType: string;
  budget: number;
  spend: number;
  revenue: number;
  closed: boolean;
}

export interface ClosingSnapshot {
  cutIST: string;
  rows: CampState[];
  /** Campaigns that never went active today: budget parked, not "closed". */
  dormantCount: number;
  dormantBudget: number;
}

/**
 * Today's closing state at the newest snapshot.
 *
 * "Allocated" counts only campaigns that were ACTIVE at some point today. A
 * campaign that was already off at midnight has budget on paper but was never
 * part of today's book, and folding it in understates closed% badly — on a
 * typical day it is ~8 lakh of parked budget against ~13 lakh genuinely live.
 */
export async function closingOn(day: string, portals: readonly string[] = PORTALS): Promise<ClosingSnapshot> {
  const rows = await q(
    `WITH today AS (
       SELECT * FROM meta_campaign_snapshot
        WHERE (snapshot_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
     ),
     latest AS (SELECT max(snapshot_at) AS ts FROM today),
     ever   AS (SELECT DISTINCT campaign_id FROM today WHERE effective_status = 'ACTIVE'),
     snap AS (
       SELECT t.campaign_id, t.campaign_name, t.effective_status,
              t.daily_budget, t.spend_today, t.revenue_today
         FROM today t, latest l WHERE t.snapshot_at = l.ts
     ),
     blk AS (
       SELECT DISTINCT campaign_id, portal,
              COALESCE(NULLIF(sale_block, ''), 'Loose')      AS sale_block,
              COALESCE(NULLIF(creative_type, ''), 'unknown') AS creative_type
         FROM meta_analysis_campaign_daily
        WHERE date = $2::date
          AND portal = ANY($1)
     )
     SELECT b.portal, s.campaign_id, s.campaign_name, b.sale_block, b.creative_type,
            s.daily_budget, s.spend_today, s.revenue_today,
            (s.effective_status <> 'ACTIVE') AS closed,
            (e.campaign_id IS NOT NULL)      AS ever_active,
            (SELECT to_char(ts AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') FROM latest) AS cut
       FROM snap s
       JOIN blk b ON b.campaign_id = s.campaign_id
       LEFT JOIN ever e ON e.campaign_id = s.campaign_id`,
    [portals as string[], day],
  );

  const live = rows.filter((r) => r.ever_active);
  const dormant = rows.filter((r) => !r.ever_active);

  return {
    cutIST: String(rows[0]?.cut ?? '—'),
    dormantCount: dormant.length,
    dormantBudget: dormant.reduce((s, r) => s + n(r.daily_budget), 0),
    rows: live.map((r) => ({
      portal: String(r.portal),
      campaignId: String(r.campaign_id),
      campaignName: String(r.campaign_name ?? ''),
      saleBlock: String(r.sale_block),
      creativeType: String(r.creative_type),
      budget: n(r.daily_budget),
      spend: n(r.spend_today),
      revenue: n(r.revenue_today),
      closed: Boolean(r.closed),
    })),
  };
}

/* ── grouping helper ────────────────────────────────────────────────────── */

export interface Agg {
  key: string;
  camps: number;
  budget: number;
  spend: number;
  revenue: number;
  closed: number;
  closedCamps: number;
  closedSpend: number;
  closedRevenue: number;
}

export function emptyAgg(key: string): Agg {
  return {
    key, camps: 0, budget: 0, spend: 0, revenue: 0,
    closed: 0, closedCamps: 0, closedSpend: 0, closedRevenue: 0,
  };
}

export function groupStates<T extends CampState>(rows: T[], keyOf: (r: T) => string): Agg[] {
  const m = new Map<string, Agg>();
  for (const r of rows) {
    const k = keyOf(r);
    const a = m.get(k) ?? emptyAgg(k);
    a.camps += 1;
    a.budget += r.budget;
    a.spend += r.spend;
    a.revenue += r.revenue;
    if (r.closed) {
      a.closed += r.budget;
      a.closedCamps += 1;
      a.closedSpend += r.spend;
      a.closedRevenue += r.revenue;
    }
    m.set(k, a);
  }
  return [...m.values()].sort((x, y) => y.budget - x.budget);
}

export const roasOf = (rev: number, sp: number) => (sp > 0 ? rev / sp : 0);
export const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

/**
 * Audience families. The raw sale_block strings are long and near-unique
 * ("Inclusion: 180 Day Purchase | 30 Day Visitors || Exclusion: …"), so the
 * useful cut is what kind of targeting it is, not the exact string.
 */
export function familyOf(saleBlock: string): string {
  const s = (saleBlock || '').toLowerCase();
  if (!s || s === 'loose' || s === '(unset)') return 'Loose / unset';
  const inc = s.includes('inclusion'), exc = s.includes('exclusion');
  if (inc && exc) return 'Inclusion + Exclusion';
  if (inc) return 'Inclusion only (retarget)';
  if (exc) return 'Exclusion only (prospecting)';
  return 'Other';
}

/* ── product mapping ────────────────────────────────────────────────────── */

/**
 * campaign_id -> product name. Maintained by the classifier pipeline; a
 * campaign with no row is genuinely unclassified rather than product-less, so
 * it is surfaced as "unmapped" instead of being dropped.
 */
export async function productMap(): Promise<Map<string, string>> {
  const rows = await q(
    `SELECT campaign_id, COALESCE(NULLIF(product_name, ''), 'unmapped') AS product
       FROM meta_camp_product_map`,
  );
  return new Map(rows.map((r) => [String(r.campaign_id), String(r.product)]));
}

/** Budget bands used when asking what launch size works. */
export function budgetBand(b: number): string {
  if (b <= 0) return 'unset';
  if (b < 2000) return 'under 2k';
  if (b < 5000) return '2k–5k';
  if (b < 7500) return '5k–7.5k';
  if (b < 10000) return '7.5k–10k';
  if (b < 15000) return '10k–15k';
  if (b < 20000) return '15k–20k';
  return '20k+';
}

export const BUDGET_BANDS = [
  'under 2k', '2k–5k', '5k–7.5k', '7.5k–10k', '10k–15k', '15k–20k', '20k+', 'unset',
];

/**
 * Creative types arrive as pipe-joined combinations ("Paras | Motion"), which
 * fragments the counts. Splitting into individual tags means a campaign using
 * two creative styles counts toward both, which is the honest reading: the
 * question is which styles appear in winners, not which exact combination.
 */
export function creativeTags(ct: string): string[] {
  const parts = (ct || '')
    .split('|')
    .map((p) => p.trim())
    .filter((p) => p && p.toLowerCase() !== 'unknown');
  return parts.length ? parts : ['unclassified'];
}

/* ── creative sentiment, read from the ad name ──────────────────────────── */

/**
 * Sentiment is encoded in the ad name at upload time — `_testimonial`,
 * `_achievement` and so on. There is no stored sentiment column in this
 * warehouse (the classify-sentiments workflow writes to a different store), so
 * the name is the only source.
 *
 * Tokens are matched on word boundaries after punctuation is normalised, which
 * stops "offer" matching inside a product name and keeps "sale" from colliding
 * with "sale_block". An ad carrying two markers counts toward both: the
 * question is which angles appear in winners, not which exact label was typed.
 */
export const SENTIMENTS: { key: string; tokens: string[] }[] = [
  { key: 'Testimonial',    tokens: ['testimonial', 'review', 'reviews'] },
  { key: 'Achievement',    tokens: ['achievement', 'achievements'] },
  { key: 'Transformation', tokens: ['transformation', 'beforeafter', 'result', 'results'] },
  { key: 'Desire',         tokens: ['desire', 'aspiration', 'aspirational'] },
  { key: 'Benefit',        tokens: ['benefit', 'benefits', 'usp'] },
  { key: 'Offer',          tokens: ['offer', 'offers', 'sale', 'loot', 'deal', 'discount'] },
  { key: 'UGC',            tokens: ['ugc', 'creator', 'influencer'] },
  { key: 'Unboxing',       tokens: ['unboxing', 'unbox'] },
  { key: 'Problem',        tokens: ['problem', 'concern', 'issue'] },
  { key: 'Demo',           tokens: ['demo', 'howto', 'tutorial'] },
  { key: 'Story',          tokens: ['story', 'journey'] },
];

const TOKEN_TO_SENTIMENT = new Map<string, string>(
  SENTIMENTS.flatMap((s) => s.tokens.map((t) => [t, s.key] as [string, string])),
);

/** Every sentiment marker in an ad name, or ['unmarked'] when there is none. */
export function sentimentsOf(adName: string): string[] {
  const tokens = (adName || '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  const hits = new Set<string>();
  for (const t of tokens) {
    const s = TOKEN_TO_SENTIMENT.get(t);
    if (s) hits.add(s);
  }
  return hits.size ? [...hits] : ['unmarked'];
}

/* ── closing history ────────────────────────────────────────────────────── */

export interface ClosingDay {
  date: string;
  allocated: number;
  closed: number;
  camps: number;
  closedCamps: number;
  spend: number;
  revenue: number;
  closedSpend: number;
  closedRevenue: number;
}

/**
 * Closed share per day, from the camp_day_state rollup.
 *
 * "Allocated" counts only campaigns that were ACTIVE at some point that day —
 * a campaign already off at midnight had budget on paper but was never part of
 * that day's book, and folding it in understates the closed share by roughly a
 * third. Today is recomputed live because the rollup refreshes daily.
 */
export async function closingHistory(
  from: string,
  to: string,
  portals: readonly string[] = PORTALS,
): Promise<ClosingDay[]> {
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
     state AS (
       SELECT d, campaign_id, budget, ever_active, closed_at_eod FROM camp_day_state
        WHERE d BETWEEN $1::date AND $2::date AND d < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
       UNION ALL
       SELECT d, campaign_id, budget, ever_active, closed_at_eod FROM today_state
        WHERE d BETWEEN $1::date AND $2::date
     ),
     perf AS (
       SELECT date, campaign_id, spend, revenue
         FROM meta_analysis_campaign_daily
        WHERE date BETWEEN $1::date AND $2::date AND portal = ANY($3)
     )
     SELECT p.date::text AS date,
            COUNT(*)                                            AS camps,
            SUM(s.budget) FILTER (WHERE s.ever_active)          AS allocated,
            SUM(s.budget) FILTER (WHERE s.ever_active AND s.closed_at_eod) AS closed,
            COUNT(*)      FILTER (WHERE s.ever_active AND s.closed_at_eod) AS closed_camps,
            SUM(p.spend)                                        AS spend,
            SUM(p.revenue)                                      AS revenue,
            SUM(p.spend)   FILTER (WHERE s.closed_at_eod)       AS closed_spend,
            SUM(p.revenue) FILTER (WHERE s.closed_at_eod)       AS closed_revenue
       FROM perf p
       JOIN state s ON s.d = p.date AND s.campaign_id = p.campaign_id
      GROUP BY 1 ORDER BY 1`,
    [from, to, portals as string[]],
  );
  return rows.map((r) => ({
    date: String(r.date),
    allocated: n(r.allocated),
    closed: n(r.closed),
    camps: n(r.camps),
    closedCamps: n(r.closed_camps),
    spend: n(r.spend),
    revenue: n(r.revenue),
    closedSpend: n(r.closed_spend),
    closedRevenue: n(r.closed_revenue),
  }));
}

/* ── yesterday, at the same hour ────────────────────────────────────────── */

export interface AgedState extends CampState {
  /** 1 on the first day the campaign ever spent. */
  dayNo: number;
}

export interface ClosingCompare {
  day: string;
  prev: string;
  /** IST clock time of the snapshot each side was read at. */
  cutIST: string;
  prevCutIST: string;
  now: AgedState[];
  was: AgedState[];
}

/**
 * The same closing state on two days, read at the same time of day.
 *
 * The hour is the whole point. Today is half-finished: by 14:00 the ladder has
 * made a fraction of the cuts it will make by midnight, so holding today's
 * closed share against yesterday's FINAL closed share always says "we are
 * closing less", whatever actually happened. Yesterday is therefore read at
 * whatever clock time today's newest snapshot sits at, and the two are then
 * directly comparable.
 *
 * When the chosen day is already settled, its newest snapshot is near midnight
 * and the same rule quietly becomes a full-day against full-day comparison —
 * no special case needed.
 */
export async function closingCompare(
  day: string,
  prev: string,
  portals: readonly string[] = PORTALS,
): Promise<ClosingCompare> {
  const rows = await q(
    `WITH day_cut AS (
       SELECT MAX(snapshot_at) AS ts FROM meta_campaign_snapshot
        WHERE (snapshot_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
     ),
     prev_cut AS (
       SELECT MAX(snapshot_at) AS ts FROM meta_campaign_snapshot
        WHERE (snapshot_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
          AND (snapshot_at AT TIME ZONE 'Asia/Kolkata')::time
              <= (SELECT (ts AT TIME ZONE 'Asia/Kolkata')::time FROM day_cut)
     ),
     bounds AS (
       SELECT $1::date AS d, ts FROM day_cut
       UNION ALL
       SELECT $2::date, ts FROM prev_cut
     ),
     snap AS (
       SELECT b.d, b.ts, s.campaign_id, s.campaign_name, s.daily_budget,
              s.spend_today, s.revenue_today,
              (s.effective_status <> 'ACTIVE') AS closed
         FROM bounds b JOIN meta_campaign_snapshot s ON s.snapshot_at = b.ts
     ),
     -- Active at any point that day UP TO the cut. A campaign switched on at
     -- 15:00 is not part of the 14:00 book and must not dilute either side.
     ever AS (
       SELECT b.d, s.campaign_id
         FROM bounds b
         JOIN meta_campaign_snapshot s
           ON (s.snapshot_at AT TIME ZONE 'Asia/Kolkata')::date = b.d
          AND s.snapshot_at <= b.ts
        WHERE s.effective_status = 'ACTIVE'
        GROUP BY 1, 2
     ),
     first_spend AS (
       SELECT campaign_id, MIN(date) AS fd
         FROM meta_analysis_campaign_daily WHERE spend > 0 GROUP BY 1
     ),
     dims AS (
       SELECT DISTINCT ON (date, campaign_id)
              date AS d, campaign_id, portal,
              COALESCE(NULLIF(sale_block, ''), 'Loose')      AS sale_block,
              COALESCE(NULLIF(creative_type, ''), 'unknown') AS creative_type
         FROM meta_analysis_campaign_daily
        WHERE date IN ($1::date, $2::date) AND portal = ANY($3)
     )
     SELECT s.d::text AS d, s.campaign_id, s.campaign_name, x.portal,
            x.sale_block, x.creative_type, s.daily_budget, s.spend_today,
            s.revenue_today, s.closed,
            COALESCE((s.d - f.fd) + 1, 1) AS day_no,
            to_char(s.ts AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS cut
       FROM snap s
       JOIN ever e ON e.d = s.d AND e.campaign_id = s.campaign_id
       JOIN dims x ON x.d = s.d AND x.campaign_id = s.campaign_id
       LEFT JOIN first_spend f ON f.campaign_id = s.campaign_id`,
    [day, prev, portals as string[]],
  );

  const map = (r: Record<string, unknown>): AgedState => ({
    portal: String(r.portal),
    campaignId: String(r.campaign_id),
    campaignName: String(r.campaign_name ?? ''),
    saleBlock: String(r.sale_block),
    creativeType: String(r.creative_type),
    budget: n(r.daily_budget),
    spend: n(r.spend_today),
    revenue: n(r.revenue_today),
    closed: Boolean(r.closed),
    dayNo: n(r.day_no),
  });

  const nowRows = rows.filter((r) => r.d === day);
  const wasRows = rows.filter((r) => r.d === prev);
  return {
    day, prev,
    cutIST: String(nowRows[0]?.cut ?? '—'),
    prevCutIST: String(wasRows[0]?.cut ?? '—'),
    now: nowRows.map(map),
    was: wasRows.map(map),
  };
}

/** Age bands, matching the portfolio module's vocabulary. */
export const AGE_BANDS = ['Day 1', 'Day 2-3', 'Day 4-7', 'Day 8+'] as const;

export function ageBand(dayNo: number): string {
  if (dayNo <= 1) return 'Day 1';
  if (dayNo <= 3) return 'Day 2-3';
  if (dayNo <= 7) return 'Day 4-7';
  return 'Day 8+';
}

export interface CmpAgg {
  key: string;
  now: Agg;
  was: Agg;
  /** now − was, in rupees of budget switched off */
  dClosed: number;
  /** now − was, in percentage POINTS of closed share */
  dPoints: number;
}

/**
 * One row per key with both days side by side.
 *
 * A key present on only one day still gets a row, against an empty aggregate —
 * a block that was not touched yesterday and is being cut hard today is exactly
 * the thing worth seeing, and an inner join would hide it.
 */
export function compareStates<T extends CampState>(
  now: T[], was: T[], keyOf: (r: T) => string,
): CmpAgg[] {
  const a = new Map(groupStates(now, keyOf).map((g) => [g.key, g]));
  const b = new Map(groupStates(was, keyOf).map((g) => [g.key, g]));
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys]
    .map((k) => {
      const nowAgg = a.get(k) ?? emptyAgg(k);
      const wasAgg = b.get(k) ?? emptyAgg(k);
      return {
        key: k, now: nowAgg, was: wasAgg,
        dClosed: nowAgg.closed - wasAgg.closed,
        dPoints: share(nowAgg.closed, nowAgg.budget) - share(wasAgg.closed, wasAgg.budget),
      };
    })
    .sort((x, y) => Math.abs(y.dClosed) - Math.abs(x.dClosed));
}
