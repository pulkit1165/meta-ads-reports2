'use client';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { PRESETS, PORTAL_CODES, PORTAL_SHORT, type ScopeKey } from '@/lib/range';

const THEMES = [
  { key: 'dark', label: 'Black' },
  { key: 'light', label: 'White' },
  { key: 'cream', label: 'Cream' },
] as const;

export type ThemeKey = (typeof THEMES)[number]['key'];

/* ── theme ──────────────────────────────────────────────────────────────── */

export function ThemeSwitch() {
  // Start from whatever the pre-paint script already put on <html>, so the
  // control agrees with the page on first render instead of flicking to a
  // default and back.
  const [theme, setTheme] = useState<ThemeKey>('dark');

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme') as ThemeKey | null;
    if (current) setTheme(current);
  }, []);

  const pick = (k: ThemeKey) => {
    setTheme(k);
    document.documentElement.setAttribute('data-theme', k);
    try {
      localStorage.setItem('ntn-theme', k);
    } catch {
      /* private mode; the choice just won't survive the tab */
    }
  };

  return (
    <div className="flex rounded-lg border border-edge p-0.5" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => pick(t.key)}
          aria-pressed={theme === t.key}
          className={`rounded-md px-2.5 py-1 text-[11px] transition ${
            theme === t.key ? 'bg-gold/15 text-gold' : 'text-muted hover:text-text'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ── date range ─────────────────────────────────────────────────────────── */

export function DateRange({ days, from, to, custom }: {
  days: number; from: string; to: string; custom: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(custom);
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);

  const push = useCallback(
    (next: URLSearchParams) => {
      start(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [pathname, router],
  );

  const preset = (n: number) => {
    const next = new URLSearchParams(sp.toString());
    next.set('days', String(n));
    next.delete('from');
    next.delete('to');
    setOpen(false);
    push(next);
  };

  const apply = () => {
    if (!f || !t) return;
    const next = new URLSearchParams(sp.toString());
    next.set('from', f);
    next.set('to', t);
    next.delete('days');
    push(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className={`flex rounded-lg border border-edge p-0.5 ${pending ? 'opacity-50' : ''}`}>
        {PRESETS.map((p) => (
          <button
            key={p.days}
            type="button"
            onClick={() => preset(p.days)}
            aria-pressed={!custom && days === p.days}
            className={`rounded-md px-2.5 py-1 text-[11px] transition ${
              !custom && days === p.days ? 'bg-gold/15 text-gold' : 'text-muted hover:text-text'
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-pressed={custom}
          className={`rounded-md px-2.5 py-1 text-[11px] transition ${
            custom ? 'bg-gold/15 text-gold' : 'text-muted hover:text-text'
          }`}
        >
          Custom
        </button>
      </div>

      {open && (
        <div className="flex items-center gap-1.5 rounded-lg border border-edge px-2 py-1">
          <input
            type="date" value={f} max={t} onChange={(e) => setF(e.target.value)}
            className="bg-transparent text-[11px] text-text outline-none"
          />
          <span className="text-[11px] text-muted">→</span>
          <input
            type="date" value={t} min={f} onChange={(e) => setT(e.target.value)}
            className="bg-transparent text-[11px] text-text outline-none"
          />
          <button
            type="button" onClick={apply}
            className="rounded-md bg-gold/15 px-2 py-0.5 text-[11px] text-gold"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}

/* ── website ────────────────────────────────────────────────────────────── */

/**
 * Scopes the whole report to one storefront. Lives in the URL beside the date
 * window, so a link carries both — send someone "/blocks?site=NBP&days=30" and
 * they see exactly what you saw.
 */
export function SiteSwitch({ scope }: { scope: ScopeKey }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();

  const pick = (k: ScopeKey) => {
    const next = new URLSearchParams(sp.toString());
    if (k === 'all') next.delete('site');
    else next.set('site', k);
    start(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
  };

  const keys: ScopeKey[] = ['all', ...PORTAL_CODES];
  return (
    <div
      className={`flex rounded-lg border border-edge p-0.5 ${pending ? 'opacity-50' : ''}`}
      role="group"
      aria-label="Website"
    >
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => pick(k)}
          aria-pressed={scope === k}
          className={`rounded-md px-2.5 py-1 text-[11px] transition ${
            scope === k ? 'bg-gold/15 text-gold' : 'text-muted hover:text-text'
          }`}
        >
          {PORTAL_SHORT[k]}
        </button>
      ))}
    </div>
  );
}

/* ── day picker ─────────────────────────────────────────────────────────── */

/**
 * Picks which day a single-day report is about. The choice lives in the URL as
 * `?day=`, so every section on the page moves together and a link carries the
 * day the sender was reading.
 *
 * Today is labelled as partial rather than hidden: it is legitimate to look at,
 * but its revenue lags its spend all day, so a reader needs to be told.
 */
export function DayPicker({ days, value, today }: {
  days: string[]; value: string; today: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();

  const pick = (d: string) => {
    const next = new URLSearchParams(sp.toString());
    next.set('day', d);
    start(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
  };

  const label = (d: string) => {
    const dt = new Date(`${d}T00:00:00Z`);
    const nice = dt.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', weekday: 'short', timeZone: 'UTC',
    });
    return d === today ? `${nice} · today, partial` : nice;
  };

  return (
    <label className={`flex items-center gap-1.5 rounded-lg border border-edge px-2 py-1 ${pending ? 'opacity-50' : ''}`}>
      <span className="text-[10.5px] uppercase tracking-wider text-muted">Day</span>
      <select
        value={value}
        onChange={(e) => pick(e.target.value)}
        className="cursor-pointer bg-transparent text-[11.5px] text-text outline-none"
      >
        {days.map((d) => (
          <option key={d} value={d} className="bg-panel text-text">
            {label(d)}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ── ROAS ceiling filter ────────────────────────────────────────────────── */

/**
 * Show only campaigns BELOW a ROAS. The point of the control is to isolate the
 * weak end of a book that is otherwise healthy on average, so the presets are
 * the same thresholds the report bands use.
 */
const ROAS_CEILINGS = [
  { v: '', label: 'All' },
  { v: '1.8', label: '< 1.8' },
  { v: '1.4', label: '< 1.4' },
  { v: '1.15', label: '< 1.15' },
  { v: '1.0', label: '< 1.0' },
];

export function RoasFilter({ value }: { value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [custom, setCustom] = useState(value);

  const apply = (v: string) => {
    const next = new URLSearchParams(sp.toString());
    if (v) next.set('maxRoas', v);
    else next.delete('maxRoas');
    start(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
  };

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${pending ? 'opacity-50' : ''}`}>
      <span className="text-[10.5px] uppercase tracking-wider text-muted">ROAS below</span>
      <div className="flex rounded-lg border border-edge p-0.5" role="group" aria-label="ROAS ceiling">
        {ROAS_CEILINGS.map((c) => (
          <button
            key={c.v || 'all'}
            type="button"
            onClick={() => apply(c.v)}
            aria-pressed={value === c.v}
            className={`rounded-md px-2.5 py-1 text-[11px] transition ${
              value === c.v ? 'bg-gold/15 text-gold' : 'text-muted hover:text-text'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <input
        type="number" step="0.05" min="0" placeholder="custom"
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') apply(custom); }}
        onBlur={() => { if (custom !== value) apply(custom); }}
        className="w-[74px] rounded-lg border border-edge bg-transparent px-2 py-1 text-[11px] text-text outline-none"
      />
    </div>
  );
}
