import { q, n } from './db';
import { PORTALS } from './ads';

/**
 * The daily brief, built to the ADS PLANNER team-report structure.
 *
 * Everything here is ad-level, because the template asks about creatives and
 * only meta_analysis_ad_daily carries ad_id / ad_name alongside creative_type
 * and product_name. sale_block is the exception: it is empty on every ad row
 * and has to be joined from the campaign daily.
 *
 * One column in the template cannot be filled: cost per order. No Meta table in
 * this warehouse ingests a purchase count — campaign and ad dailies both carry
 * spend, revenue, impressions and clicks and nothing else — so orders and
 * cost-per-order would have to be invented. They are shown as unavailable with
 * the reason rather than estimated from revenue ÷ AOV, which would look precise
 * and be a guess.
 */
export interface AdRow {
  date: string;
  portal: string;
  campaignId: string;
  campaignName: string;
  adId: string;
  adName: string;
  saleBlock: string;
  creativeType: string;
  product: string;
  sku: string;
  offer: string;
  spend: number;
  revenue: number;
  clicks: number;
  impressions: number;
}

export async function adDays(
  from: string,
  to: string,
  portals: readonly string[] = PORTALS,
): Promise<AdRow[]> {
  const rows = await q(
    // sale_block is empty on every row of meta_analysis_ad_daily — it is a
    // campaign-level attribute and only the campaign daily carries it — so it
    // is joined in rather than read from the ad row, which would collapse
    // every block into 'Loose'.
    `SELECT a.date::text AS date, a.portal, a.campaign_id, a.campaign_name,
            a.ad_id, a.ad_name,
            COALESCE(NULLIF(a.sale_block, ''), NULLIF(c.sale_block, ''), 'Loose') AS sale_block,
            COALESCE(NULLIF(a.creative_type, ''), 'unknown')  AS creative_type,
            COALESCE(NULLIF(a.product_name, ''), 'unmapped')  AS product_name,
            COALESCE(a.sku, '')    AS sku,
            COALESCE(a.offer, '')  AS offer,
            a.spend, a.revenue, a.clicks, a.impressions
       FROM meta_analysis_ad_daily a
       LEFT JOIN meta_analysis_campaign_daily c
              ON c.date = a.date AND c.campaign_id = a.campaign_id
      WHERE a.date BETWEEN $1::date AND $2::date
        AND a.portal = ANY($3)
      ORDER BY a.date`,
    [from, to, portals as string[]],
  );
  return rows.map((r) => ({
    date: String(r.date),
    portal: String(r.portal),
    campaignId: String(r.campaign_id),
    campaignName: String(r.campaign_name ?? ''),
    adId: String(r.ad_id),
    adName: String(r.ad_name ?? ''),
    saleBlock: String(r.sale_block),
    creativeType: String(r.creative_type),
    product: String(r.product_name),
    sku: String(r.sku),
    offer: String(r.offer),
    spend: n(r.spend),
    revenue: n(r.revenue),
    clicks: n(r.clicks),
    impressions: n(r.impressions),
  }));
}

/** Which dates the ad-level table actually holds, newest first. */
export async function adDatesAvailable(limit = 90): Promise<string[]> {
  const rows = await q(
    `SELECT DISTINCT date::text AS d FROM meta_analysis_ad_daily
      ORDER BY d DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => String(r.d));
}

/* ── aggregation shared by the brief's sections ─────────────────────────── */

export interface Perf {
  key: string;
  spend: number;
  revenue: number;
  ads: Set<string>;
  blocks: Set<string>;
  creatives: Set<string>;
  days: number;
}

export function emptyPerf(key: string): Perf {
  return {
    key, spend: 0, revenue: 0, days: 0,
    ads: new Set(), blocks: new Set(), creatives: new Set(),
  };
}

export function accumulate(map: Map<string, Perf>, key: string, r: AdRow) {
  const p = map.get(key) ?? emptyPerf(key);
  p.spend += r.spend;
  p.revenue += r.revenue;
  p.days += 1;
  p.ads.add(r.adId);
  p.blocks.add(r.saleBlock);
  for (const t of r.creativeType.split('|').map((x) => x.trim()).filter(Boolean)) {
    p.creatives.add(t);
  }
  map.set(key, p);
}

export const perfRoas = (p: Perf) => (p.spend > 0 ? p.revenue / p.spend : 0);

/**
 * A short, stable code for a sale block so the brief can print "X / Y / Z"
 * style labels instead of a 90-character audience string. The code is derived
 * from the block's rank by spend, so the same block keeps the same letter for
 * the whole report but is not promised to be stable across days — the chart in
 * section 1 always prints the full settings beside it.
 */
export function blockCodes(blocks: string[]): Map<string, string> {
  const letters = 'XYZABCDEFGHIJKLMNOPQRSTUVW';
  const out = new Map<string, string>();
  blocks.forEach((b, i) => {
    out.set(b, i < letters.length ? letters[i] : `B${i + 1}`);
  });
  return out;
}
