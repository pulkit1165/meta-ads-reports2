/**
 * One date-range contract for every module.
 *
 * Presets are expressed as `?days=N` and a custom window as `?from=&to=`.
 * Everything is resolved in IST, because that is the day the shop and the ad
 * accounts both close on; using the server's UTC day would shift every
 * boundary by five and a half hours.
 */
/**
 * Every preset except Today describes COMPLETE days and ends at yesterday.
 *
 * Windows used to end at today, which meant the preset labelled "Yesterday"
 * actually showed today, and every multi-day window mixed a half-finished day
 * into its averages. Revenue is attributed later than spend, so a partial day
 * always drags a window down and reads as a decline that has not happened.
 * Today is still selectable — it is just named honestly.
 */
export const PRESETS = [
  { days: 0, label: 'Today' },
  { days: 1, label: 'Yesterday' },
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
  { days: 60, label: '60 days' },
  { days: 90, label: '90 days' },
] as const;

export interface Range {
  /** inclusive, YYYY-MM-DD */
  from: string;
  /** inclusive, YYYY-MM-DD — today in IST unless a custom `to` was given */
  to: string;
  /** today in IST, whatever the range */
  today: string;
  /** yesterday in IST */
  yesterday: string;
  /**
   * The preset's identity, which is also its span in days — except Today,
   * which is 0 so the control can distinguish it from Yesterday. Use `span`
   * when the actual number of days matters.
   */
  days: number;
  /** Number of days the window covers, inclusive. Always at least 1. */
  span: number;
  label: string;
  custom: boolean;
}

const DAY = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Today in IST, computed without depending on the server's zone. */
export function istToday(): string {
  return iso(new Date(Date.now() + 5.5 * 3600 * 1000));
}

const valid = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export type SearchParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function resolveRange(sp: SearchParams | undefined, fallbackDays = 60): Range {
  const today = istToday();
  const yesterday = iso(new Date(Date.parse(today) - DAY));

  const rawFrom = one(sp?.from);
  const rawTo = one(sp?.to);

  if (valid(rawFrom) && valid(rawTo)) {
    // Tolerate the two ends being handed over the wrong way round rather than
    // returning an empty window that looks like "no data".
    const [from, to] = rawFrom <= rawTo ? [rawFrom, rawTo] : [rawTo, rawFrom];
    const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
    return { from, to, today, yesterday, days, span: days, label: `${from} → ${to}`, custom: true };
  }

  const n = Number(one(sp?.days));
  const days = Number.isFinite(n) && n >= 0 && n <= 730 ? Math.floor(n) : fallbackDays;
  const preset = PRESETS.find((p) => p.days === days);

  // days === 0 is the live view: today only, partial by definition.
  if (days === 0) {
    // days stays 0 so the control can tell Today apart from Yesterday — both
    // span a single day, but reporting 1 here lit the wrong button.
    return { from: today, to: today, today, yesterday, days: 0, span: 1, label: 'Today', custom: false };
  }

  // Everything else ends at yesterday, so a window is N complete days.
  const from = iso(new Date(Date.parse(yesterday) - (days - 1) * DAY));
  return {
    from,
    to: yesterday,
    today,
    yesterday,
    days,
    span: days,
    label: preset ? preset.label : `${days} days`,
    custom: false,
  };
}

/** Every date in the window, ascending. Useful for zero-filling a series. */
export function eachDay(r: Range): string[] {
  const out: string[] = [];
  for (let t = Date.parse(r.from); t <= Date.parse(r.to); t += DAY) out.push(iso(new Date(t)));
  return out;
}

export const dayLabel = (d: string) => `${d.slice(8)}/${d.slice(5, 7)}`;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Which day of the week a date fell on.
 *
 * Parsed as UTC midnight rather than local: a bare YYYY-MM-DD is treated as
 * local time by Date, so on a server west of the date line the weekday would
 * come out one day early for every row.
 */
export const weekday = (d: string) => WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()] ?? '';

/** True for Saturday and Sunday, which trade differently from a weekday. */
export const isWeekend = (d: string) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return w === 0 || w === 6;
};

/* ── website scope ──────────────────────────────────────────────────────── */

/**
 * Which storefront a report is about.
 *
 * The same three codes identify a portal in the ads tables and a store in
 * shopify_orders, so one parameter scopes every module. 'all' is the default
 * and means the group, not a fourth brand.
 */
export const PORTAL_CODES = ['SM', 'SML', 'NBP'] as const;
export type PortalCode = (typeof PORTAL_CODES)[number];
export type ScopeKey = 'all' | PortalCode;

export const PORTAL_LABEL: Record<PortalCode, string> = {
  SM: 'Studd Muffyn',
  SML: 'SM Life',
  NBP: 'Nuskhe by Paras',
};

/** Short forms for the switch, which has to fit beside the date presets. */
export const PORTAL_SHORT: Record<ScopeKey, string> = {
  all: 'All',
  SM: 'Studd Muffyn',
  SML: 'SM Life',
  NBP: 'Nuskhe',
};

export interface Scope {
  key: ScopeKey;
  /** The codes to filter on — every portal when the scope is 'all'. */
  codes: PortalCode[];
  label: string;
  /** True when a single website is selected. */
  single: boolean;
}

export function resolveScope(sp: SearchParams | undefined): Scope {
  const raw = Array.isArray(sp?.site) ? sp?.site[0] : sp?.site;
  const key = (PORTAL_CODES as readonly string[]).includes(String(raw))
    ? (raw as PortalCode)
    : 'all';
  return key === 'all'
    ? { key, codes: [...PORTAL_CODES], label: 'All websites', single: false }
    : { key, codes: [key], label: PORTAL_LABEL[key], single: true };
}
