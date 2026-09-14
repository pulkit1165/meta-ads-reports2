import {
  dailyClosing, shareOf, MOVE_LABEL, MAINTAIN_BAND,
  type ClosingDayRow, type Move,
} from '@/lib/closingdaily';
import { roasOf } from '@/lib/ads';
import { resolveRange, resolveScope, dayLabel, weekday, isWeekend, type SearchParams } from '@/lib/range';
import { rank, money, pctOf, type Finding } from '@/lib/insights';
import { StackedBars, Line } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, rs, pct, num, lakh, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BOT = '#2a78d6';
const MANUAL = '#eb6834';
const MORNING = '#eda100';
const LATER = '#5aa9a3';

/**
 * Push, maintain or minus — whether the book was bigger, the same or smaller
 * than the day before. "Maintain" needs a band: a book that moves by a few
 * hundred rupees has not been decided about, it has just drifted.
 */
function MoveChip({ r }: { r: ClosingDayRow }) {
  if (r.move === 'first') return <span className="text-muted">—</span>;
  const tone: Record<Move, string> = {
    push: 'bg-good/15 text-good',
    minus: 'bg-bad/15 text-bad',
    maintain: 'bg-tint text-muted',
    first: '',
  };
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wider ${tone[r.move]}`}>
        {MOVE_LABEL[r.move]}
      </span>
      {r.move !== 'maintain' && (
        <span className="tabular-nums text-[11.5px] text-muted">
          {r.delta > 0 ? '+' : '−'}{rs(Math.abs(r.delta))}
          <span className="ml-1 text-muted/70">{Math.abs(r.deltaPct).toFixed(0)}%</span>
        </span>
      )}
    </span>
  );
}

export default async function ClosingDailyPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  // 25 days by default, as asked for. The window runs to today because a
  // closing log is a record of events, not an average a partial day distorts.
  const range = resolveRange(sp, 25);
  const scope = resolveScope(sp);
  const from = range.days === 0 ? range.today : range.from;
  const to = range.today;

  const rows = await dailyClosing(from, to, scope.codes);

  const controls = <PageControls range={range} scope={scope} />;

  if (!rows.length) {
    return (
      <Page title="Daily Closing" subtitle={`${from} → ${to}`} actions={controls}>
        <Note kind="warn">
          Nothing in <span className="text-warn">camp_day_state</span> for this window. It is rebuilt
          every morning at 05:35 IST, so an empty result means that job has not run.
        </Note>
      </Page>
    );
  }

  const newest = rows[rows.length - 1];
  const recorded = rows.filter((r) => r.botRecorded);
  const sum = (f: (r: ClosingDayRow) => number, rs_ = rows) => rs_.reduce((s, r) => s + f(r), 0);

  const allocTotal = sum((r) => r.allocated);
  const closedTotal = sum((r) => r.closed);
  const byTenTotal = sum((r) => r.closedByTen);
  const botTotal = sum((r) => r.botBudget, recorded);
  const manTotal = sum((r) => r.manualBudget, recorded);
  const closedSpend = sum((r) => r.closedSpend);
  const closedRev = sum((r) => r.closedRevenue);

  const pushes = rows.filter((r) => r.move === 'push');
  const minuses = rows.filter((r) => r.move === 'minus');
  const holds = rows.filter((r) => r.move === 'maintain');

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];

  findings.push({
    severity: 'neutral',
    headline: `${pct(pctOf(byTenTotal, closedTotal))} of all closing has already happened by 10 in the morning`,
    detail: `${money(byTenTotal)} of the ${money(closedTotal)} switched off across these ${rows.length} days was gone before 10:00. The rest of the day accounts for the other ${pct(100 - pctOf(byTenTotal, closedTotal))}.`,
  });

  if (recorded.length >= 5) {
    const half = Math.floor(recorded.length / 2);
    const early = recorded.slice(0, half), late = recorded.slice(half);
    const eb = pctOf(sum((r) => r.botBudget, early), sum((r) => r.closed, early));
    const lb = pctOf(sum((r) => r.botBudget, late), sum((r) => r.closed, late));
    if (Math.abs(lb - eb) >= 12) {
      findings.push({
        severity: 'neutral',
        headline: lb > eb
          ? `The bot has taken over the closing desk — ${pct(eb)} of closed budget to ${pct(lb)}`
          : `Closing has moved back into human hands — ${pct(eb)} of closed budget to ${pct(lb)}`,
        detail: `Comparing the first ${early.length} days of the window against the last ${late.length}. The ladder went live on ${recorded[0].date}; before that everything here reads manual because the bot kept no record.`,
      });
    }
  }

  const netAlloc = newest.allocated - rows[0].allocated;
  findings.push({
    severity: Math.abs(pctOf(netAlloc, rows[0].allocated)) >= 20 ? 'watch' : 'neutral',
    headline: netAlloc < 0
      ? `The book has shrunk ${pct(Math.abs(pctOf(netAlloc, rows[0].allocated)))} over the window`
      : `The book has grown ${pct(pctOf(netAlloc, rows[0].allocated))} over the window`,
    detail: `${money(rows[0].allocated)} on ${rows[0].date} against ${money(newest.allocated)} on ${newest.date}. ${pushes.length} pushes, ${minuses.length} minuses and ${holds.length} days held within ${MAINTAIN_BAND}%.`,
    action: netAlloc < 0 && minuses.length > pushes.length
      ? 'More days cut the book than raised it. If that is not deliberate, the ladder is shrinking the business one day at a time.'
      : undefined,
  });

  const worstDay = [...rows].sort((a, b) => shareOf(b.closed, b.allocated) - shareOf(a.closed, a.allocated))[0];
  if (worstDay && shareOf(worstDay.closed, worstDay.allocated) >= 80) {
    findings.push({
      severity: 'watch',
      headline: `${dayLabel(worstDay.date)} closed ${pct(shareOf(worstDay.closed, worstDay.allocated))} of its book`,
      detail: `${money(worstDay.closed)} of ${money(worstDay.allocated)} switched off, ${worstDay.closedCamps} of ${worstDay.camps} campaigns, at ${roasOf(worstDay.closedRevenue, worstDay.closedSpend).toFixed(2)}.`,
    });
  }

  const roasAtClose = roasOf(closedRev, closedSpend);
  const dayRoas = roasOf(sum((r) => r.revenue), sum((r) => r.spend));
  findings.push({
    severity: 'neutral',
    headline: `Closed budget was earning ${roasAtClose.toFixed(2)} when it was cut, against ${dayRoas.toFixed(2)} for the book as a whole`,
    detail: `${money(closedSpend)} had already been spent by the campaigns that got switched off, returning ${money(closedRev)}.`,
    action: roasAtClose >= dayRoas * 0.85
      ? 'That gap is narrow. The protocol is cutting campaigns that were performing close to the average, which is worth a look.'
      : undefined,
  });

  /* ── table ────────────────────────────────────────────────────────────── */
  const cols: Col<ClosingDayRow>[] = [
    { key: 'wd', head: 'Day', align: 'l', render: (r) => (
        <span className={isWeekend(r.date) ? 'text-muted/70' : 'text-muted'}>{weekday(r.date)}</span>
      ) },
    { key: 'd', head: 'Date', align: 'l', render: (r) => (
        <span className={r.date === range.today ? 'text-gold' : ''}>{dayLabel(r.date)}</span>
      ) },
    { key: 'a', head: 'Allocated', align: 'r', render: (r) => rs(r.allocated) },
    { key: 'mv', head: 'Against yesterday', align: 'l', render: (r) => <MoveChip r={r} /> },
    { key: 'sp', head: 'Spend', align: 'r', render: (r) => rs(r.spend) },
    // Delivery against the allowance. Over 100% is real rather than an error —
    // Meta over-delivers, and a campaign closed mid-day keeps spending briefly
    // after the pause. Today's row is naturally low because the day is short.
    { key: 'spp', head: '% of budget spent', align: 'r', render: (r) => {
        const v = shareOf(r.spend, r.allocated);
        return (
          <span
            className={v >= 95 ? 'text-warn' : v < 40 ? 'text-muted' : ''}
            title={`${rs(r.spend)} delivered against ${rs(r.allocated)} allocated`}
          >
            {pct(v)}
          </span>
        );
      } },
    { key: 't', head: 'Closed by 10:00', align: 'r', render: (r) => (
        <span title={`${r.campsByTen} campaigns`}>{r.closedByTen ? rs(r.closedByTen) : <span className="text-muted">–</span>}</span>
      ) },
    // Both percentages share the allocated book as their denominator, so the
    // header says so — one is a part of the other, not a different measure.
    { key: 'tp', head: '% of book by 10:00', align: 'r', render: (r) => (
        <span
          className="text-muted"
          title={r.closed > 0
            ? `${pct(shareOf(r.closedByTen, r.closed))} of the day's closing had happened by 10:00`
            : 'nothing closed this day'}
        >
          {pct(shareOf(r.closedByTen, r.allocated))}
        </span>
      ) },
    { key: 'c', head: 'Closed, whole day', align: 'r', render: (r) => rs(r.closed) },
    { key: 'cp', head: '% of book closed', align: 'r', render: (r) => (
        <span className={shareOf(r.closed, r.allocated) >= 75 ? 'text-warn' : ''}>
          {pct(shareOf(r.closed, r.allocated))}
        </span>
      ) },
    { key: 'n', head: 'Camps cut', align: 'r', render: (r) => (
        <span title={`${r.closedCamps} of ${r.camps} that ran`}>{num(r.closedCamps)}</span>
      ) },
    { key: 'b', head: 'Bot %', align: 'r', render: (r) => (
        r.botRecorded
          ? <span style={{ color: BOT }} title={`${r.botCamps} campaigns, ${rs(r.botBudget)}`}>
              {pct(shareOf(r.botBudget, r.closed))}
            </span>
          : <span className="text-muted" title="the bot kept no record before 1 August">n/a</span>
      ) },
    { key: 'm', head: 'Manual %', align: 'r', render: (r) => (
        r.botRecorded
          ? <span style={{ color: MANUAL }} title={`${r.manualCamps} campaigns, ${rs(r.manualBudget)}`}>
              {pct(shareOf(r.manualBudget, r.closed))}
            </span>
          : <span className="text-muted">n/a</span>
      ) },
    { key: 'r', head: 'ROAS at close', align: 'r', render: (r) =>
        r.closedSpend > 0
          ? <Roas v={roasOf(r.closedRevenue, r.closedSpend)} />
          : <span className="text-muted">–</span> },
    { key: 'dr', head: 'Day ROAS', align: 'r', render: (r) => <Roas v={roasOf(r.revenue, r.spend)} /> },
  ];

  const total: ClosingDayRow = {
    date: 'TOTAL', camps: sum((r) => r.camps), allocated: allocTotal, closed: closedTotal,
    closedCamps: sum((r) => r.closedCamps), closedByTen: byTenTotal,
    campsByTen: sum((r) => r.campsByTen),
    botCamps: sum((r) => r.botCamps, recorded), botBudget: botTotal,
    manualCamps: sum((r) => r.manualCamps, recorded), manualBudget: manTotal,
    closedSpend, closedRevenue: closedRev,
    spend: sum((r) => r.spend), revenue: sum((r) => r.revenue),
    botRecorded: true, delta: 0, deltaPct: 0, move: 'first',
  };

  const cats = rows.map((r) => dayLabel(r.date));

  return (
    <Page
      title="Daily Closing"
      subtitle={`${from} → ${to} · ${rows.length} days · ${scope.label}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat
          label="Closed by 10:00"
          value={pct(pctOf(byTenTotal, closedTotal))}
          sub={`${lakh(byTenTotal)} of the ${lakh(closedTotal)} switched off`}
        />
        <Stat
          label="Closed by the bot"
          value={recorded.length ? pct(pctOf(botTotal, botTotal + manTotal)) : '—'}
          sub={recorded.length < rows.length
            ? `${recorded.length} of ${rows.length} days have a bot record`
            : `${lakh(botTotal)} bot · ${lakh(manTotal)} by hand`}
        />
        <Stat
          label="Book closed"
          value={pct(pctOf(closedTotal, allocTotal))}
          sub={`${lakh(closedTotal)} of ${lakh(allocTotal)} allocated`}
        />
        <Stat
          label="ROAS at the cut"
          value={roasOf(closedRev, closedSpend).toFixed(2)}
          sub={`the book as a whole ran at ${roasOf(sum((r) => r.revenue), sum((r) => r.spend)).toFixed(2)}`}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${rows.length} days, ${scope.label}`} />

      <Card
        title="Morning against the rest of the day"
        note="budget switched off before 10:00 IST, and what the remaining fourteen hours added"
      >
        <StackedBars
          categories={cats}
          fmt={(v) => (v >= 100000 ? `${(v / 100000).toFixed(1)}L` : num(v))}
          series={[
            { key: 'am', label: 'by 10:00', color: MORNING, values: rows.map((r) => r.closedByTen) },
            { key: 'pm', label: 'after 10:00', color: LATER, values: rows.map((r) => Math.max(0, r.closed - r.closedByTen)) },
          ]}
        />
      </Card>

      <Card
        title="Who did the closing"
        note="closed budget split between the ladder bot and a person in Ads Manager — the bot's own record starts 1 August"
      >
        <StackedBars
          categories={cats}
          fmt={(v) => (v >= 100000 ? `${(v / 100000).toFixed(1)}L` : num(v))}
          series={[
            { key: 'bot', label: 'bot', color: BOT, values: rows.map((r) => (r.botRecorded ? r.botBudget : 0)) },
            { key: 'man', label: 'by hand', color: MANUAL, values: rows.map((r) => (r.botRecorded ? r.manualBudget : r.closed)) },
          ]}
        />
      </Card>

      <Card
        title="The book, day by day"
        note="allocated budget against the share of it that ended the day switched off"
      >
        <Line
          fmt={(v) => `${v.toFixed(0)}%`}
          categories={cats}
          series={[{
            label: 'closed % of allocated',
            color: '#eb6834',
            values: rows.map((r) => shareOf(r.closed, r.allocated)),
          }]}
          baseline={{ value: pctOf(closedTotal, allocTotal), label: 'window average' }}
        />
      </Card>

      <Card title="Every day" note="newest first">
        <Table cols={cols} rows={[...rows].reverse()} footer={total} />
      </Card>

      <Note>
        <b className="text-text-strong">Closed by 10:00</b> counts the campaigns whose final close of
        the day happened at or before 10:00 IST and which were still off at midnight, so it is always
        a part of the whole-day figure rather than a separate count. A campaign cut at 09:00 and
        reopened at 11:00 appears in neither.
        {' '}<b className="text-text-strong">Both percentages are shares of the same allocated
        book</b>, so <span className="text-text">% of book by 10:00</span> is always a part of{' '}
        <span className="text-text">% of book closed</span> and the gap between them is what the
        remaining fourteen hours added. Hover the morning figure to see how much of that day&apos;s
        closing was already done.
        {' '}<b className="text-text-strong">% of budget spent</b> is the day&apos;s delivery against
        that same allocated book. It can pass 100% — Meta over-delivers, and a campaign paused
        mid-day keeps spending for a while afterwards — and today&apos;s row reads low simply because
        the day is not over.
        {' '}<b className="text-text-strong">Allocated</b> counts only campaigns that were active at
        some point that day; budget parked on something that never went live was never part of the
        book.
        {' '}<b className="text-text-strong">Push, maintain and minus</b> compare allocated budget
        with the day before, with anything inside ±{MAINTAIN_BAND}% treated as holding rather than
        deciding.
        {' '}<b className="text-text-strong">Bot and manual</b> come from the auto-pause bot&apos;s own
        record of what it switched off, matched to the exact ten-minute window each close was
        observed in. That record begins <b className="text-warn">1 August 2026</b>; earlier days show
        n/a rather than pretending everything was manual.
        {' '}Close detection is rebuilt nightly into <span className="text-text">camp_close_event</span>{' '}
        because it needs a scan over every snapshot; today is computed live, so this page is current
        to the last ten-minute reading.
      </Note>
    </Page>
  );
}
