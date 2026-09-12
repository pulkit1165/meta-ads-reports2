import { q, n } from './db';
import { PORTALS, sentimentsOf, creativeTags } from './ads';

/**
 * What actually changed on the ads today.
 *
 * Every "new" here is defined by FIRST SPEND, not by creation time. A campaign
 * or creative built last week and switched on today is new today — that is when
 * it started costing money and when Meta's learning starts. Creation time would
 * count things that were only drafted, and miss things that were revived.
 */
export interface NewCampaign {
  campaignId: string;
  campaignName: string;
  portal: string;
  product: string;
  saleBlock: string;
  creativeType: string;
  budget: number;
  spend: number;
  revenue: number;
}

export interface NewCreative {
  adId: string;
  adName: string;
  campaignId: string;
  campaignName: string;
  portal: string;
  product: string;
  saleBlock: string;
  creativeType: string;
  spend: number;
  revenue: number;
  /** true when the campaign it landed in was already running before today */
  intoExisting: boolean;
}

export interface BudgetMove {
  campaignId: string;
  campaignName: string;
  portal: string;
  product: string;
  before: number;
  after: number;
  delta: number;
  spend: number;
  revenue: number;
}

export interface Reactivation {
  campaignId: string;
  campaignName: string;
  portal: string;
  product: string;
  budget: number;
  spend: number;
  revenue: number;
  /** days between the previous spending day and today */
  gapDays: number;
}

export interface NewProduct {
  product: string;
  portal: string;
  camps: number;
  spend: number;
  revenue: number;
}

export interface DayChanges {
  newCampaigns: NewCampaign[];
  newCreatives: NewCreative[];
  budgetMoves: BudgetMove[];
  reactivations: Reactivation[];
  newProducts: NewProduct[];
}

const P = (portals: readonly string[]) => portals as string[];

export async function changesOn(
  day: string,
  portals: readonly string[] = PORTALS,
): Promise<DayChanges> {
  /* ── campaigns and creatives that spent for the first time today ──────── */
  const firsts = await q(
    `WITH camp_first AS (
       SELECT campaign_id, MIN(date) AS fd
         FROM meta_analysis_campaign_daily WHERE spend > 0 GROUP BY 1
     ),
     ad_first AS (
       SELECT ad_id, MIN(date) AS fd
         FROM meta_analysis_ad_daily WHERE spend > 0 GROUP BY 1
     ),
     today AS (
       SELECT a.ad_id, a.campaign_id, a.campaign_name, a.portal, a.ad_name,
              COALESCE(NULLIF(a.product_name,''), 'Uncategorized') AS product,
              COALESCE(NULLIF(a.creative_type,''), 'unknown')      AS creative_type,
              COALESCE(NULLIF(a.sale_block,''), NULLIF(c.sale_block,''), 'Loose') AS sale_block,
              a.spend, a.revenue
         FROM meta_analysis_ad_daily a
         LEFT JOIN meta_analysis_campaign_daily c
                ON c.date = a.date AND c.campaign_id = a.campaign_id
        WHERE a.date = $1::date AND a.portal = ANY($2) AND a.spend > 0
     )
     SELECT t.*, (af.fd = $1::date) AS new_ad, (cf.fd = $1::date) AS new_camp,
            b.budget
       FROM today t
       JOIN ad_first   af ON af.ad_id       = t.ad_id
       JOIN camp_first cf ON cf.campaign_id = t.campaign_id
       LEFT JOIN camp_day_state b ON b.d = $1::date AND b.campaign_id = t.campaign_id
      WHERE af.fd = $1::date OR cf.fd = $1::date`,
    [day, P(portals)],
  );

  const campSeen = new Map<string, NewCampaign>();
  const newCreatives: NewCreative[] = [];
  for (const r of firsts) {
    if (r.new_ad) {
      newCreatives.push({
        adId: String(r.ad_id), adName: String(r.ad_name ?? ''),
        campaignId: String(r.campaign_id), campaignName: String(r.campaign_name ?? ''),
        portal: String(r.portal), product: String(r.product),
        saleBlock: String(r.sale_block), creativeType: String(r.creative_type),
        spend: n(r.spend), revenue: n(r.revenue),
        intoExisting: !r.new_camp,
      });
    }
    if (r.new_camp) {
      const id = String(r.campaign_id);
      const c = campSeen.get(id) ?? {
        campaignId: id, campaignName: String(r.campaign_name ?? ''),
        portal: String(r.portal), product: String(r.product),
        saleBlock: String(r.sale_block), creativeType: String(r.creative_type),
        budget: n(r.budget), spend: 0, revenue: 0,
      };
      c.spend += n(r.spend);
      c.revenue += n(r.revenue);
      campSeen.set(id, c);
    }
  }

  /* ── budget raised or cut on campaigns that already existed ───────────── */
  const moves = await q(
    `WITH t AS (SELECT campaign_id, budget FROM camp_day_state WHERE d = $1::date),
          y AS (SELECT campaign_id, budget FROM camp_day_state WHERE d = $1::date - 1),
          meta AS (
            SELECT campaign_id,
                   (ARRAY_AGG(campaign_name ORDER BY date DESC))[1] AS campaign_name,
                   (ARRAY_AGG(portal        ORDER BY date DESC))[1] AS portal,
                   SUM(spend) FILTER (WHERE date = $1::date)   AS spend,
                   SUM(revenue) FILTER (WHERE date = $1::date) AS revenue
              FROM meta_analysis_campaign_daily
             WHERE date BETWEEN $1::date - 1 AND $1::date AND portal = ANY($2)
             GROUP BY 1
          ),
          prod AS (
            SELECT campaign_id,
                   (ARRAY_AGG(COALESCE(NULLIF(product_name,''),'Uncategorized')
                              ORDER BY date DESC))[1] AS product
              FROM meta_analysis_ad_daily
             WHERE date = $1::date GROUP BY 1
          )
     SELECT m.campaign_id, m.campaign_name, m.portal,
            COALESCE(p.product,'Uncategorized') AS product,
            y.budget AS before, t.budget AS after,
            COALESCE(m.spend,0) AS spend, COALESCE(m.revenue,0) AS revenue
       FROM meta m
       JOIN t ON t.campaign_id = m.campaign_id
       JOIN y ON y.campaign_id = m.campaign_id
       LEFT JOIN prod p ON p.campaign_id = m.campaign_id
      WHERE t.budget IS DISTINCT FROM y.budget
        AND ABS(COALESCE(t.budget,0) - COALESCE(y.budget,0)) >= 100
      ORDER BY ABS(COALESCE(t.budget,0) - COALESCE(y.budget,0)) DESC`,
    [day, P(portals)],
  );
  const budgetMoves: BudgetMove[] = moves.map((r) => ({
    campaignId: String(r.campaign_id),
    campaignName: String(r.campaign_name ?? ''),
    portal: String(r.portal),
    product: String(r.product),
    before: n(r.before), after: n(r.after),
    delta: n(r.after) - n(r.before),
    spend: n(r.spend), revenue: n(r.revenue),
  }));

  /* ── campaigns that came back after a gap ─────────────────────────────── */
  const react = await q(
    `WITH days AS (
       SELECT campaign_id, date,
              LAG(date) OVER (PARTITION BY campaign_id ORDER BY date) AS prev
         FROM (SELECT DISTINCT campaign_id, date
                 FROM meta_analysis_campaign_daily
                WHERE spend > 0 AND portal = ANY($2)
                  AND date > $1::date - 120 AND date <= $1::date) x
     ),
     meta AS (
       SELECT campaign_id,
              (ARRAY_AGG(campaign_name ORDER BY date DESC))[1] AS campaign_name,
              (ARRAY_AGG(portal        ORDER BY date DESC))[1] AS portal,
              SUM(spend)   FILTER (WHERE date = $1::date) AS spend,
              SUM(revenue) FILTER (WHERE date = $1::date) AS revenue
         FROM meta_analysis_campaign_daily
        WHERE date = $1::date AND portal = ANY($2)
        GROUP BY 1
     ),
     prod AS (
       SELECT campaign_id,
              (ARRAY_AGG(COALESCE(NULLIF(product_name,''),'Uncategorized')
                         ORDER BY date DESC))[1] AS product
         FROM meta_analysis_ad_daily WHERE date = $1::date GROUP BY 1
     )
     SELECT d.campaign_id, m.campaign_name, m.portal,
            COALESCE(p.product,'Uncategorized') AS product,
            COALESCE(b.budget,0) AS budget,
            COALESCE(m.spend,0) AS spend, COALESCE(m.revenue,0) AS revenue,
            (d.date - d.prev) AS gap_days
       FROM days d
       JOIN meta m ON m.campaign_id = d.campaign_id
       LEFT JOIN prod p ON p.campaign_id = d.campaign_id
       LEFT JOIN camp_day_state b ON b.d = $1::date AND b.campaign_id = d.campaign_id
      WHERE d.date = $1::date AND d.prev IS NOT NULL AND (d.date - d.prev) > 1
      ORDER BY COALESCE(b.budget,0) DESC`,
    [day, P(portals)],
  );
  const reactivations: Reactivation[] = react.map((r) => ({
    campaignId: String(r.campaign_id),
    campaignName: String(r.campaign_name ?? ''),
    portal: String(r.portal),
    product: String(r.product),
    budget: n(r.budget), spend: n(r.spend), revenue: n(r.revenue),
    gapDays: n(r.gap_days),
  }));

  /* ── products spending for the very first time ────────────────────────── */
  const prods = await q(
    `WITH pf AS (
       SELECT COALESCE(NULLIF(product_name,''),'Uncategorized') AS product,
              MIN(date) AS fd
         FROM meta_analysis_ad_daily WHERE spend > 0 GROUP BY 1
     )
     SELECT COALESCE(NULLIF(a.product_name,''),'Uncategorized') AS product,
            (ARRAY_AGG(a.portal ORDER BY a.spend DESC))[1]      AS portal,
            COUNT(DISTINCT a.campaign_id)                       AS camps,
            SUM(a.spend) AS spend, SUM(a.revenue) AS revenue
       FROM meta_analysis_ad_daily a
       JOIN pf ON pf.product = COALESCE(NULLIF(a.product_name,''),'Uncategorized')
      WHERE a.date = $1::date AND a.portal = ANY($2) AND a.spend > 0
        AND pf.fd = $1::date
      GROUP BY 1 ORDER BY SUM(a.spend) DESC`,
    [day, P(portals)],
  );
  const newProducts: NewProduct[] = prods.map((r) => ({
    product: String(r.product), portal: String(r.portal),
    camps: n(r.camps), spend: n(r.spend), revenue: n(r.revenue),
  }));

  return {
    newCampaigns: [...campSeen.values()].sort((a, b) => b.spend - a.spend),
    newCreatives: newCreatives.sort((a, b) => b.spend - a.spend),
    budgetMoves,
    reactivations,
    newProducts,
  };
}

/** Count rows by a key that may yield several values per row. */
export function tally<T>(rows: T[], keyOf: (r: T) => string[]) {
  const m = new Map<string, number>();
  for (const r of rows) for (const k of keyOf(r)) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

export const sentimentsFor = (c: { adName: string }) => sentimentsOf(c.adName);
export const typesFor = (c: { creativeType: string }) => creativeTags(c.creativeType);
