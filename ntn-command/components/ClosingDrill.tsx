'use client';

import { Fragment, useState } from 'react';
import type { DrillDay, DrillBucket, DrillCamp } from '@/lib/closingdrill';
import { Roas, rs, pct, num } from '@/components/ui';
import { Meter } from '@/components/charts';

/**
 * Closing, three levels deep: the day, the ROAS band it died in, the campaigns.
 *
 * The day rows stay a real <table> so the page's Excel export still picks them
 * up; what opens underneath is a grid inside one full-width cell, marked
 * data-export="skip" so the spreadsheet gets clean day rows instead of one cell
 * holding a flattened copy of everything below it.
 *
 * Both levels open on click, and several can be open at once — comparing two
 * days, or the same band across two days, is the reason to open them at all.
 */
export interface ClosingRow {
  date: string;
  weekday: string;
  weekend: boolean;
  label: string;
  allocated: number;
  spend: number;
  closed: number;
  closedCamps: number;
  closedPct: number;
  byTenPct: number;
  closeRoas: number | null;
  dayRoas: number;
  drill: DrillDay | null;
}

const DAY_COLS = 10;
const BUCKET_GRID = '170px 74px 116px 104px 88px 82px 92px 104px';
// Fixed widths, not 1fr: the day table sizes itself to its widest content, and a
// flexible name column would stretch it to the longest campaign name — pushing
// "Closed by", the reason for opening this at all, off the right edge.
const CAMP_GRID = '54px 380px 52px 44px 92px 92px 74px 68px 80px';

const head = 'text-[10.5px] uppercase tracking-[0.12em] text-muted font-medium';
const cellR = 'px-2 py-1.5 text-right tabular-nums';
const cellL = 'px-2 py-1.5 text-left';

function Caret({ open }: { open: boolean }) {
  return (
    <span
      className={`mr-1.5 inline-block text-[9px] text-muted transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden
    >
      ▶
    </span>
  );
}

function Actor({ c }: { c: DrillCamp }) {
  const bot = c.actor === 'bot';
  const why = bot
    ? [c.rule, c.gate ? `gate Rs ${Math.round(c.gate).toLocaleString('en-IN')}` : null]
        .filter(Boolean).join(' · ') || 'auto-pause ladder'
    : 'no bot claim in this interval — switched off in Ads Manager';
  return (
    <span
      title={why}
      className={`rounded-full px-2 py-0.5 text-[11px] ${bot ? 'bg-tint text-muted' : 'bg-warn/15 text-warn'}`}
    >
      {bot ? 'bot' : 'manual'}
    </span>
  );
}

function Camps({ camps }: { camps: DrillCamp[] }) {
  return (
    <div className="mt-1 border-l border-edge/60 pl-3">
      <div className="grid gap-x-1 border-b border-edge/40" style={{ gridTemplateColumns: CAMP_GRID }}>
        <span className={`${cellL} ${head}`}>Time</span>
        <span className={`${cellL} ${head}`}>Campaign</span>
        <span className={`${cellL} ${head}`}>Site</span>
        <span className={`${cellR} ${head}`}>Age</span>
        <span className={`${cellR} ${head}`}>Budget</span>
        <span className={`${cellR} ${head}`}>Spent</span>
        <span className={`${cellR} ${head}`}>Spend %</span>
        <span className={`${cellR} ${head}`}>ROAS</span>
        <span className={`${cellL} ${head}`}>Closed by</span>
      </div>
      {camps.map((c) => (
        <div
          key={`${c.id}-${c.at}`}
          className="grid gap-x-1 border-b border-edge/25 text-[12px] last:border-0 hover:bg-hover"
          style={{ gridTemplateColumns: CAMP_GRID }}
        >
          <span className={`${cellL} tabular-nums text-muted`}>{c.at}</span>
          <span className={`${cellL} truncate text-text-strong`} title={c.name}>{c.name}</span>
          <span className={`${cellL} text-muted`}>{c.portal}</span>
          <span className={`${cellR} text-muted`}>D{c.dayNo}</span>
          <span className={cellR}>{rs(c.budget)}</span>
          <span className={cellR}>{rs(c.spend)}</span>
          <span className={`${cellR} ${c.pct >= 100 ? 'text-warn' : 'text-muted'}`}>{pct(c.pct)}</span>
          <span className={cellR}><Roas v={c.roas} /></span>
          <span className={cellL}><Actor c={c} /></span>
        </div>
      ))}
    </div>
  );
}

function Buckets({ day, closedBudget }: { day: DrillDay; closedBudget: number }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  const book = closedBudget || day.budget;

  return (
    <div className="min-w-[860px]">
      <div className="grid gap-x-1 border-b border-edge" style={{ gridTemplateColumns: BUCKET_GRID }}>
        <span className={`${cellL} ${head}`}>ROAS at close</span>
        <span className={`${cellR} ${head}`}>Camps</span>
        <span className={`${cellR} ${head}`}>Budget off</span>
        <span className={`${cellR} ${head}`}>Share</span>
        <span className={`${cellR} ${head}`} title="mean spend against budget at the moment of the cut">Avg spend %</span>
        <span className={`${cellR} ${head}`} title="median — one campaign cut at 400% of a tiny budget drags the mean">Median</span>
        <span className={`${cellR} ${head}`}>Return</span>
        <span className={`${cellR} ${head}`}>Bot / manual</span>
      </div>

      {day.buckets.map((b: DrillBucket) => {
        const isOpen = open.has(b.key);
        return (
          <div key={b.key} className="border-b border-edge/40 last:border-0">
            <div
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              onClick={() => toggle(b.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(b.key); }
              }}
              className={`grid cursor-pointer gap-x-1 text-[12.5px] hover:bg-hover ${isOpen ? 'bg-hover/60' : ''}`}
              style={{ gridTemplateColumns: BUCKET_GRID }}
            >
              <span className={`${cellL} whitespace-nowrap`}>
                <Caret open={isOpen} />
                <span
                  className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                  style={{ background: b.color }}
                />
                <span className="align-middle text-text-strong">{b.label}</span>
              </span>
              <span className={cellR}>{num(b.closes)}</span>
              <span className={cellR}>{rs(b.budget)}</span>
              <span className={cellR}><Meter value={book > 0 ? (b.budget / book) * 100 : 0} /></span>
              <span className={cellR}>{pct(b.avgPct)}</span>
              <span className={`${cellR} text-muted`}>{pct(b.medPct)}</span>
              <span className={cellR}><Roas v={b.roas} /></span>
              <span className={`${cellR} text-muted`}>
                {num(b.bot)} / <span className={b.manual ? 'text-warn' : ''}>{num(b.manual)}</span>
              </span>
            </div>
            {isOpen && <Camps camps={b.camps} />}
          </div>
        );
      })}
    </div>
  );
}

export default function ClosingDrill({ rows }: { rows: ClosingRow[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (d: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(d)) next.delete(d); else next.add(d);
      return next;
    });

  const cell = (align: 'l' | 'r') =>
    `px-3 py-2 ${align === 'r' ? 'text-right tabular-nums' : 'text-left'}`;
  const HEADS: [string, 'l' | 'r'][] = [
    ['Day', 'l'], ['Date', 'l'], ['Allocated', 'r'], ['Spent', 'r'], ['Closed', 'r'],
    ['Camps off', 'r'], ['Closed %', 'r'], ['By 10:00', 'r'], ['ROAS at close', 'r'], ['Day ROAS', 'r'],
  ];

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-edge">
            {HEADS.map(([h, a]) => (
              <th key={h} className={`${cell(a)} ${head}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOpen = open.has(r.date);
            const d = r.drill;
            return (
              <Fragment key={r.date}>
                <tr
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={() => toggle(r.date)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(r.date); }
                  }}
                  className={`cursor-pointer border-b border-edge/50 hover:bg-hover ${isOpen ? 'bg-hover/60' : ''}`}
                >
                  <td className={cell('l')}>
                    <Caret open={isOpen} />
                    <span className={r.weekend ? 'text-muted/70' : 'text-muted'}>{r.weekday}</span>
                  </td>
                  <td className={cell('l')}>{r.label}</td>
                  <td className={cell('r')}>{rs(r.allocated)}</td>
                  <td className={cell('r')}>{rs(r.spend)}</td>
                  <td className={cell('r')}>{rs(r.closed)}</td>
                  <td className={`${cell('r')} text-muted`}>{num(r.closedCamps)}</td>
                  <td className={cell('r')}>
                    <Meter value={r.closedPct} tone={r.closedPct >= 70 ? 'warn' : 'neutral'} />
                  </td>
                  <td className={`${cell('r')} text-muted`}>{pct(r.byTenPct)}</td>
                  <td className={cell('r')}><Roas v={r.closeRoas} /></td>
                  <td className={cell('r')}><Roas v={r.dayRoas} /></td>
                </tr>

                {isOpen && (
                  <tr className="border-b border-edge bg-tint/20">
                    <td colSpan={HEADS.length} className="px-4 py-3" data-export="skip">
                      {d && d.closes > 0 ? (
                        <>
                          <p className="mb-2 text-[11px] text-muted">
                            <span className="text-text-strong">{num(d.closes)} campaigns</span> switched off on{' '}
                            {r.label} — {rs(d.budget)} of budget, {num(d.bot)} by the bot and{' '}
                            {num(d.manual)} by hand. Typical burn before the cut:{' '}
                            <span className="text-text">{pct(d.medPct)}</span> of budget (mean {pct(d.avgPct)}).
                            {' '}Click a band for the campaigns in it.
                          </p>
                          <div className="overflow-x-auto">
                            <Buckets day={d} closedBudget={r.closed} />
                          </div>
                        </>
                      ) : (
                        <p className="py-2 text-[12px] text-muted">
                          No close was captured on this day — either nothing was switched off, or the
                          snapshots did not catch the flip.
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
