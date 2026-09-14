import { q, n } from './db';
import { PORTALS } from './ads';

/**
 * One row per day: what the book was worth, how much of it was switched off by
 * ten in the morning, how much by midnight, and who did the switching.
 *
 * Reads camp_close_event, which is built nightly because detecting a close
 * needs a LAG over every snapshot in the window — about twenty seconds for
 * twenty-five days, far too slow per request. Today is not in that table yet,
 * so today alone is computed live and unioned in: one day of snapshots is
 * cheap, a month of them is not.
 */
export interface ClosingDay {
  date: string;
  camps: number;
  allocated: number;
  /** budget switched off and still off at midnight */
  closed: number;
  closedCamps: number;
  /** the part of that closing which had already happened by 10:00 IST */
  closedByTen: number;
  campsByTen: number;
  botCamps: number;
  botBudget: number;
  manualCamps: number;
  manualBudget: number;
  /** spend and revenue of the campaigns that ended the day closed */
  closedSpend: number;
  closedRevenue: number;
  spend: number;
  revenue: number;
  /** true once the bot's own record covers this day; before that, everything reads manual */
  botRecorded: boolean;
}

export type Move = 'push' | 'maintain' | 'minus' | 'first';

export interface ClosingDayRow extends ClosingDay {
  /** allocated today minus allocated the day before */
  delta: number;
  deltaPct: number;
  move: Move;
}

/** Under this, a change in the book is noise rather than a decision. */
export const MAINTAIN_BAND = 2;

export const MOVE_LABEL: Record<Move, string> = {
  push: 'Push',
  maintain: 'Maintain',
  minus: 'Minus',
  first: '—',
};

export async function dailyClosing(
  from: string,
  to: string,
  portals: readonly string[] = PORTALS,
): Promise<ClosingDayRow[]> {
  // One extra day at the front so the first visible row can be compared with
  // the day before it rather than showing a meaningless "first".
  const lead = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10);

  const rows = await q(
    `WITH w AS (SELECT $1::date AS a, $2::date AS b,
                       (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS today),
     today_state AS (
       SELECT (snapshot_at AT TIME ZONE 'Asia/Kolkata')::date AS d, campaign_id,
              MAX(daily_budget) AS budget,
              BOOL_OR(effective_status = 'ACTIVE') AS ever_active,
              (ARRAY_AGG(effective_status ORDER BY snapshot_at DESC))[1] <> 'ACTIVE' AS closed_at_eod
         FROM meta_campaign_snapshot, w
        WHERE snapshot_at >= (w.today - INTERVAL '5 hours 30 minutes')
        GROUP BY 1, 2
     ),
     state AS (
       SELECT c.d, c.campaign_id, c.budget, c.ever_active, c.closed_at_eod
         FROM camp_day_state c, w
        WHERE c.d BETWEEN w.a AND w.b AND c.d < w.today
       UNION ALL
       SELECT t.d, t.campaign_id, t.budget, t.ever_active, t.closed_at_eod
         FROM today_state t, w WHERE t.d BETWEEN w.a AND w.b
     ),
     today_ev AS (
       SELECT s.d, s.campaign_id, s.snapshot_at AS closed_at,
              (b.campaign_id IS NOT NULL) AS by_bot
         FROM (SELECT campaign_id, snapshot_at,
                      (snapshot_at AT TIME ZONE 'Asia/Kolkata')::date AS d,
                      (effective_status = 'ACTIVE') AS active,
                      LAG(effective_status = 'ACTIVE') OVER x AS prev_active,
                      LAG(snapshot_at)                 OVER x AS prev_at
                 FROM meta_campaign_snapshot, w
                WHERE snapshot_at >= (w.today - INTERVAL '5 hours 30 minutes')
               WINDOW x AS (PARTITION BY campaign_id ORDER BY snapshot_at)) s
         LEFT JOIN bot_pause_event b
                ON b.campaign_id = s.campaign_id
               AND b.paused_at >  s.prev_at
               AND b.paused_at <= s.snapshot_at + INTERVAL '2 minutes'
        WHERE s.prev_active AND NOT s.active
     ),
     ev AS (
       SELECT e.d, e.campaign_id, e.closed_at, e.by_bot
         FROM camp_close_event e, w WHERE e.d BETWEEN w.a AND w.b AND e.d < w.today
       UNION ALL SELECT d, campaign_id, closed_at, by_bot FROM today_ev
     ),
     -- A campaign can be cut, reopened and cut again in one day. What closed
     -- the book on it is its LAST close, so that is the one attributed.
     final_close AS (
       SELECT DISTINCT ON (d, campaign_id) d, campaign_id, closed_at, by_bot
         FROM ev ORDER BY d, campaign_id, closed_at DESC
     ),
     bot_from AS (SELECT MIN(d) AS d0 FROM bot_pause_event),
     perf AS (
       SELECT date AS d, campaign_id, spend, revenue
         FROM meta_analysis_campaign_daily, w
        WHERE date BETWEEN w.a AND w.b AND portal = ANY($3)
     )
     SELECT s.d::text AS date,
            COUNT(*)      FILTER (WHERE s.ever_active)                          AS camps,
            SUM(s.budget) FILTER (WHERE s.ever_active)                          AS allocated,
            SUM(s.budget) FILTER (WHERE s.ever_active AND s.closed_at_eod)      AS closed,
            COUNT(*)      FILTER (WHERE s.ever_active AND s.closed_at_eod)      AS closed_camps,
            SUM(s.budget) FILTER (WHERE s.ever_active AND s.closed_at_eod
                  AND (f.closed_at AT TIME ZONE 'Asia/Kolkata')::time <= TIME '10:00') AS closed_by_ten,
            COUNT(*)      FILTER (WHERE s.ever_active AND s.closed_at_eod
                  AND (f.closed_at AT TIME ZONE 'Asia/Kolkata')::time <= TIME '10:00') AS camps_by_ten,
            COUNT(*)      FILTER (WHERE s.ever_active AND s.closed_at_eod AND f.by_bot) AS bot_camps,
            SUM(s.budget) FILTER (WHERE s.ever_active AND s.closed_at_eod AND f.by_bot) AS bot_budget,
            COUNT(*)      FILTER (WHERE s.ever_active AND s.closed_at_eod AND NOT COALESCE(f.by_bot, false)) AS manual_camps,
            SUM(s.budget) FILTER (WHERE s.ever_active AND s.closed_at_eod AND NOT COALESCE(f.by_bot, false)) AS manual_budget,
            SUM(p.spend)   FILTER (WHERE s.ever_active AND s.closed_at_eod)     AS closed_spend,
            SUM(p.revenue) FILTER (WHERE s.ever_active AND s.closed_at_eod)     AS closed_revenue,
            SUM(p.spend)   FILTER (WHERE s.ever_active)                         AS spend,
            SUM(p.revenue) FILTER (WHERE s.ever_active)                         AS revenue,
            (s.d >= (SELECT d0 FROM bot_from))                                  AS bot_recorded
       FROM state s
       JOIN perf p ON p.d = s.d AND p.campaign_id = s.campaign_id
       LEFT JOIN final_close f ON f.d = s.d AND f.campaign_id = s.campaign_id
      GROUP BY 1, bot_recorded
      ORDER BY 1`,
    [lead, to, portals as string[]],
  );

  const days: ClosingDay[] = rows.map((r) => ({
    date: String(r.date),
    camps: n(r.camps),
    allocated: n(r.allocated),
    closed: n(r.closed),
    closedCamps: n(r.closed_camps),
    closedByTen: n(r.closed_by_ten),
    campsByTen: n(r.camps_by_ten),
    botCamps: n(r.bot_camps),
    botBudget: n(r.bot_budget),
    manualCamps: n(r.manual_camps),
    manualBudget: n(r.manual_budget),
    closedSpend: n(r.closed_spend),
    closedRevenue: n(r.closed_revenue),
    spend: n(r.spend),
    revenue: n(r.revenue),
    botRecorded: Boolean(r.bot_recorded),
  }));

  const out: ClosingDayRow[] = days.map((d, i) => {
    const prev = i > 0 ? days[i - 1] : null;
    const delta = prev ? d.allocated - prev.allocated : 0;
    const deltaPct = prev && prev.allocated > 0 ? (delta / prev.allocated) * 100 : 0;
    const move: Move = !prev ? 'first'
      : Math.abs(deltaPct) < MAINTAIN_BAND ? 'maintain'
        : deltaPct > 0 ? 'push' : 'minus';
    return { ...d, delta, deltaPct, move };
  });

  // Drop the lead-in day now that it has served as the first comparison.
  return out.filter((r) => r.date >= from);
}

export const shareOf = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
