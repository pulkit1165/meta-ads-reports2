import Link from 'next/link';
import {
  campDays, closingOn, productMap, familyOf, creativeTags, roasOf, share,
  LOSING, bandOf, PORTAL_NAME,
} from '@/lib/ads';
import { repeatRate, paymentsByDay, isCOD, istDates } from '@/lib/commerce';
import { resolveRange, istToday, type SearchParams } from '@/lib/range';
import { rank, wilson, enough, money, pctOf, trend, concentration, type Finding } from '@/lib/insights';
import PageControls from '@/components/PageControls';
import { Page, Card, Grid, Stat, Note, Analysis, lakh, pct, num } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** One dead source must not blank the whole read-across. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

type Sourced = Finding & { module: string; href: string };

export default async function SignalsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 14);
  const controls = <PageControls range={range} />;
  const { yesterday } = await istDates();

  const [days, snap, pmap, rep, pay] = await Promise.all([
    safe(() => campDays(range.from, range.to)),
    safe(() => closingOn(istToday())),
    safe(() => productMap()),
    safe(() => repeatRate(range.from, range.to)),
    safe(() => paymentsByDay(range.from, range.to)),
  ]);

  const spent = (days ?? []).filter((r) => r.spend > 0);
  const out: Sourced[] = [];

  /* ── ads: the day itself ────────────────────────────────────────────────── */
  const dates = [...new Set(spent.map((r) => r.date))].sort();
  const complete = dates.length > 1 ? dates.slice(0, -1) : dates;
  const lastDay = complete[complete.length - 1];
  const on = (d: string) => spent.filter((r) => r.date === d);

  if (lastDay) {
    const dSpend = on(lastDay).reduce((s, r) => s + r.spend, 0);
    const dRev = on(lastDay).reduce((s, r) => s + r.revenue, 0);
    const dLose = on(lastDay).filter((r) => LOSING.includes(bandOf(r.roas))).reduce((s, r) => s + r.spend, 0);
    const losePct = pctOf(dLose, dSpend);
    if (losePct >= 42) {
      out.push({
        module: 'Budget & ROAS', href: '/budget',
        severity: losePct >= 52 ? 'critical' : 'watch',
        headline: `${losePct.toFixed(0)}% of ${lastDay}'s spend returned under 1.0`,
        detail: `${money(dLose)} of ${money(dSpend)}, closing the day at ${roasOf(dRev, dSpend).toFixed(2)}.`,
      });
    }
    const roasSeries = complete.map((d) => {
      const s = on(d).reduce((a, r) => a + r.spend, 0);
      return s ? on(d).reduce((a, r) => a + r.revenue, 0) / s : 0;
    });
    const tr = trend(roasSeries);
    if (tr != null && Math.abs(tr) > 1.5) {
      out.push({
        module: 'Budget & ROAS', href: '/budget',
        severity: tr > 0 ? 'good' : 'watch',
        headline: `Blended ROAS is ${tr > 0 ? 'improving' : 'drifting down'} about ${Math.abs(tr).toFixed(1)}% a day`,
        detail: `${roasSeries[0].toFixed(2)} → ${roasSeries[roasSeries.length - 1].toFixed(2)} across ${complete.length} complete days.`,
      });
    }
  }

  /* ── ads: audiences ─────────────────────────────────────────────────────── */
  const blocks = new Map<string, { key: string; spend: number; rev: number; days: number; winners: number }>();
  for (const r of spent) {
    const b = blocks.get(r.saleBlock) ?? { key: r.saleBlock, spend: 0, rev: 0, days: 0, winners: 0 };
    b.spend += r.spend; b.rev += r.revenue; b.days += 1;
    if (r.roas >= 1) b.winners += 1;
    blocks.set(r.saleBlock, b);
  }
  const totalSpend = spent.reduce((s, r) => s + r.spend, 0);
  const bigLoser = [...blocks.values()]
    .filter((b) => b.spend >= totalSpend * 0.06 && roasOf(b.rev, b.spend) < 0.85)
    .sort((a, b) => b.spend - a.spend)[0];
  if (bigLoser) {
    out.push({
      module: 'Sales Blocks', href: '/blocks',
      severity: 'critical',
      headline: `${bigLoser.key.slice(0, 54)} is large and losing`,
      detail: `${money(bigLoser.spend)} — ${pctOf(bigLoser.spend, totalSpend).toFixed(0)}% of spend — at ${roasOf(bigLoser.rev, bigLoser.spend).toFixed(2)} ROAS.`,
    });
  }

  /* ── ads: creative ──────────────────────────────────────────────────────── */
  const cre = new Map<string, { key: string; spend: number; rev: number; days: number; winners: number }>();
  for (const r of spent) {
    for (const tag of creativeTags(r.creativeType)) {
      const c = cre.get(tag) ?? { key: tag, spend: 0, rev: 0, days: 0, winners: 0 };
      c.spend += r.spend; c.rev += r.revenue; c.days += 1;
      if (r.roas >= 1) c.winners += 1;
      cre.set(tag, c);
    }
  }
  const creSolid = [...cre.values()].filter((c) => enough(c.days, 25));
  if (creSolid.length >= 2) {
    const s = [...creSolid].sort((a, b) => wilson(b.winners, b.days).lo - wilson(a.winners, a.days).lo);
    const top = s[0], bot = s[s.length - 1];
    const tw = wilson(top.winners, top.days), bw = wilson(bot.winners, bot.days);
    if (tw.lo > bw.hi) {
      out.push({
        module: 'Creative Success', href: '/creative',
        severity: 'good',
        headline: `${top.key} beats ${bot.key} conclusively`,
        detail: `${tw.rate.toFixed(0)}% vs ${bw.rate.toFixed(0)}% hit rate, and the 95% intervals do not overlap.`,
      });
    }
  }

  /* ── ads: products ──────────────────────────────────────────────────────── */
  if (pmap) {
    const prods = new Map<string, { key: string; spend: number; rev: number }>();
    for (const r of spent) {
      const k = pmap.get(r.campaignId) ?? 'unmapped';
      const p = prods.get(k) ?? { key: k, spend: 0, rev: 0 };
      p.spend += r.spend; p.rev += r.revenue;
      prods.set(k, p);
    }
    const unmapped = prods.get('unmapped');
    if (unmapped && unmapped.spend > totalSpend * 0.2) {
      out.push({
        module: 'Product Success', href: '/products',
        severity: 'watch',
        headline: `${pctOf(unmapped.spend, totalSpend).toFixed(0)}% of spend has no product mapped`,
        detail: `${money(unmapped.spend)} cannot be attributed to a product, so every product figure is a floor.`,
      });
    }
    const conc = concentration([...prods.values()].filter((p) => p.key !== 'unmapped'), (p) => p.spend);
    if (conc.top && conc.topShare >= 35) {
      out.push({
        module: 'Allocation', href: '/allocation',
        severity: 'neutral',
        headline: `${conc.topShare.toFixed(0)}% of mapped spend is on ${conc.top.key}`,
        detail: `At ${roasOf(conc.top.rev, conc.top.spend).toFixed(2)} ROAS. A listing or stock problem there is immediately a revenue problem.`,
      });
    }
  }

  /* ── closing ────────────────────────────────────────────────────────────── */
  if (snap?.rows.length) {
    const alloc = snap.rows.reduce((s, r) => s + r.budget, 0);
    const closed = snap.rows.filter((r) => r.closed).reduce((s, r) => s + r.budget, 0);
    const cp = pctOf(closed, alloc);
    if (cp >= 60) {
      out.push({
        module: 'Closing Desk', href: '/closing',
        severity: cp >= 72 ? 'critical' : 'watch',
        headline: `${cp.toFixed(0)}% of today's book is already off`,
        detail: `${money(closed)} of ${money(alloc)} closed by the ${snap.cutIST} IST snapshot.`,
      });
    }
    const fams = new Map<string, { b: number; c: number }>();
    for (const r of snap.rows) {
      const k = familyOf(r.saleBlock);
      const f = fams.get(k) ?? { b: 0, c: 0 };
      f.b += r.budget;
      if (r.closed) f.c += r.budget;
      fams.set(k, f);
    }
    for (const [k, f] of fams) {
      if (f.b >= 80000 && pctOf(f.c, f.b) >= 70) {
        out.push({
          module: 'Closing Desk', href: '/closing',
          severity: 'watch',
          headline: `${k} is being cut almost entirely today`,
          detail: `${pctOf(f.c, f.b).toFixed(0)}% of its ${money(f.b)} is off.`,
        });
        break;
      }
    }
  }

  /* ── commerce ───────────────────────────────────────────────────────────── */
  const yPay = (pay ?? []).filter((r) => r.date === yesterday);
  const payRev = yPay.reduce((s, r) => s + r.revenue, 0);
  const codRev = yPay.filter((r) => isCOD(r.mode)).reduce((s, r) => s + r.revenue, 0);
  if (payRev > 0 && pctOf(codRev, payRev) >= 32) {
    out.push({
      module: 'Payments', href: '/payments',
      severity: 'watch',
      headline: `COD was ${pctOf(codRev, payRev).toFixed(0)}% of yesterday's value`,
      detail: `${money(codRev)} of ${money(payRev)}. COD carries RTO risk that never shows up in ROAS.`,
    });
  }

  const yRep = (rep ?? []).filter((r) => r.date === yesterday);
  const repN = yRep.reduce((s, r) => s + r.repeatOrders, 0);
  const newN = yRep.reduce((s, r) => s + r.newOrders, 0);
  if (repN + newN > 0) {
    const rp = pctOf(repN, repN + newN);
    out.push({
      module: 'New vs Returning', href: '/cohorts',
      severity: rp >= 55 ? 'good' : rp <= 35 ? 'watch' : 'neutral',
      headline: `${rp.toFixed(0)}% of yesterday's orders were repeat buyers`,
      detail: `${num(repN)} of ${num(repN + newN)} attributable orders.`,
    });
  }

  const ranked = rank(out as Finding[], 12) as Sourced[];
  const criticals = ranked.filter((f) => f.severity === 'critical').length;

  return (
    <Page
      title="Signals"
      subtitle={`Read across every module · ${range.label}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Signals raised" value={num(ranked.length)} sub="across ads, catalogue and commerce" />
        <Stat label="Needing action" value={num(criticals)} sub="crossed a critical threshold" />
        <Stat
          label="Spend reviewed"
          value={totalSpend ? lakh(totalSpend) : '–'}
          sub={`${num(spent.length)} campaign-days`}
        />
        <Stat
          label="Modules read"
          value={num([days, snap, pmap, rep, pay].filter(Boolean).length)}
          sub={`of 5 sources${[days, snap, pmap, rep, pay].some((x) => !x) ? ' — some unavailable' : ''}`}
        />
      </Grid>

      <Card title="Everything worth knowing right now" note="ordered by severity, each linked to where it came from">
        {ranked.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-muted">
            Nothing crossed a threshold in this window. That is a real result, not an empty page.
          </p>
        ) : (
          <ul className="space-y-3.5">
            {ranked.map((f, i) => (
              <li key={i} className="flex gap-2.5">
                <span
                  className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${
                    f.severity === 'critical' ? 'bg-bad'
                      : f.severity === 'watch' ? 'bg-warn'
                        : f.severity === 'good' ? 'bg-good' : 'bg-edge'
                  }`}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[12.5px] font-medium text-text-strong">{f.headline}</span>
                    <Link href={f.href} className="text-[10.5px] text-muted underline-offset-2 hover:text-gold hover:underline">
                      {f.module} →
                    </Link>
                  </div>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{f.detail}</p>
                  {f.action && <p className="mt-1 text-[11.5px] leading-relaxed text-text">→ {f.action}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Note>
        Signals are computed from the same figures the modules show — thresholds, trends,
        concentration and Wilson intervals — not written by a language model. There is no LLM key
        on this project, and a fabricated narrative over real money would be worse than none. Every
        line links to the module that produced it so the number can be checked.
      </Note>
    </Page>
  );
}
