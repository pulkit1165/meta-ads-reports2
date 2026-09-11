import { q, n } from './db';
import { PORTALS, sentimentsOf, creativeTags } from './ads';

/**
 * One creative, with its performance over several windows at once.
 *
 * The thumbnail and live status come from `ad_creative`, refreshed from the
 * Graph API every six hours — neither exists in the warehouse tables.
 * Thumbnail URLs are signed and expire, which is why the refresh is a schedule
 * rather than a one-off backfill.
 */
export interface CreativeRow {
  adId: string;
  adName: string;
  status: string;
  thumbnail: string | null;
  videoId: string | null;
  storyId: string | null;
  objectType: string | null;
  createdTime: string | null;
  portal: string;
  product: string;
  creativeType: string;
  saleBlock: string;
  /** the selected day */
  d1: { spend: number; revenue: number };
  d3: { spend: number; revenue: number };
  d7: { spend: number; revenue: number };
  life: { spend: number; revenue: number; days: number };
}

export const roas = (rev: number, sp: number) => (sp > 0 ? rev / sp : 0);
export const isRunning = (status: string) => status === 'ACTIVE';

/**
 * Every creative that ran on `day`, plus its 3-day, 7-day and lifetime figures.
 *
 * The windows are computed in one pass with FILTER rather than four queries, so
 * the whole page is a single round trip to Mumbai.
 */
export async function creativesOn(
  day: string,
  portals: readonly string[] = PORTALS,
): Promise<CreativeRow[]> {
  const rows = await q(
    `WITH win AS (
       SELECT a.ad_id, a.portal,
              COALESCE(NULLIF(a.product_name,''), 'unmapped')  AS product,
              COALESCE(NULLIF(a.creative_type,''), 'unknown')  AS creative_type,
              COALESCE(NULLIF(a.sale_block,''), NULLIF(c.sale_block,''), 'Loose') AS sale_block,
              a.date, a.spend, a.revenue
         FROM meta_analysis_ad_daily a
         LEFT JOIN meta_analysis_campaign_daily c
                ON c.date = a.date AND c.campaign_id = a.campaign_id
        WHERE a.portal = ANY($2)
          AND a.date BETWEEN $1::date - 89 AND $1::date
     ),
     agg AS (
       SELECT ad_id,
              (array_agg(portal        ORDER BY date DESC))[1] AS portal,
              (array_agg(product       ORDER BY date DESC))[1] AS product,
              (array_agg(creative_type ORDER BY date DESC))[1] AS creative_type,
              (array_agg(sale_block    ORDER BY date DESC))[1] AS sale_block,
              SUM(spend)   FILTER (WHERE date = $1::date)          AS d1_spend,
              SUM(revenue) FILTER (WHERE date = $1::date)          AS d1_rev,
              SUM(spend)   FILTER (WHERE date > $1::date - 3)      AS d3_spend,
              SUM(revenue) FILTER (WHERE date > $1::date - 3)      AS d3_rev,
              SUM(spend)   FILTER (WHERE date > $1::date - 7)      AS d7_spend,
              SUM(revenue) FILTER (WHERE date > $1::date - 7)      AS d7_rev,
              SUM(spend)                                           AS life_spend,
              SUM(revenue)                                         AS life_rev,
              COUNT(DISTINCT date) FILTER (WHERE spend > 0)        AS life_days
         FROM win GROUP BY ad_id
     )
     SELECT g.*, c.ad_name, c.effective_status, c.thumbnail_url, c.video_id,
            c.story_id, c.object_type,
            (c.created_time AT TIME ZONE 'Asia/Kolkata')::date::text AS created_time
       FROM agg g
       LEFT JOIN ad_creative c ON c.ad_id = g.ad_id
      WHERE g.life_spend > 0
      ORDER BY g.d1_spend DESC NULLS LAST, g.life_spend DESC`,
    [day, portals as string[]],
  );
  return rows.map((r) => ({
    adId: String(r.ad_id),
    adName: String(r.ad_name ?? r.ad_id),
    status: String(r.effective_status ?? 'unknown'),
    thumbnail: r.thumbnail_url ? String(r.thumbnail_url) : null,
    videoId: r.video_id ? String(r.video_id) : null,
    storyId: r.story_id ? String(r.story_id) : null,
    objectType: r.object_type ? String(r.object_type) : null,
    createdTime: r.created_time ? String(r.created_time) : null,
    portal: String(r.portal ?? ''),
    product: String(r.product ?? 'unmapped'),
    creativeType: String(r.creative_type ?? 'unknown'),
    saleBlock: String(r.sale_block ?? 'Loose'),
    d1: { spend: n(r.d1_spend), revenue: n(r.d1_rev) },
    d3: { spend: n(r.d3_spend), revenue: n(r.d3_rev) },
    d7: { spend: n(r.d7_spend), revenue: n(r.d7_rev) },
    life: { spend: n(r.life_spend), revenue: n(r.life_rev), days: n(r.life_days) },
  }));
}

/**
 * Where to send someone who wants to watch the creative.
 *
 * The Graph API will not hand out a playable video URL for these ads without
 * extra permissions, so the link goes to the place the team can already watch
 * it: the post itself where there is one, otherwise Ads Manager filtered to
 * that ad.
 */
export function watchUrl(c: CreativeRow): string | null {
  if (c.storyId) return `https://www.facebook.com/${c.storyId}`;
  if (c.videoId) return `https://www.facebook.com/video.php?v=${c.videoId}`;
  return null;
}

/**
 * Ads created on `day` — the day's new pushes.
 *
 * created_time is stored in UTC and is converted to IST in the query, because
 * an ad created at 2am IST is the previous day in UTC and would be counted
 * against the wrong day.
 */
export function pushedOn(rows: CreativeRow[], day: string): CreativeRow[] {
  return rows.filter((c) => c.createdTime === day);
}

/** An ad we have never fetched from the Graph API: status genuinely unknown. */
export const isUnknown = (c: CreativeRow) => c.status === 'unknown';

/** Count rows by a key that may produce several values per row. */
export function countBy(rows: CreativeRow[], keyOf: (c: CreativeRow) => string[]) {
  const m = new Map<string, number>();
  for (const r of rows) for (const k of keyOf(r)) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

export const sentimentKeys = (c: CreativeRow) => sentimentsOf(c.adName);
export const typeKeys = (c: CreativeRow) => creativeTags(c.creativeType);
