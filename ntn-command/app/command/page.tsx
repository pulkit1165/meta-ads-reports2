import Link from 'next/link';
import { todayRead, delta, pctOf as pctSafe } from '@/lib/today';
import { ydayFinal, totalRow as ydayTotal } from '@/lib/yday';
import { dailyClosing, shareOf } from '@/lib/closingdaily';
import { campDays, productMap, roasOf, share, PORTAL_NAME, type CampDay } from '@/lib/ads';
import { resolveRange, resolveScope, weekday, isWeekend, dayLabel, type SearchParams } from '@/lib/range';
import { wilson, pctOf } from '@/lib/insights';
import { Meter } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Delta, Note, rs, lakh, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Every daily report on one page, in the order they get read.
 *
 * This is a DIGEST, not eight modules stacked. Each section carries the figures
 * that get acted on and links to the full module for the detail, because a page
 * that reproduced all eight in full would be unreadable and slow — and the
 * modules already exist.
 *
 * One `campDays` fetch feeds the budget, block, product, allocation and
 * elimination sections. They are five cuts of the same rows, so querying five
 * times would be five times the cost for identical data.
 */
type Agg = {
  key: string; days: number; spend: number; revenue: number;
  budget: number; wins: number; camps: Set<string>;
};

const fold = (rows: CampDay[], keyOf: (r: CampDay) => string, winAt = 1) => {
  const m = new Map<string, Agg>();
  for (const r of rows) {
    if (r.spend <= 0) continue;
    const k = keyOf(r);
    const a = m.get(k) ?? { key: k, days: 0, spend: 0, revenue: 0, budget: 0, wins: 0, camps: new Set<string>() };
    a.days += 1; a.spend += r.spend; a.revenue += r.revenue; a.budget += r.budget;
    if (r.roas >= winAt) a.wins += 1;
    a.camps.add(r.campaignId);
    m.set(k, a);
  }
  return [...m.values()];
};

export default async function CommandPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 7);
  const scope = resolveScope(sp);
  const controls = <PageControls range={range} scope={scope} />;

  const [now, yday, closing, rows, pmap] = await Promise.all([
    todayRead(scope.codes).catch(() => null),
    ydayFinal(range.yesterday, scope.codes).catch(() => []),
    dailyClosing(range.from, range.today, scope.codes).catch(() => []),
    campDays(range.from, range.to, scope.codes),
    productMap(),
  ]);

  const yTot = yday.length ? ydayTotal(yday) : null;
  const spent = rows.reduce((s, r) => s + r.spend, 0);
  const earned = rows.reduce((s, r) => s + r.revenue, 0);

  /* ── 4. budget and return, day by day ─────────────────────────────────── */
  const byDay = fold(rows, (r) => r.date).sort((a, b) => b.key.localeCompare(a.key));

  /* ── 6/7/8. blocks, products, allocation — same rows, three cuts ──────── */
  const MIN_DAYS = 6;
  const rank = (list: Agg[]) => list
    .filter((a) => a.days >= MIN_DAYS)
    .map((a) => ({ ...a, sr: (a.wins / a.days) * 100, lo: wilson(a.wins, a.days).lo * 100, roas: roasOf(a.revenue, a.spend) }))
    .sort((x, y) => y.lo - x.lo);

  const blocks = rank(fold(rows, (r) => r.saleBlock));
  const products = rank(fold(rows, (r) => pmap.get(r.campaignId) ?? 'unmapped'));
  const alloc = fold(rows, (r) => pmap.get(r.campaignId) ?? 'unmapped')
    .sort((a, b) => b.spend - a.spend);

  /* ── 5. elimination: tried enough, still failing ──────────────────────── */
  const elimination = [...blocks.map((b) => ({ ...b, kind: 'block' as const })),
                       ...products.map((p) => ({ ...p, kind: 'product' as const }))]
    .filter((a) => a.days >= 10 && a.roas < 0.9 && a.sr < 30)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 12);

  const srCols = (head: string): Col<ReturnType<typeof rank>[number]>[] => [
    { key: 'k', head, align: 'l', render: (a) => (
        <span className="block max-w-[280px] truncate" title={a.key}>{a.key}</span>
      ) },
    { key: 'd', head: 'Camp-days', align: 'r', render: (a) => num(a.days) },
    { key: 'w', head: 'Hit 1.0+', align: 'r', render: (a) => num(a.wins) },
    { key: 'sr', head: 'Success rate', align: 'r', render: (a) => (
        <Meter value={a.sr} tone={a.sr >= 40 ? 'good' : a.sr < 20 ? 'warn' : 'neutral'} />
      ) },
    { key: 'lo', head: 'Worst case', align: 'r', render: (a) => (
        <span className="text-muted" title="Wilson lower bound — a small sample cannot top the list on luck">
          {pct(a.lo)}
        </span>
      ) },
    { key: 's', head: 'Spend', align: 'r', render: (a) => rs(a.spend) },
    { key: 'r', head: 'ROAS', align: 'r', render: (a) => <Roas v={a.roas} /> },
  ];

  const more = (href: string, label: string) => (
    <Link href={href} className="text-[11px] text-muted underline decoration-edge decoration-dotted underline-offset-4 transition hover:text-gold">
      {label} →
    </Link>
  );

  return (
    <Page
      title="Command"
      subtitle={`everything on one page · ${range.label.toLowerCase()} · ${scope.label}`}
      actions={controls}
    >
      {/* 1 ─ today */}
      {now && now.sites.length > 0 && (
        <Card
          title={`1 · Today's ROAS — live at ${now.cutIST} IST`}
          note="against the same clock time yesterday, so a part-finished day is not held against a finished one"
        >
          <Table
            cols={[
              { key: 'w', head: 'Website', align: 'l', render: (s) => s.name },
              { key: 's', head: 'Sales', align: 'r', render: (s) => (
                  <span className="whitespace-nowrap">{rs(s.sales)} <Delta v={delta(s.sales, s.ySales)} /></span>) },
              { key: 'o', head: 'Orders', align: 'r', render: (s) => num(s.orders) },
              { key: 'sp', head: 'Spend', align: 'r', render: (s) => rs(s.spend) },
              { key: 'r', head: 'ROAS', align: 'r', render: (s) => (
                  <span className="whitespace-nowrap"><Roas v={s.roas} /> <Delta v={delta(s.roas, s.yRoas)} /></span>) },
              { key: 'yf', head: 'Yday final', align: 'r', render: (s) => (
                  <span className="tabular-nums text-muted">{s.ydayFinal.toFixed(2)}</span>) },
              { key: 'bl', head: 'Budget live', align: 'r', render: (s) => rs(s.budgetLive) },
              { key: 'cp', head: 'Closed %', align: 'r', render: (s) => (
                  <span className={pctSafe(s.closedBudget, s.allocated) >= 60 ? 'text-warn' : ''}>
                    {pct(pctSafe(s.closedBudget, s.allocated))}</span>) },
            ]}
            rows={now.sites}
          />
          <div className="mt-3">{more('/today', 'the full live read, with the hourly table')}</div>
        </Card>
      )}

      {/* 2 ─ yesterday */}
      {yTot && (
        <Card title={`2 · Yesterday's sales — ${range.yesterday}`} note="the day as it finally settled">
          <Grid cols={4}>
            <Stat label="Sales" value={lakh(yTot.sales)} sub={`${num(yTot.orders)} orders`} />
            <Stat label="Spend" value={lakh(yTot.spend)} sub={`of ${lakh(yTot.budget)} allocated`} />
            <Stat label="ROAS" value={roasOf(yTot.sales, yTot.spend).toFixed(2)} sub="shop revenue over ad spend" />
            <Stat label="Closed" value={lakh(yTot.closed)}
                  sub={`${pct(share(yTot.closed, yTot.budget))} of the book`} />
          </Grid>
          <div className="mt-3">{more('/brief', "yesterday product by product")}</div>
        </Card>
      )}

      {/* 3 ─ closing, day by day */}
      {closing.length > 0 && (
        <Card title="3 · Closing, day by day" note="how much of each day's book was switched off">
          <Table
            cols={[
              { key: 'wd', head: 'Day', align: 'l', render: (c) => (
                  <span className={isWeekend(c.date) ? 'text-muted/70' : 'text-muted'}>{weekday(c.date)}</span>) },
              { key: 'd', head: 'Date', align: 'l', render: (c) => dayLabel(c.date) },
              { key: 'a', head: 'Allocated', align: 'r', render: (c) => rs(c.allocated) },
              { key: 'sp', head: 'Spent', align: 'r', render: (c) => rs(c.spend) },
              { key: 'cb', head: 'Closed', align: 'r', render: (c) => rs(c.closed) },
              { key: 'cp', head: 'Closed %', align: 'r', render: (c) => (
                  <Meter value={shareOf(c.closed, c.allocated)}
                         tone={shareOf(c.closed, c.allocated) >= 70 ? 'warn' : 'neutral'} />) },
              { key: 't', head: 'By 10:00', align: 'r', render: (c) => (
                  <span className="text-muted">{pct(shareOf(c.closedByTen, c.allocated))}</span>) },
              { key: 'r', head: 'ROAS at close', align: 'r', render: (c) =>
                  c.closedSpend > 0 ? <Roas v={roasOf(c.closedRevenue, c.closedSpend)} /> : <span className="text-muted">–</span> },
              { key: 'dr', head: 'Day ROAS', align: 'r', render: (c) => <Roas v={roasOf(c.revenue, c.spend)} /> },
            ]}
            rows={[...closing].reverse()}
          />
          <div className="mt-3">{more('/closing-daily', 'bot vs manual, push or minus, 25 days')}</div>
        </Card>
      )}

      {/* 4 ─ budget by day */}
      <Card title="4 · Budget and return, day by day" note="what was on the table each day and what it earned">
        <Table
          cols={[
            { key: 'wd', head: 'Day', align: 'l', render: (a: Agg) => (
                <span className={isWeekend(a.key) ? 'text-muted/70' : 'text-muted'}>{weekday(a.key)}</span>) },
            { key: 'd', head: 'Date', align: 'l', render: (a: Agg) => dayLabel(a.key) },
            { key: 'c', head: 'Camps', align: 'r', render: (a: Agg) => num(a.camps.size) },
            { key: 'b', head: 'Budget', align: 'r', render: (a: Agg) => rs(a.budget) },
            { key: 's', head: 'Spend', align: 'r', render: (a: Agg) => rs(a.spend) },
            { key: 'u', head: 'Used', align: 'r', render: (a: Agg) => <Meter value={pctOf(a.spend, a.budget)} max={120} /> },
            { key: 'w', head: 'Hit 1.0+', align: 'r', render: (a: Agg) => (
                <span className="text-muted">{pct(pctOf(a.wins, a.days))}</span>) },
            { key: 'r', head: 'ROAS', align: 'r', render: (a: Agg) => <Roas v={roasOf(a.revenue, a.spend)} /> },
          ]}
          rows={byDay}
        />
        <div className="mt-3">{more('/budget', 'ROAS buckets and where the budget sits')}</div>
      </Card>

      {/* 5 ─ elimination */}
      <Card
        title="5 · Elimination — stop launching these"
        note={`${MIN_DAYS}+ campaign-days is the bar for an opinion; these have 10+, under 0.90 return and under 30% hitting 1.0`}
      >
        {elimination.length ? (
          <Table
            cols={[
              { key: 'k', head: 'Shape', align: 'l', render: (e) => (
                  <span className="block max-w-[300px] truncate" title={e.key}>{e.key}</span>) },
              { key: 't', head: 'Kind', align: 'l', render: (e) => (
                  <span className="text-muted">{e.kind}</span>) },
              { key: 'd', head: 'Camp-days', align: 'r', render: (e) => num(e.days) },
              { key: 'c', head: 'Campaigns', align: 'r', render: (e) => num(e.camps.size) },
              { key: 'sr', head: 'Hit 1.0+', align: 'r', render: (e) => (
                  <span className="text-bad">{pct(e.sr)}</span>) },
              { key: 's', head: 'Spend', align: 'r', render: (e) => rs(e.spend) },
              { key: 'r', head: 'ROAS', align: 'r', render: (e) => <Roas v={e.roas} /> },
            ]}
            rows={elimination}
          />
        ) : (
          <p className="py-4 text-center text-[12px] text-muted">
            Nothing meets the elimination bar over {range.label.toLowerCase()} — no shape has been
            tried 10+ times and stayed under 0.90.
          </p>
        )}
      </Card>

      {/* 6 ─ sales blocks */}
      <Card title="6 · Sales block success rate" note={`ranked on the worst case, so a lucky small sample cannot top it · ${MIN_DAYS}+ campaign-days`}>
        <Table cols={srCols('Sales block')} rows={blocks.slice(0, 15)} />
        <div className="mt-3">{more('/blocks', 'every block, with closure and comparison')}</div>
      </Card>

      {/* 7 ─ products */}
      <Card title="7 · Product success rate" note="same ranking, by product">
        <Table cols={srCols('Product')} rows={products.slice(0, 15)} />
        <div className="mt-3">{more('/products', 'spend, return and reorder rate per product')}</div>
      </Card>

      {/* 8 ─ allocation */}
      <Card title="8 · Product-wise budget allocation" note="where the money actually went over the window">
        <Table
          cols={[
            { key: 'k', head: 'Product', align: 'l', render: (a: Agg) => (
                <span className="block max-w-[260px] truncate" title={a.key}>{a.key}</span>) },
            { key: 'c', head: 'Campaigns', align: 'r', render: (a: Agg) => num(a.camps.size) },
            { key: 'b', head: 'Budget', align: 'r', render: (a: Agg) => rs(a.budget) },
            { key: 's', head: 'Spend', align: 'r', render: (a: Agg) => rs(a.spend) },
            { key: 'sh', head: 'Share of spend', align: 'r', render: (a: Agg) => (
                <Meter value={pctOf(a.spend, spent)} max={Math.max(20, pctOf(alloc[0]?.spend ?? 0, spent))} />) },
            { key: 'u', head: 'Used', align: 'r', render: (a: Agg) => (
                <span className="text-muted">{pct(pctOf(a.spend, a.budget))}</span>) },
            { key: 'r', head: 'ROAS', align: 'r', render: (a: Agg) => <Roas v={roasOf(a.revenue, a.spend)} /> },
          ]}
          rows={alloc.slice(0, 20)}
        />
        <div className="mt-3">{more('/allocation', 'the workbook format, with tomorrow’s gaps')}</div>
      </Card>

      <Note>
        <b className="text-text-strong">One page, eight reads, in the order you take them.</b> Each
        section carries what gets acted on and links to its full module for the detail — the modules
        are unchanged and still the place to go deeper.
        {' '}Sections 4 to 8 are five cuts of a single fetch of the window&apos;s campaign-days, which
        is why the page loads once rather than five times.
        {' '}<b className="text-text-strong">Success rate</b> is the share of campaign-days that
        cleared 1.0, and the ranking uses the <b className="text-text-strong">worst case</b> rather
        than the rate itself, so three lucky days cannot outrank thirty steady ones. Anything under{' '}
        {MIN_DAYS} campaign-days is left out entirely rather than shown as a number that cannot
        support a decision.
        {' '}<b className="text-text-strong">Elimination</b> is computed here, not read from the
        sheet: 10+ campaign-days, under 0.90 return, under 30% clearing 1.0. It is a shortlist to
        argue with, not a verdict.
      </Note>
    </Page>
  );
}
