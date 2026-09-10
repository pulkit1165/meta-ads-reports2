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
