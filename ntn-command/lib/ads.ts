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
}

/**
 * `date` in meta_analysis_campaign_daily is already the ad account's own day,
 * so it is compared as a date and never against CURRENT_DATE — the session is
 * UTC and would silently shift the boundary by five and a half hours.
 */
export async function campDays(from: string, to: string): Promise<CampDay[]> {
  const rows = await q(
    `SELECT date::text AS date, portal, campaign_id, campaign_name,
            COALESCE(NULLIF(sale_block, ''), 'Loose')      AS sale_block,
            COALESCE(NULLIF(creative_type, ''), 'unknown') AS creative_type,
            COALESCE(NULLIF(camp_type, ''), 'unknown')     AS camp_type,
            budget_rs, spend, revenue
       FROM meta_analysis_campaign_daily
      WHERE date BETWEEN $1::date AND $2::date
        AND portal = ANY($3)
      ORDER BY date`,
    [from, to, PORTALS as unknown as string[]],
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
export async function closingOn(day: string): Promise<ClosingSnapshot> {
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
    [PORTALS as unknown as string[], day],
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
