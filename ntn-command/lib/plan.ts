import { q, n } from './db';
import { PORTALS, roasOf } from './ads';
import { closingBook, type BookRow } from './closingbook';

/**
 * Tomorrow's decisions, read off yesterday.
 *
 * Four blocks, in the order they get acted on: what the day actually earned
 * after ad cost, what each product deserves tomorrow, what the book would look
 * like if it were rebuilt from scratch against the age-band targets, and how
 * much of it is still learning.
 *
 * Every threshold here is a rule of the desk, not a discovery of this code —
 * they are gathered in one place so changing the protocol means changing one
 * constant, not hunting through JSX.
 */

/* ── the protocol ───────────────────────────────────────────────────────── */

/** What a campaign is expected to return, by how old it is. */
export const AGE_TARGETS = [
  { key: 'd1', label: 'Day 1', lo: 1, hi: 1, target: 1.15 },
  { key: 'd23', label: 'Day 2-3', lo: 2, hi: 3, target: 1.40 },
  { key: 'd47', label: 'Day 4-7', lo: 4, hi: 7, target: 1.60 },
  { key: 'd8', label: 'Day 8+', lo: 8, hi: 1e6, target: 1.80 },
] as const;

export type AgeKey = (typeof AGE_TARGETS)[number]['key'];

export const bandOfAge = (dayNo: number) =>
  AGE_TARGETS.find((b) => dayNo >= b.lo && dayNo <= b.hi) ?? AGE_TARGETS[3];

/** Push, hold or cut tomorrow. */
export type Move = 'push' | 'maintain' | 'minus';

export const PUSH_AT = 1.7;
export const MINUS_BELOW = 1.5;

/**
 * A campaign at 1.7 or better has earned more money; below 1.5 it should get
 * less. Between the two it holds — the band exists because a single day moves
 * enough on its own that reacting to every wobble just churns the book.
 */
export const moveFor = (roas: number): Move =>
  roas >= PUSH_AT ? 'push' : roas < MINUS_BELOW ? 'minus' : 'maintain';

export const MOVE_TEXT: Record<Move, string> = {
  push: 'Push',
  maintain: 'Maintain',
  minus: 'Minus',
};

/* ── manual profit ──────────────────────────────────────────────────────── */

export interface ProfitEntry {
  date: string;
  portal: string;
  profit: number | null;
  note: string;
  updatedAt: string | null;
}

/**
 * Profit is the one number no system here can compute: it needs landed cost,
 * RTO and shipping, none of which reach this warehouse. So it is typed in, and
 * stored per day and portal rather than per day alone — a portal at a loss
 * hidden inside a profitable total is exactly what this block exists to show.
 */
export async function profitFor(date: string): Promise<ProfitEntry[]> {
  const rows = await q(
    `SELECT d::text AS d, portal, profit, COALESCE(note, '') AS note,
            to_char(updated_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') AS at
       FROM ntn_daily_profit WHERE d = $1::date`,
    [date],
  );
  return rows.map((r) => ({
    date: String(r.d),
    portal: String(r.portal),
    profit: r.profit == null ? null : n(r.profit),
    note: String(r.note),
    updatedAt: r.at ? String(r.at) : null,
  }));
}

export async function saveProfit(
  date: string, portal: string, profit: number | null, note: string, who: string,
): Promise<void> {
  await q(
    `INSERT INTO ntn_daily_profit (d, portal, profit, note, updated_at, updated_by)
          VALUES ($1::date, $2, $3, $4, now(), $5)
     ON CONFLICT (d, portal) DO UPDATE
        SET profit = EXCLUDED.profit, note = EXCLUDED.note,
            updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [date, portal, profit, note, who],
  );
}

/* ── the book by age, against its targets ───────────────────────────────── */

export interface SlateRow {
  key: AgeKey;
  label: string;
  target: number;
  camps: number;
  budget: number;
  spend: number;
  revenue: number;
  roas: number;
  /** campaigns that met their band's target */
  keepCamps: number;
  keepBudget: number;
  keepSpend: number;
  keepRevenue: number;
  /** and those that did not */
  cutCamps: number;
  cutBudget: number;
  cutSpend: number;
  cutRevenue: number;
  /** campaigns with no spend at all — they proved nothing either way */
  idleCamps: number;
  idleBudget: number;
}

const emptySlate = (b: (typeof AGE_TARGETS)[number]): SlateRow => ({
  key: b.key, label: b.label, target: b.target,
  camps: 0, budget: 0, spend: 0, revenue: 0, roas: 0,
  keepCamps: 0, keepBudget: 0, keepSpend: 0, keepRevenue: 0,
  cutCamps: 0, cutBudget: 0, cutSpend: 0, cutRevenue: 0,
  idleCamps: 0, idleBudget: 0,
});

/**
 * The book rebuilt from nothing: every campaign that ran on `day` measured
 * against the target for its age, and its budget sorted into keep or cut.
 *
 * A campaign that spent nothing is neither — it never got the chance to fail,
 * and folding it into "cut" would overstate what the protocol actually says
 * about the day.
 */
export function cleanSlate(rows: BookRow[]): SlateRow[] {
  const out = new Map<AgeKey, SlateRow>(
    AGE_TARGETS.map((b) => [b.key, emptySlate(b)]),
  );
  for (const r of rows) {
    const band = bandOfAge(r.dayNo);
    const a = out.get(band.key)!;
    a.camps += 1; a.budget += r.budget; a.spend += r.spend; a.revenue += r.revenue;
    if (r.spend <= 0) {
      a.idleCamps += 1; a.idleBudget += r.budget;
    } else if (roasOf(r.revenue, r.spend) >= band.target) {
      a.keepCamps += 1; a.keepBudget += r.budget;
      a.keepSpend += r.spend; a.keepRevenue += r.revenue;
    } else {
      a.cutCamps += 1; a.cutBudget += r.budget;
      a.cutSpend += r.spend; a.cutRevenue += r.revenue;
    }
  }
  return [...out.values()].map((a) => ({ ...a, roas: roasOf(a.revenue, a.spend) }));
}

export const slateTotal = (rows: SlateRow[]): SlateRow => {
  const t = { ...emptySlate(AGE_TARGETS[0]), key: 'd1' as AgeKey, label: 'Whole book', target: 0 };
  for (const r of rows) {
    t.camps += r.camps; t.budget += r.budget; t.spend += r.spend; t.revenue += r.revenue;
    t.keepCamps += r.keepCamps; t.keepBudget += r.keepBudget;
    t.keepSpend += r.keepSpend; t.keepRevenue += r.keepRevenue;
    t.cutCamps += r.cutCamps; t.cutBudget += r.cutBudget;
    t.cutSpend += r.cutSpend; t.cutRevenue += r.cutRevenue;
    t.idleCamps += r.idleCamps; t.idleBudget += r.idleBudget;
  }
  t.roas = roasOf(t.revenue, t.spend);
  return t;
};

/* ── what is still learning ─────────────────────────────────────────────── */

export interface LearningRow {
  portal: string;
  camps: number;
  allocated: number;
  spend: number;
  revenue: number;
  roas: number;
  /** budget still switched on at the end of the day */
  active: number;
  activeCamps: number;
  closed: number;
  closedCamps: number;
}

/**
 * Day 1 only: what was committed to launches, and how much of it survived the
 * day. Day 1 is the learning cohort — Meta has not settled delivery yet, its
 * target is the lowest of any band, and it is also the band the closing
 * protocol polices hardest, so the two numbers side by side say whether a
 * launch budget was given a chance or withdrawn.
 */
export function learningBudget(rows: BookRow[]): LearningRow[] {
  const m = new Map<string, LearningRow>();
  for (const r of rows) {
    if (r.dayNo !== 1) continue;
    const a = m.get(r.portal) ?? {
      portal: r.portal, camps: 0, allocated: 0, spend: 0, revenue: 0, roas: 0,
      active: 0, activeCamps: 0, closed: 0, closedCamps: 0,
    };
    a.camps += 1; a.allocated += r.budget; a.spend += r.spend; a.revenue += r.revenue;
    if (r.closed) { a.closedCamps += 1; a.closed += r.budget; }
    else { a.activeCamps += 1; a.active += r.budget; }
    m.set(r.portal, a);
  }
  return [...m.values()]
    .map((a) => ({ ...a, roas: roasOf(a.revenue, a.spend) }))
    .sort((a, b) => b.allocated - a.allocated);
}

export const learningTotal = (rows: LearningRow[]): LearningRow => {
  const t: LearningRow = {
    portal: 'all', camps: 0, allocated: 0, spend: 0, revenue: 0, roas: 0,
    active: 0, activeCamps: 0, closed: 0, closedCamps: 0,
  };
  for (const r of rows) {
    t.camps += r.camps; t.allocated += r.allocated; t.spend += r.spend; t.revenue += r.revenue;
    t.active += r.active; t.activeCamps += r.activeCamps;
    t.closed += r.closed; t.closedCamps += r.closedCamps;
  }
  t.roas = roasOf(t.revenue, t.spend);
  return t;
};

export { closingBook };
