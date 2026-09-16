import Link from 'next/link';
import {
  closingOn, closingHistory, closingCompare, compareStates, groupStates, familyOf,
  roasOf, share, ageBand, AGE_BANDS, creativeTags,
  PORTAL_NAME, PORTALS, bandOf, type CmpAgg, type AgedState,
} from '@/lib/ads';
import {
  resolveRange, resolveScope, weekday, isWeekend, dayLabel as dayLabelOf, type SearchParams,
} from '@/lib/range';
import { rank, pctOf, money, concentration, type Finding } from '@/lib/insights';
import {
  closingBook, byDate as bookByDate, byAge as bookByAge,
  total as bookTotal, pctOfSafe, type BookAgg,
} from '@/lib/closingbook';
import { ROAS_BANDS, BarList, ShareBar, Line, Meter, BandBar } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Row = {
  key: string; camps: number; budget: number; closed: number;
  closedCamps: number; closedSpend: number; closedRevenue: number;
};

export default async function ClosingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  // 0 = today: this page reports the live state of the book, not a settled day.
  const range = resolveRange(sp, 0);
  const scope = resolveScope(sp);
  // Closing is a state, not a window: it reads one day's snapshot. The picker
  // chooses which day, and `to` is the end of whatever window was selected.
  const day = range.to;
  // 30 days of history regardless of the chosen day, so the trend is readable
  // even when the picker is on a single day.
  const HIST = 30;
  const histFrom = new Date(Date.parse(day) - (HIST - 1) * 86400000).toISOString().slice(0, 10);
  // The day before the one on screen, read at the same clock time — see
  // closingCompare for why the hour matters so much on a live day.
  const prev = new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
  // Seven days ending on the chosen day: enough to see a pattern, short
  // enough that every row still gets read.
  const BOOK = 7;
  const bookFrom = new Date(Date.parse(day) - (BOOK - 1) * 86400000).toISOString().slice(0, 10);
  const [snap, history, cmp, book] = await Promise.all([
    closingOn(day, scope.codes),
    closingHistory(histFrom, day, scope.codes).catch(() => []),
    closingCompare(day, prev, scope.codes).catch(() => null),
    closingBook(bookFrom, day, scope.codes).catch(() => []),
  ]);
  const bookDates = bookByDate(book);
  const bookAges = bookByAge(book);
  const bookAll = bookTotal(bookDates);
  const rows = snap.rows;

  const controls = <PageControls range={range} scope={scope} />;

  if (!rows.length) {
    return (
      <Page title="Closing Desk" subtitle={`No snapshot for ${day}`} actions={controls}>
        <Note kind="warn">
          No rows in <span className="text-warn">meta_campaign_snapshot</span> for {day}. The EC2
          pipeline writes it every ten minutes, so an empty day past 01:00 IST means the pipeline
          is stuck rather than that nothing ran.
        </Note>
      </Page>
    );
  }

  const alloc = rows.reduce((s, r) => s + r.budget, 0);
  const closedRows = rows.filter((r) => r.closed);
  const closedBudget = closedRows.reduce((s, r) => s + r.budget, 0);
  const closedSpend = closedRows.reduce((s, r) => s + r.spend, 0);
  const closedRev = closedRows.reduce((s, r) => s + r.revenue, 0);
  const liveRows = rows.filter((r) => !r.closed);
  const liveSpend = liveRows.reduce((s, r) => s + r.spend, 0);
  const liveRev = liveRows.reduce((s, r) => s + r.revenue, 0);

  const byFamily = groupStates(rows, (r) => familyOf(r.saleBlock));
  const byPortal = groupStates(rows, (r) => r.portal);
  const byBlock = groupStates(rows, (r) => r.saleBlock).filter((a) => a.budget >= 20000);

  const bandTotals = new Map<string, number>();
  for (const r of closedRows) {
    const k = bandOf(roasOf(r.revenue, r.spend));
    bandTotals.set(k, (bandTotals.get(k) ?? 0) + r.spend);
  }
  // The ladder only closes below 0.75. Anything cut above that came from a
  // different rule, and that is worth knowing about.
  const aboveLadder = ['b5', 'b6', 'b7'].reduce((s, b) => s + (bandTotals.get(b) ?? 0), 0);

  /* ── the same book yesterday, at the same hour ────────────────────────── */
  // A campaign using two creative styles is counted under both: the question is
  // which styles are being cut, not which exact combination. Read the share
  // column, not the total — the rupee column deliberately does not sum.
  const tagged = (rows: AgedState[]) =>
    rows.flatMap((r) => creativeTags(r.creativeType).map((t) => ({ ...r, tag: t })));

  const all = cmp ? compareStates(cmp.now, cmp.was, () => 'ALL')[0] : null;
  const byAge = cmp
    ? compareStates(cmp.now, cmp.was, (r) => ageBand(r.dayNo))
        .sort((a, b) => AGE_BANDS.indexOf(a.key as (typeof AGE_BANDS)[number])
                      - AGE_BANDS.indexOf(b.key as (typeof AGE_BANDS)[number]))
    : [];
  const cmpPortal = cmp ? compareStates(cmp.now, cmp.was, (r) => r.portal) : [];
  const cmpType = cmp
    ? compareStates(tagged(cmp.now), tagged(cmp.was), (r) => r.tag)
        .filter((c) => c.now.budget + c.was.budget >= 20000)
    : [];
  const cmpBlock = cmp
    ? compareStates(cmp.now, cmp.was, (r) => r.saleBlock)
        .filter((c) => Math.abs(c.dClosed) >= 5000).slice(0, 12)
    : [];

  const chg = (now: number, was: number) => (was > 0 ? ((now - was) / was) * 100 : 0);
  const prevLabel = prev.slice(8) + '/' + prev.slice(5, 7);

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const closedPct = pctOf(closedBudget, alloc);

  if (all && all.was.budget > 0) {
    const harder = all.dPoints > 0;
    const worst = [...byAge].sort((a, b) => b.dPoints - a.dPoints)[0];
    findings.push({
      severity: Math.abs(all.dPoints) >= 10 ? 'watch' : 'neutral',
      headline: harder
        ? `Closing ${Math.abs(all.dPoints).toFixed(0)} points harder than ${cmp!.prev} at this hour`
        : Math.abs(all.dPoints) < 1
          ? `Closing at the same rate as ${cmp!.prev}`
          : `Closing ${Math.abs(all.dPoints).toFixed(0)} points lighter than ${cmp!.prev} at this hour`,
      detail: `${money(all.now.closed)} off against ${money(all.was.closed)} — ${all.now.closedCamps} campaigns cut against ${all.was.closedCamps}, on a book of ${money(all.now.budget)} against ${money(all.was.budget)}.`
        + (worst && worst.dPoints > 5
            ? ` The move is concentrated in ${worst.key}: ${pct(share(worst.now.closed, worst.now.budget))} closed against ${pct(share(worst.was.closed, worst.was.budget))}.`
            : ''),
      action: harder && all.dPoints >= 10
        ? 'Both sides are read at the same clock time, so this is a real change in the book rather than the day being younger. Check whether what launched today is worse, or the ladder is simply reaching more of it.'
        : undefined,
    });
  }

  if (closedPct >= 55) {
    findings.push({
      severity: closedPct >= 70 ? 'critical' : 'watch',
      headline: `${closedPct.toFixed(0)}% of today's book is already switched off`,
      detail: `${money(closedBudget)} of ${money(alloc)} closed across ${closedRows.length} campaigns, at ${roasOf(closedRev, closedSpend).toFixed(2)} ROAS. What still runs is at ${roasOf(liveRev, liveSpend).toFixed(2)}.`,
      action: closedPct >= 70
        ? 'At this rate the day ends on a small live book. Check whether new launches are replacing what the ladder is cutting.'
        : undefined,
    });
  }

  const heavy = byFamily.filter((f) => f.budget >= 50000 && pctOf(f.closed, f.budget) >= 60);
  for (const f of heavy.slice(0, 2)) {
    findings.push({
      severity: 'watch',
      headline: `${f.key} is being cut hardest`,
      detail: `${pctOf(f.closed, f.budget).toFixed(0)}% of its ${money(f.budget)} is off — ${f.closedCamps} of ${f.camps} campaigns — after spending ${money(f.closedSpend)} at ${roasOf(f.closedRevenue, f.closedSpend).toFixed(2)}.`,
      action: 'If this repeats daily, the gate is catching a structural problem rather than a bad day. Worth reviewing the targeting rather than the ladder.',
    });
  }

  const wiped = byBlock.filter((b) => b.budget >= 40000 && pctOf(b.closed, b.budget) >= 99);
  if (wiped.length) {
    findings.push({
      severity: 'critical',
      headline: `${wiped.length} block${wiped.length > 1 ? 's are' : ' is'} fully eliminated`,
      detail: wiped.slice(0, 3).map((b) => `${b.key.slice(0, 44)} (${money(b.budget)}, ${b.closedCamps}/${b.camps} camps)`).join('; ') + '.',
      action: 'Every campaign in these blocks died today. That is an audience verdict, not a campaign one — stop relaunching into them until something changes.',
    });
  }

  if (aboveLadder > 0) {
    findings.push({
      severity: 'watch',
      headline: `${money(aboveLadder)} was closed above the ladder's ceiling`,
      detail: 'The day-1–3 ladder stops at 0.75 ROAS, so spend closed in the 1.0+ bands was cut by something else — a manual pause, or the GitHub Actions closer still running the old 40%-of-budget rule.',
      action: 'Worth confirming these were deliberate. The GHA closer operates outside the ladder entirely.',
    });
  }

  const conc = concentration(byBlock, (b) => b.budget);
  if (conc.top && conc.topShare >= 25) {
    findings.push({
      severity: 'neutral',
      headline: `One block holds ${conc.topShare.toFixed(0)}% of the allocated budget`,
      detail: `${conc.top.key.slice(0, 60)} — ${money(conc.top.budget)}. Concentration is only a risk if it stops returning; today it is at ${roasOf(conc.top.revenue, conc.top.spend).toFixed(2)}.`,
    });
  }

  if (snap.dormantBudget > alloc * 0.3) {
    findings.push({
      severity: 'neutral',
      headline: `${money(snap.dormantBudget)} of budget never went live today`,
      detail: `${snap.dormantCount} campaigns hold budget on paper but were already off at midnight. They are excluded from every figure here — counting them would drag the closed share down by about a third for no real reason.`,
    });
  }

  /* ── table ────────────────────────────────────────────────────────────── */
  const cols: Col<Row>[] = [
    { key: 'k', head: 'Sale block', align: 'l', render: (r) => (
        <span className="block max-w-[340px] truncate" title={r.key}>{r.key}</span>
      ) },
    { key: 'c', head: 'Camps', align: 'r', render: (r) => num(r.camps) },
    { key: 'a', head: 'Allocated', align: 'r', render: (r) => rs(r.budget) },
    { key: 'x', head: 'Closed', align: 'r', render: (r) => rs(r.closed) },
    { key: 'p', head: 'Closed %', align: 'r', render: (r) => (
        <span className={share(r.closed, r.budget) >= 75 ? 'text-warn' : ''}>
          {pct(share(r.closed, r.budget))}
        </span>
      ) },
    { key: 'n', head: 'Camps cut', align: 'r', render: (r) => num(r.closedCamps) },
    { key: 's', head: 'Spent before cut', align: 'r', render: (r) => rs(r.closedSpend) },
    { key: 'r', head: 'ROAS at cut', align: 'r', render: (r) =>
        r.closedSpend > 0
          ? <Roas v={roasOf(r.closedRevenue, r.closedSpend)} />
          : <span className="text-muted">–</span> },
  ];

  const dayLabel = day.slice(8) + '/' + day.slice(5, 7);

  /* ── the seven-day book, read two ways ──────────────────────────────────
     Allocated counts only campaigns that went live. Used is spend against the
     whole cohort's allocation; burn is the closed campaigns' spend against
     only their own budget — the honest measure of how much was already gone
     when the decision got made. A cohort can be lightly used and heavily
     burnt at the same time, which is why both columns are here. */
  const bookCols = (head: string, first: (b: BookAgg) => React.ReactNode): Col<BookAgg>[] => [
    { key: 'k', head, align: 'l', render: first },
    { key: 'c', head: 'Camps', align: 'r', render: (b) => num(b.camps) },
    { key: 'a', head: 'Allocated', align: 'r', render: (b) => rs(b.allocated) },
    { key: 's', head: 'Spent', align: 'r', render: (b) => rs(b.spend) },
    { key: 'u', head: 'Used', align: 'r', render: (b) => (
        <Meter value={pctOfSafe(b.spend, b.allocated)} max={120} />
      ) },
    { key: 'n', head: 'Closed', align: 'r', render: (b) => num(b.closedCamps) },
    { key: 'cb', head: 'Budget closed', align: 'r', render: (b) => rs(b.closedBudget) },
    { key: 'cp', head: 'Closed', align: 'r', render: (b) => (
        <Meter value={pctOfSafe(b.closedBudget, b.allocated)} tone={pctOfSafe(b.closedBudget, b.allocated) >= 70 ? 'warn' : 'neutral'} />
      ) },
    { key: 'cs', head: 'Spent by them', align: 'r', render: (b) => rs(b.closedSpend) },
    { key: 'bn', head: 'Burn', align: 'r', render: (b) => (
        <Meter value={pctOfSafe(b.closedSpend, b.closedBudget)} max={120}
               tone={pctOfSafe(b.closedSpend, b.closedBudget) >= 60 ? 'warn' : 'neutral'} />
      ) },
    { key: 'd', head: 'How they ended', align: 'l', render: (b) => (
        <BandBar bands={b.bands} survived={b.survived} />
      ) },
    { key: 'r', head: 'ROAS at close', align: 'r', render: (b) =>
        b.closedSpend > 0 ? <Roas v={roasOf(b.closedRevenue, b.closedSpend)} /> : <span className="text-muted">–</span> },
    { key: 'dr', head: 'Cohort ROAS', align: 'r', render: (b) =>
        b.spend > 0 ? <Roas v={roasOf(b.revenue, b.spend)} /> : <span className="text-muted">–</span> },
  ];

  /** Clicking a date moves the whole Desk onto that day. */
  const dateHref = (d: string) => {
    const qs = new URLSearchParams();
    qs.set('from', d); qs.set('to', d);
    if (scope.key !== 'all') qs.set('site', scope.key);
    return `/closing?${qs.toString()}`;
  };


  /** One comparison table shape, reused for every cut of the same data. */
  const cmpCols = (head: string, wide = false): Col<CmpAgg>[] => [
    { key: 'k', head, align: 'l', render: (c) => (
        <span className={wide ? 'block max-w-[300px] truncate' : ''} title={c.key}>
          {PORTAL_NAME[c.key] ?? c.key}
        </span>
      ) },
    { key: 'a', head: 'Allocated', align: 'r', render: (c) => rs(c.now.budget) },
    { key: 'cy', head: `Closed ${prevLabel}`, align: 'r', render: (c) => (
        <span className="text-muted">{rs(c.was.closed)}</span>
      ) },
    { key: 'ct', head: `Closed ${dayLabel}`, align: 'r', render: (c) => rs(c.now.closed) },
    { key: 'd', head: 'Change', align: 'r', render: (c) => (
        <span className={Math.abs(c.dClosed) < 1 ? 'text-muted' : c.dClosed > 0 ? 'text-warn' : 'text-good'}>
          {c.dClosed > 0 ? '+' : c.dClosed < 0 ? '−' : ''}{rs(Math.abs(c.dClosed))}
        </span>
      ) },
    { key: 'py', head: `% ${prevLabel}`, align: 'r', render: (c) => (
        <span className="text-muted">{pct(share(c.was.closed, c.was.budget))}</span>
      ) },
    { key: 'pt', head: `% ${dayLabel}`, align: 'r', render: (c) => (
        <span className={share(c.now.closed, c.now.budget) >= 75 ? 'text-warn' : ''}>
          {pct(share(c.now.closed, c.now.budget))}
        </span>
      ) },
    { key: 'dp', head: 'Points', align: 'r', render: (c) => (
        <span className={Math.abs(c.dPoints) < 0.5 ? 'text-muted' : c.dPoints > 0 ? 'text-warn' : 'text-good'}>
          {c.dPoints > 0 ? '+' : c.dPoints < 0 ? '−' : ''}{Math.abs(c.dPoints).toFixed(1)}pp
        </span>
      ) },
    { key: 'n', head: 'Camps cut', align: 'r', render: (c) => (
        <span className="tabular-nums">
          <span className="text-muted">{num(c.was.closedCamps)}</span>
          <span className="text-muted/60"> → </span>
          {num(c.now.closedCamps)}
        </span>
      ) },
    { key: 'r', head: 'ROAS at cut', align: 'r', render: (c) =>
        c.now.closedSpend > 0
          ? <Roas v={roasOf(c.now.closedRevenue, c.now.closedSpend)} />
          : <span className="text-muted">–</span> },
  ];

  const total: Row = {
    key: 'TOTAL', camps: rows.length, budget: alloc, closed: closedBudget,
    closedCamps: closedRows.length, closedSpend, closedRevenue: closedRev,
  };

  return (
    <Page
      title="Closing Desk"
      subtitle={`${day} · snapshot at ${snap.cutIST} IST · ${scope.label}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat
          label="Allocated"
          value={lakh(alloc)}
          sub={`${rows.length} campaigns that ran`}
          delta={all ? chg(all.now.budget, all.was.budget) : null}
          tone="flat"
        />
        <Stat
          label="Closed"
          value={lakh(closedBudget)}
          sub={`${closedRows.length} campaigns switched off${all ? ` · ${all.was.closedCamps} by this hour ${prevLabel}` : ''}`}
          delta={all ? chg(all.now.closed, all.was.closed) : null}
          tone="flat"
        />
        <Stat
          label="Closed share"
          value={pct(closedPct)}
          sub={all ? `${pct(share(all.was.closed, all.was.budget))} ${prevLabel} at ${cmp!.prevCutIST}` : 'of the book that actually ran'}
          delta={all ? all.dPoints : null}
          tone="flat"
          unit="pp"
        />
        <Stat
          label="Spent before the cut"
          value={lakh(closedSpend)}
          sub={`at ${roasOf(closedRev, closedSpend).toFixed(2)} ROAS · still-live is at ${roasOf(liveRev, liveSpend).toFixed(2)}`}
          delta={all ? chg(all.now.closedSpend, all.was.closedSpend) : null}
          tone="flat"
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${day}, ${rows.length} campaigns`} />

      {cmp && all && all.was.budget > 0 && (
        <>
          <Card
            title={`Which day window is being cut`}
            note={`${dayLabel} at ${cmp.cutIST} against ${prevLabel} at ${cmp.prevCutIST} — the same point in the day, so a half-finished day is not being held against a finished one. Age counts from the first day a campaign spent.`}
          >
            <Table
              cols={cmpCols('Day window')}
              rows={byAge}
              footer={{ ...all, key: 'TOTAL' }}
            />
          </Card>

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <Card title="By portal" note="same two moments, split by store">
              <Table cols={cmpCols('Portal')} rows={cmpPortal} />
            </Card>
            <Card
              title="By creative style"
              note="a campaign using two styles counts under both, so the rupee column does not sum — read the share"
            >
              <Table cols={cmpCols('Style')} rows={cmpType} empty="No style carries Rs 20,000 across the two days." />
            </Card>
          </div>

          <Card
            title="Blocks where closing moved most"
            note="change of at least Rs 5,000 in budget switched off, largest move first"
          >
            <Table
              cols={cmpCols('Sale block', true)}
              rows={cmpBlock}
              empty="No block moved by Rs 5,000 either way."
            />
          </Card>
        </>
      )}

      <Card title="Where the closed money was" note="closed spend by the ROAS band each campaign was in when cut">
        <ShareBar
          fmt={rs}
          parts={ROAS_BANDS.map((b) => ({
            label: b.label, color: b.color, value: bandTotals.get(b.key) ?? 0,
          })).filter((p) => p.value > 0)}
        />
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="By audience family" note="share of each family's budget that is off">
          <BarList
            fmt={(v) => pct(v)} max={100}
            rows={byFamily.map((f) => ({
              label: f.key,
              value: share(f.closed, f.budget),
              sub: `${rs(f.closed)} of ${rs(f.budget)}`,
              color: share(f.closed, f.budget) >= 60 ? '#eb6834' : '#2a78d6',
            }))}
          />
        </Card>
        <Card title="By portal" note="share of each portal's budget that is off">
          <BarList
            fmt={(v) => pct(v)} max={100}
            rows={byPortal.map((p) => ({
              label: PORTAL_NAME[p.key] ?? p.key,
              value: share(p.closed, p.budget),
              sub: `${rs(p.closed)} of ${rs(p.budget)}`,
              color: share(p.closed, p.budget) >= 60 ? '#eb6834' : '#2a78d6',
            }))}
          />
        </Card>
      </div>

      {history.length > 1 && (
        <>
          <Card title="Closed share, day by day" note={`last ${history.length} days · % of that day's allocated budget switched off`}>
            <Line
              fmt={(v) => `${v.toFixed(0)}%`}
              categories={history.map((h) => h.date.slice(8) + '/' + h.date.slice(5, 7))}
              series={[{
                label: 'Closed % of allocated',
                color: '#eb6834',
                values: history.map((h) => (h.allocated > 0 ? (h.closed / h.allocated) * 100 : null)),
              }]}
              baseline={{
                value: history.reduce((a, h) => a + (h.allocated > 0 ? (h.closed / h.allocated) * 100 : 0), 0) / history.length,
                label: 'average',
              }}
            />
          </Card>

          <Card title="Every day" note="allocated counts only campaigns that were active at some point that day">
            <Table
              cols={[
                { key: 'wd', head: 'Day', align: 'l', render: (h: (typeof history)[number]) => (
        <span className={isWeekend(h.date) ? 'text-muted/70' : 'text-muted'}>{weekday(h.date)}</span>
      ) },
    { key: 'd', head: 'Date', align: 'l', render: (h: (typeof history)[number]) => (
                    <span className={h.date === day ? 'text-gold' : ''}>
                      {h.date.slice(8) + '/' + h.date.slice(5, 7)}
                    </span>
                  ) },
                { key: 'c', head: 'Camps', align: 'r', render: (h: (typeof history)[number]) => num(h.camps) },
                { key: 'a', head: 'Allocated', align: 'r', render: (h: (typeof history)[number]) => rs(h.allocated) },
                { key: 'x', head: 'Closed', align: 'r', render: (h: (typeof history)[number]) => rs(h.closed) },
                { key: 'p', head: 'Closed %', align: 'r', render: (h: (typeof history)[number]) => (
                    <span className={share(h.closed, h.allocated) >= 60 ? 'text-warn' : ''}>
                      {pct(share(h.closed, h.allocated))}
                    </span>
                  ) },
                { key: 'n', head: 'Camps cut', align: 'r', render: (h: (typeof history)[number]) => num(h.closedCamps) },
                { key: 's', head: 'Spend', align: 'r', render: (h: (typeof history)[number]) => rs(h.spend) },
                { key: 'cs', head: 'Spent before cut', align: 'r', render: (h: (typeof history)[number]) => rs(h.closedSpend) },
                { key: 'cr', head: 'ROAS at cut', align: 'r', render: (h: (typeof history)[number]) =>
                    h.closedSpend > 0
                      ? <Roas v={roasOf(h.closedRevenue, h.closedSpend)} />
                      : <span className="text-muted">–</span> },
                { key: 'r', head: 'Day ROAS', align: 'r', render: (h: (typeof history)[number]) =>
                    <Roas v={roasOf(h.revenue, h.spend)} /> },
              ]}
              rows={[...history].reverse()}
            />
          </Card>
        </>
      )}

      {book.length > 0 && (
        <>
          <Card
            title="The week, day by day"
            note={`${bookFrom} → ${day} · click a date to move the whole desk onto it · allocated counts only campaigns that went live`}
          >
            <Table
              cols={bookCols('Day', (b) => (
                <Link
                  href={dateHref(String(b.order))}
                  className={`whitespace-nowrap underline decoration-edge decoration-dotted underline-offset-4 transition hover:text-gold hover:decoration-gold/60 ${
                    String(b.order) === day ? 'font-medium text-gold' : ''
                  }`}
                  title={`Open ${b.order} on the desk above`}
                >
                  <span className={isWeekend(String(b.order)) ? 'text-muted/70' : 'text-muted'}>
                    {weekday(String(b.order))}
                  </span>{' '}
                  {dayLabelOf(String(b.order))}
                </Link>
              ))}
              rows={bookDates}
              footer={{ ...bookAll, key: 'All 7 days', order: '' }}
            />
          </Card>

          <Card
            title="The same week, by campaign age"
            note="age counts from the first day a campaign spent · days 1-7 exactly, everything older folded together"
          >
            <Table
              cols={bookCols('Campaign age', (b) => (
                <span className={b.key === 'Day 1' ? 'font-medium text-gold' : ''}>{b.key}</span>
              ))}
              rows={bookAges}
              footer={{ ...bookAll, key: 'All ages', order: '' }}
            />
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[10.5px] text-muted">
              {ROAS_BANDS.map((b) => (
                <span key={b.key} className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: b.color }} />
                  closed at {b.label}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-edge" />
                survived the day
              </span>
            </div>
          </Card>
        </>
      )}

      <Card title="By exact sale block" note="allocated ≥ Rs 20,000">
        <Table cols={cols} rows={byBlock as Row[]} footer={total} />
      </Card>

      <Note>
        <b className="text-text-strong">Allocated</b> counts only campaigns that were ACTIVE at
        some point on {day}. A further{' '}
        <b className="text-text-strong">{snap.dormantCount} campaigns holding {lakh(snap.dormantBudget)}</b>{' '}
        never went live and are excluded. Spend shown against closed campaigns is the figure at the
        latest snapshot, so it includes any post-pause delivery.
      </Note>
    </Page>
  );
}
