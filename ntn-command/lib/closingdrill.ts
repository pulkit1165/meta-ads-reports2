import { q, n } from './db';
import { PORTALS, bandOf, roasOf, type BandKey } from './ads';
import { ROAS_BANDS } from '@/components/charts';

/**
 * Every close in the window, ready to be opened three levels deep: the day,
 * the ROAS band it died in, and the campaigns themselves.
 *
 * It reads camp_close_event for settled days — the nightly build already did
 * the expensive LAG over every snapshot — and recomputes today live, because
 * that table is only rebuilt each morning. One day of snapshots is cheap; a
 * week of them is not.
 *
 * Two filters make the totals here tie back to the day row above them:
 *
 *  - only the LAST close of a campaign-day counts. A campaign cut at 11:00,
 *    reopened at 14:00 and cut again at 18:00 was closed once, at 18:00.
 *  - the campaign must have been live at some point that day (ever_active) and
 *    still off at midnight (closed_at_eod). Budget parked on something that
 *    never went live was never part of that day's book, and an overnight flip
 *    whose ACTIVE reading belongs to yesterday is yesterday's close.
 */
export interface DrillCamp {
  id: string;
  name: string;
  portal: string;
  /** IST clock time of the snapshot that first showed it off */
  at: string;
  /** campaign age in days, counting the first day it spent as 1 */
  dayNo: number;
  budget: number;
  spend: number;
  revenue: number;
  /** spend as a share of that day's budget at the moment it was cut */
  pct: number;
  roas: number;
  actor: 'bot' | 'manual';
  /** the ladder rule that fired, for bot closes */
  rule: string | null;
  /** rupee gate that rule applied */
  gate: number | null;
}

export interface DrillBucket {
  key: BandKey;
  label: string;
  color: string;
  closes: number;
  bot: number;
  manual: number;
  budget: number;
  spend: number;
  revenue: number;
  roas: number;
  /** mean and median spend-against-budget at the cut */
  avgPct: number;
  medPct: number;
  camps: DrillCamp[];
}

export interface DrillDay {
  date: string;
  closes: number;
  bot: number;
  manual: number;
  budget: number;
  spend: number;
  revenue: number;
  avgPct: number;
  medPct: number;
  buckets: DrillBucket[];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function closingDrill(
  from: string,
  to: string,
  portals: readonly string[] = PORTALS,
): Promise<DrillDay[]> {
  const rows = await q(
    `WITH w AS (SELECT $1::date AS a, $2::date AS b,
                       (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS today),
     snaps AS (
       SELECT campaign_id, snapshot_at,
              (snapshot_at AT TIME ZONE 'Asia/Kolkata')::date AS d,
              (effective_status = 'ACTIVE') AS active,
              daily_budget, spend_today, revenue_today,
              LAG(effective_status = 'ACTIVE') OVER x AS prev_active,
              LAG(snapshot_at)                 OVER x AS prev_at
         FROM meta_campaign_snapshot, w
        WHERE snapshot_at >= (w.today - INTERVAL '5 hours 30 minutes')
       WINDOW x AS (PARTITION BY campaign_id ORDER BY snapshot_at)
     ),
     today_state AS (
       SELECT d, campaign_id,
              BOOL_OR(active) AS ever_active,
              (ARRAY_AGG(active ORDER BY snapshot_at DESC))[1] = false AS closed_at_eod
         FROM snaps GROUP BY 1, 2
     ),
     ev AS (
       SELECT e.d, e.campaign_id, e.closed_at, e.prev_at, e.budget, e.spend, e.revenue, e.by_bot
         FROM camp_close_event e, w
        WHERE e.d BETWEEN w.a AND w.b AND e.d < w.today
       UNION ALL
       -- today is not in camp_close_event yet; the bot's own log says who
       SELECT s.d, s.campaign_id, s.snapshot_at, s.prev_at,
              s.daily_budget, s.spend_today, s.revenue_today,
              EXISTS (SELECT 1 FROM bot_pause_event b
                       WHERE b.campaign_id = s.campaign_id
                         AND b.paused_at >  s.prev_at
                         AND b.paused_at <= s.snapshot_at + INTERVAL '2 minutes')
         FROM snaps s WHERE s.prev_active AND NOT s.active
     ),
     fin AS (
       SELECT DISTINCT ON (d, campaign_id) *
         FROM ev ORDER BY d, campaign_id, closed_at DESC
     ),
     state AS (
       SELECT c.d, c.campaign_id, c.ever_active, c.closed_at_eod
         FROM camp_day_state c, w
        WHERE c.d BETWEEN w.a AND w.b AND c.d < w.today
       UNION ALL
       SELECT d, campaign_id, ever_active, closed_at_eod FROM today_state
     ),
     first_spend AS (
       SELECT campaign_id, MIN(date) AS fd
         FROM meta_analysis_campaign_daily WHERE spend > 0 GROUP BY 1
     ),
     dims AS (
       SELECT DISTINCT ON (date, campaign_id)
              date AS d, campaign_id, portal, campaign_name
         FROM meta_analysis_campaign_daily, w
        WHERE date BETWEEN w.a AND w.b AND portal = ANY($3)
     )
     SELECT f.d::text AS date, f.campaign_id, x.portal, x.campaign_name,
            to_char(f.closed_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS at,
            f.budget, f.spend, f.revenue, f.by_bot,
            COALESCE((f.d - fs.fd) + 1, 1) AS day_no,
            b.rule, b.gate_rs
       FROM fin f
       JOIN dims  x ON x.d = f.d AND x.campaign_id = f.campaign_id
       JOIN state s ON s.d = f.d AND s.campaign_id = f.campaign_id
                   AND s.ever_active AND s.closed_at_eod
       LEFT JOIN first_spend fs ON fs.campaign_id = f.campaign_id
       LEFT JOIN bot_pause_event b
              ON b.campaign_id = f.campaign_id
             AND b.paused_at >  f.prev_at
             AND b.paused_at <= f.closed_at + INTERVAL '2 minutes'
      ORDER BY f.d DESC, f.closed_at DESC`,
    [from, to, portals as string[]],
  );

  const days = new Map<string, DrillDay>();
  const bucketsOf = new Map<string, Map<BandKey, DrillBucket>>();

  for (const r of rows) {
    const date = String(r.date);
    const budget = n(r.budget);
    const spend = n(r.spend);
    const revenue = n(r.revenue);
    const camp: DrillCamp = {
      id: String(r.campaign_id),
      name: String(r.campaign_name ?? ''),
      portal: String(r.portal),
      at: String(r.at),
      dayNo: n(r.day_no),
      budget,
      spend,
      revenue,
      pct: budget > 0 ? (spend / budget) * 100 : 0,
      roas: roasOf(revenue, spend),
      actor: r.by_bot ? 'bot' : 'manual',
      rule: r.rule ? String(r.rule) : null,
      gate: r.gate_rs != null ? n(r.gate_rs) : null,
    };

    const day = days.get(date) ?? {
      date, closes: 0, bot: 0, manual: 0, budget: 0, spend: 0, revenue: 0,
      avgPct: 0, medPct: 0, buckets: [],
    };
    day.closes += 1;
    day[camp.actor === 'bot' ? 'bot' : 'manual'] += 1;
    day.budget += budget; day.spend += spend; day.revenue += revenue;
    days.set(date, day);

    const band = bandOf(camp.roas);
    const bm = bucketsOf.get(date) ?? new Map<BandKey, DrillBucket>();
    const meta = ROAS_BANDS.find((b) => b.key === band)!;
    const bkt = bm.get(band) ?? {
      key: band, label: meta.label, color: meta.color,
      closes: 0, bot: 0, manual: 0, budget: 0, spend: 0, revenue: 0,
      roas: 0, avgPct: 0, medPct: 0, camps: [],
    };
    bkt.closes += 1;
    bkt[camp.actor === 'bot' ? 'bot' : 'manual'] += 1;
    bkt.budget += budget; bkt.spend += spend; bkt.revenue += revenue;
    bkt.camps.push(camp);
    bm.set(band, bkt);
    bucketsOf.set(date, bm);
  }

  const order = new Map(ROAS_BANDS.map((b, i) => [b.key as BandKey, i]));
  for (const day of days.values()) {
    const bm = bucketsOf.get(day.date)!;
    day.buckets = [...bm.values()]
      .map((b) => {
        const pcts = b.camps.filter((c) => c.budget > 0).map((c) => c.pct);
        b.camps.sort((x, y) => y.spend - x.spend);
        return { ...b, roas: roasOf(b.revenue, b.spend), avgPct: mean(pcts), medPct: median(pcts) };
      })
      .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));

    const all = day.buckets.flatMap((b) => b.camps.filter((c) => c.budget > 0).map((c) => c.pct));
    day.avgPct = mean(all);
    day.medPct = median(all);
  }

  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
}
