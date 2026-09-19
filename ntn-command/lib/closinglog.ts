import { q, n } from './db';
import { PORTALS, sentimentsOf } from './ads';

/**
 * Every close, in the order it happened.
 *
 * Two sources, and they answer different halves of the question:
 *
 *  - meta_campaign_snapshot is read every ~10 minutes, so a campaign that was
 *    ACTIVE at one read and PAUSED at the next was closed in between. That is
 *    WHEN, to a ten-minute resolution, and it catches every close regardless of
 *    who made it.
 *  - bot_pause_event is the auto-pause bot's own record of what it switched
 *    off, synced from the box every ten minutes. That is WHO.
 *
 * A flip whose interval contains a bot claim is the bot's. A flip with no claim
 * in that interval was made by a person in Ads Manager. Matching on the
 * interval rather than merely on the day matters: a campaign the bot cut at
 * 02:30, someone reopened at 10:00 and cut again at 15:00 would otherwise read
 * as two bot closes when the second was a human.
 */
export interface CloseEvent {
  date: string;
  /** IST clock time of the snapshot that first showed it off */
  at: string;
  /** minutes past IST midnight, for bucketing */
  minute: number;
  campaignId: string;
  campaignName: string;
  portal: string;
  saleBlock: string;
  creativeType: string;
  product: string;
  sentiments: string[];
  budget: number;
  spend: number;
  revenue: number;
  /** spend as a percentage of that day's budget at the moment it was cut */
  pct: number;
  roas: number;
  /** campaign age in days, counting the first day it spent as 1 */
  dayNo: number;
  actor: 'bot' | 'manual';
  /** the ladder rule that fired, for bot closes */
  rule: string | null;
  /** rupee gate the rule applied, for bot closes */
  gate: number | null;
  /** it went back ACTIVE later the same day */
  reopened: boolean;
}

export interface CloseLog {
  events: CloseEvent[];
  /** bot pauses with no matching status flip in the snapshots */
  unmatchedBotPauses: number;
  /** the day the bot's own record starts — before this, everything reads manual */
  botRecordFrom: string | null;
}

export async function closeLog(
  from: string,
  to: string,
  portals: readonly string[] = PORTALS,
): Promise<CloseLog> {
  const [rows, ads, meta] = await Promise.all([
    q(
      `WITH snaps AS (
         SELECT campaign_id, campaign_name, snapshot_at,
                (snapshot_at AT TIME ZONE 'Asia/Kolkata')::date AS d,
                (effective_status = 'ACTIVE') AS active,
                daily_budget, spend_today, revenue_today,
                LAG(effective_status = 'ACTIVE') OVER w AS prev_active,
                LAG(snapshot_at)                 OVER w AS prev_at,
                -- did it come back on later the same day?
                BOOL_OR(effective_status = 'ACTIVE') OVER (
                  PARTITION BY campaign_id, (snapshot_at AT TIME ZONE 'Asia/Kolkata')::date
                  ORDER BY snapshot_at
                  ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
                ) AS back_on
           FROM meta_campaign_snapshot
          WHERE snapshot_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
            AND snapshot_at <  ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
         WINDOW w AS (PARTITION BY campaign_id ORDER BY snapshot_at)
       ),
       ev AS (SELECT * FROM snaps WHERE prev_active AND NOT active),
       first_spend AS (
         SELECT campaign_id, MIN(date) AS fd
           FROM meta_analysis_campaign_daily WHERE spend > 0 GROUP BY 1
       ),
       -- The campaign table carries no product column; the classifier writes
       -- its verdict to camp_product_resolved instead.
       dims AS (
         SELECT DISTINCT ON (date, campaign_id)
                date AS d, campaign_id, portal,
                COALESCE(NULLIF(sale_block, ''), 'Loose')      AS sale_block,
                COALESCE(NULLIF(creative_type, ''), 'unknown') AS creative_type
           FROM meta_analysis_campaign_daily
          WHERE date BETWEEN $1::date AND $2::date AND portal = ANY($3)
       )
       SELECT ev.d::text AS d,
              to_char(ev.snapshot_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS at,
              EXTRACT(HOUR FROM ev.snapshot_at AT TIME ZONE 'Asia/Kolkata') * 60
              + EXTRACT(MINUTE FROM ev.snapshot_at AT TIME ZONE 'Asia/Kolkata') AS minute,
              ev.campaign_id, ev.campaign_name, x.portal, x.sale_block,
              x.creative_type,
              COALESCE(NULLIF(pr.product, ''), 'unmapped') AS product,
              ev.daily_budget, ev.spend_today, ev.revenue_today,
              COALESCE(ev.back_on, false) AS reopened,
              COALESCE((ev.d - f.fd) + 1, 1) AS day_no,
              b.rule, b.gate_rs,
              (b.campaign_id IS NOT NULL) AS by_bot
         FROM ev
         JOIN dims x ON x.d = ev.d AND x.campaign_id = ev.campaign_id
         LEFT JOIN first_spend f ON f.campaign_id = ev.campaign_id
         LEFT JOIN camp_product_resolved pr ON pr.campaign_id = ev.campaign_id
         LEFT JOIN bot_pause_event b
                ON b.campaign_id = ev.campaign_id
               AND b.paused_at >  ev.prev_at
               AND b.paused_at <= ev.snapshot_at + INTERVAL '2 minutes'
        ORDER BY ev.snapshot_at DESC`,
      [from, to, portals as string[]],
    ),
    // Sentiment lives only in the ad name, so it has to come from the ad table.
    q(
      `SELECT date::text AS d, campaign_id,
              ARRAY_AGG(DISTINCT ad_name) AS names
         FROM meta_analysis_ad_daily
        WHERE date BETWEEN $1::date AND $2::date AND portal = ANY($3)
          AND spend > 0
        GROUP BY 1, 2`,
      [from, to, portals as string[]],
    ),
    q(
      `SELECT MIN(d)::text AS first_day,
              COUNT(*) FILTER (WHERE d BETWEEN $1::date AND $2::date) AS in_window
         FROM bot_pause_event`,
      [from, to],
    ),
  ]);

  const nameMap = new Map<string, string[]>(
    ads.map((r) => [`${r.d}|${r.campaign_id}`, (r.names as string[]) ?? []]),
  );

  const events: CloseEvent[] = rows.map((r) => {
    const budget = n(r.daily_budget);
    const spend = n(r.spend_today);
    const names = nameMap.get(`${r.d}|${r.campaign_id}`) ?? [];
    const hits = new Set<string>();
    for (const nm of names) for (const s of sentimentsOf(nm)) hits.add(s);
    // "unmarked" alongside a real marker says nothing — drop it unless it is
    // the only thing present.
    if (hits.size > 1) hits.delete('unmarked');
    return {
      date: String(r.d),
      at: String(r.at),
      minute: n(r.minute),
      campaignId: String(r.campaign_id),
      campaignName: String(r.campaign_name ?? ''),
      portal: String(r.portal),
      saleBlock: String(r.sale_block),
      creativeType: String(r.creative_type),
      product: String(r.product),
      sentiments: hits.size ? [...hits] : ['unmarked'],
      budget,
      spend,
      revenue: n(r.revenue_today),
      pct: budget > 0 ? (spend / budget) * 100 : 0,
      roas: spend > 0 ? n(r.revenue_today) / spend : 0,
      dayNo: n(r.day_no),
      actor: r.by_bot ? 'bot' : 'manual',
      rule: r.rule ? String(r.rule) : null,
      gate: r.gate_rs != null ? n(r.gate_rs) : null,
      reopened: Boolean(r.reopened),
    };
  });

  const matched = events.filter((e) => e.actor === 'bot').length;
  return {
    events,
    unmatchedBotPauses: Math.max(0, n(meta[0]?.in_window) - matched),
    botRecordFrom: meta[0]?.first_day ? String(meta[0].first_day) : null,
  };
}

/* ── patterns ───────────────────────────────────────────────────────────── */

export interface Bucket {
  key: string;
  closes: number;
  bot: number;
  manual: number;
  budget: number;
  spend: number;
  revenue: number;
  /** median spend-as-%-of-budget at the moment of the cut */
  medPct: number;
  roas: number;
  reopened: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Group closes by any key, one row per key.
 *
 * The percentage of budget burnt before the cut is reported as a MEDIAN, not a
 * mean: a single campaign closed at 400% of a tiny budget drags an average
 * across a plausible-looking number and hides the typical case.
 */
export function bucket(events: CloseEvent[], keyOf: (e: CloseEvent) => string | string[]): Bucket[] {
  const m = new Map<string, { b: Bucket; pcts: number[] }>();
  for (const e of events) {
    const keys = keyOf(e);
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      const cur = m.get(k) ?? {
        b: { key: k, closes: 0, bot: 0, manual: 0, budget: 0, spend: 0, revenue: 0, medPct: 0, roas: 0, reopened: 0 },
        pcts: [] as number[],
      };
      cur.b.closes += 1;
      if (e.actor === 'bot') cur.b.bot += 1; else cur.b.manual += 1;
      cur.b.budget += e.budget;
      cur.b.spend += e.spend;
      cur.b.revenue += e.revenue;
      if (e.reopened) cur.b.reopened += 1;
      if (e.budget > 0) cur.pcts.push(e.pct);
      m.set(k, cur);
    }
  }
  return [...m.values()]
    .map(({ b, pcts }) => ({
      ...b,
      medPct: median(pcts),
      roas: b.spend > 0 ? b.revenue / b.spend : 0,
    }))
    .sort((a, b) => b.closes - a.closes);
}

/** Three-hour blocks, the coarsest cut that still separates night from day. */
export const HOUR_BLOCKS = ['00–03', '03–06', '06–09', '09–12', '12–15', '15–18', '18–21', '21–24'];
export const hourBlock = (minute: number) => HOUR_BLOCKS[Math.min(7, Math.floor(minute / 180))];
