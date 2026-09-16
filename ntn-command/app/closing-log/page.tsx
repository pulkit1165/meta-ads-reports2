import Link from 'next/link';
import { closeLog, bucket, hourBlock, HOUR_BLOCKS, type CloseEvent, type Bucket } from '@/lib/closinglog';
import { dailyClosing, shareOf, type ClosingDayRow } from '@/lib/closingdaily';
import { resolveRange, resolveScope, dayLabel, weekday, isWeekend, type SearchParams } from '@/lib/range';
import { ageBand, AGE_BANDS, creativeTags, roasOf, PORTAL_NAME } from '@/lib/ads';
import { rank, money, type Finding } from '@/lib/insights';
import { StackedBars, BarList, ShareBar } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, rs, pct, num, lakh, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BOT = '#2a78d6';
const MANUAL = '#eb6834';

const med = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export default async function ClosingLogPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  // Five complete days plus today by default — the log is a list of events, so
  // a half-finished day contributes fewer rows rather than distorting an
  // average, which is why this page runs to today where windowed reports stop
  // at yesterday.
  const range = resolveRange(sp, 5);
  const scope = resolveScope(sp);
  const from = range.days === 0 ? range.today : range.from;
  const to = range.today;

  const only = String(Array.isArray(sp.by) ? sp.by[0] : sp.by ?? 'all');
  const actorFilter = only === 'bot' || only === 'manual' ? only : 'all';

  const [log, book] = await Promise.all([
    closeLog(from, to, scope.codes),
    dailyClosing(from, to, scope.codes),
  ]);
  const all = log.events;
  const ev = actorFilter === 'all' ? all : all.filter((e) => e.actor === actorFilter);

  const controls = <PageControls range={range} scope={scope} />;

  if (!all.length) {
    return (
      <Page title="Closing Log" subtitle={`${from} → ${to}`} actions={controls}>
        <Note kind="warn">
          No status flips in <span className="text-warn">meta_campaign_snapshot</span> over this
          window. The pipeline writes a snapshot every ten minutes, so an empty window means it was
          not running rather than that nothing was closed.
        </Note>
      </Page>
    );
  }

  const bots = all.filter((e) => e.actor === 'bot');
  const mans = all.filter((e) => e.actor === 'manual');
  const closedBudget = all.reduce((s, e) => s + e.budget, 0);
  const burntBefore = all.reduce((s, e) => s + e.spend, 0);
  const revBefore = all.reduce((s, e) => s + e.revenue, 0);
  const days = new Set(all.map((e) => e.date)).size;

  /* ── patterns ─────────────────────────────────────────────────────────── */
  const byHour = HOUR_BLOCKS.map((h) => {
    const rows = ev.filter((e) => hourBlock(e.minute) === h);
    return {
      key: h,
      bot: rows.filter((e) => e.actor === 'bot').length,
      manual: rows.filter((e) => e.actor === 'manual').length,
      closes: rows.length,
      budget: rows.reduce((s, e) => s + e.budget, 0),
      medPct: med(rows.filter((e) => e.budget > 0).map((e) => e.pct)),
      roas: roasOf(rows.reduce((s, e) => s + e.revenue, 0), rows.reduce((s, e) => s + e.spend, 0)),
    };
  });

  const byActor: Bucket[] = bucket(all, (e) => e.actor);
  const byAge = bucket(ev, (e) => ageBand(e.dayNo))
    .sort((a, b) => AGE_BANDS.indexOf(a.key as (typeof AGE_BANDS)[number])
                  - AGE_BANDS.indexOf(b.key as (typeof AGE_BANDS)[number]));
  const byBlock = bucket(ev, (e) => e.saleBlock).slice(0, 14);
  const byType = bucket(ev, (e) => creativeTags(e.creativeType));
  const bySent = bucket(ev, (e) => e.sentiments);
  const byDay = bucket(ev, (e) => `${weekday(e.date)} ${dayLabel(e.date)}`)
    .sort((a, b) => b.key.slice(4).split('/').reverse().join().localeCompare(a.key.slice(4).split('/').reverse().join()));

  /* ── the book, day by day ─────────────────────────────────────────────── */
  // dailyClosing counts a campaign as closed only if it ended the day off, so
  // these figures are the day's verdict rather than every intraday flip.
  const bookDays = [...book].reverse();               // newest first
  const doneDays = book.filter((b) => b.date < range.today && b.allocated > 0);
  const avgClosedPct = doneDays.length
    ? doneDays.reduce((s, b) => s + shareOf(b.closed, b.allocated), 0) / doneDays.length
    : 0;
  const doneClosedSpend = doneDays.reduce((s, b) => s + b.closedSpend, 0);
  const doneClosedRev = doneDays.reduce((s, b) => s + b.closedRevenue, 0);
  const doneClosed = doneDays.reduce((s, b) => s + b.closed, 0);

  const medPctBot = med(bots.filter((e) => e.budget > 0).map((e) => e.pct));
  const medPctMan = med(mans.filter((e) => e.budget > 0).map((e) => e.pct));
  const medDayBot = med(bots.map((e) => e.dayNo));
  const medDayMan = med(mans.map((e) => e.dayNo));
  const highRoas = mans.filter((e) => e.roas >= 0.75);
  const reopened = all.filter((e) => e.reopened).length;
  const oldManual = mans.filter((e) => e.dayNo > 3).length;

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];

  if (doneDays.length) {
    findings.push({
      severity: avgClosedPct >= 60 ? 'watch' : 'neutral',
      headline: `A typical day ends with ${pct(avgClosedPct)} of the book switched off`,
      detail: `Across ${num(doneDays.length)} complete days, ${money(doneClosed)} of allocated budget ended its day closed — ${money(doneClosedSpend)} already burnt at a combined ${roasOf(doneClosedRev, doneClosedSpend).toFixed(2)} ROAS before the cut.`,
      action: avgClosedPct >= 60
        ? 'More than half the book is being allocated to campaigns that do not survive their own day. The day-by-day table below shows which days carry it.'
        : undefined,
    });
  }

  findings.push({
    severity: 'neutral',
    headline: `${pct((bots.length / all.length) * 100)} of closes are the bot, ${pct((mans.length / all.length) * 100)} are done by hand`,
    detail: `${num(bots.length)} bot and ${num(mans.length)} manual closes over ${days} days. The bot cuts at a median ${pct(medPctBot)} of budget burnt; by hand it is ${pct(medPctMan)}.`,
    action: medPctMan > medPctBot + 15
      ? 'Manual closes run much further into the budget. Whatever rule a person is applying, it is costing more per decision than the ladder does.'
      : undefined,
  });

  if (oldManual > 0) {
    findings.push({
      severity: 'neutral',
      headline: `Everything past day 3 is closed by hand — ${num(oldManual)} of them`,
      detail: `The bot is configured day-1-only, with a 72-hour age gate from creation or last reactivation, so it cannot touch a campaign past day 3. Median age at a manual close is day ${medDayMan.toFixed(0)}, against day ${medDayBot.toFixed(0)} for the bot.`,
      action: 'This is a gap rather than a preference: nothing automatic is watching campaigns after their third day.',
    });
  }

  if (highRoas.length > 0) {
    const hrSpend = highRoas.reduce((s, e) => s + e.spend, 0);
    findings.push({
      severity: 'watch',
      headline: `${num(highRoas.length)} campaigns were cut at 0.75 ROAS or better`,
      detail: `The ladder stops at 0.75, so every one of these was a human decision. Together they held ${money(highRoas.reduce((s, e) => s + e.budget, 0))} of budget and were earning ${roasOf(highRoas.reduce((s, e) => s + e.revenue, 0), hrSpend).toFixed(2)} when they were switched off.`,
      action: 'Worth confirming these were deliberate rather than a bulk pause that caught bystanders.',
    });
  }

  const peak = [...byHour].sort((a, b) => b.closes - a.closes)[0];
  if (peak && peak.closes > 0) {
    findings.push({
      severity: 'neutral',
      headline: `Closing peaks between ${peak.key.replace('–', ' and ')}`,
      detail: `${num(peak.closes)} of ${num(ev.length)} closes land in that block, at a median ${pct(peak.medPct)} of budget spent. The bot runs all day — 00:00 to 23:59 — so this is where campaigns actually fail their gate, not when something happens to be looking.`,
    });
  }

  const hotBlock = byBlock[0];
  if (hotBlock && hotBlock.closes >= 8) {
    findings.push({
      severity: hotBlock.closes >= ev.length * 0.15 ? 'watch' : 'neutral',
      headline: `${hotBlock.key.slice(0, 56)} absorbs the most cuts`,
      detail: `${num(hotBlock.closes)} closes holding ${money(hotBlock.budget)}, burning ${money(hotBlock.spend)} at ${hotBlock.roas.toFixed(2)} before being switched off.`,
      action: 'A block this repeatedly cut is an audience verdict. Relaunching into it is paying the same tuition twice.',
    });
  }

  const typed = byType.filter((t) => t.closes >= 10);
  const worstType = [...typed].sort((a, b) => b.medPct - a.medPct)[0];
  if (worstType) {
    findings.push({
      severity: 'neutral',
      headline: `${worstType.key} creatives run furthest into budget before being cut`,
      detail: `Median ${pct(worstType.medPct)} of budget spent at the cut across ${num(worstType.closes)} closes, ending at ${worstType.roas.toFixed(2)}. The cheapest style to kill is ${[...typed].sort((a, b) => a.medPct - b.medPct)[0]?.key ?? '—'}.`,
    });
  }

  if (reopened > 0) {
    findings.push({
      severity: reopened >= all.length * 0.08 ? 'watch' : 'neutral',
      headline: `${num(reopened)} closes were undone the same day`,
      detail: 'The campaign went back ACTIVE after being switched off, so the cut either was not meant or was overridden. Each one restarts delivery on a campaign the gate had already judged.',
      action: reopened >= all.length * 0.08
        ? 'At this rate the ladder and whoever is reopening are working against each other. Worth settling which one decides.'
        : undefined,
    });
  }

  /* ── tables ───────────────────────────────────────────────────────────── */
  const patternCols = (head: string, wide = false): Col<Bucket>[] => [
    { key: 'k', head, align: 'l', render: (b) => (
        <span className={wide ? 'block max-w-[300px] truncate' : ''} title={b.key}>
          {PORTAL_NAME[b.key] ?? b.key}
        </span>
      ) },
    { key: 'c', head: 'Closes', align: 'r', render: (b) => num(b.closes) },
    { key: 'split', head: 'Bot / manual', align: 'r', render: (b) => (
        <span className="tabular-nums">
          <span style={{ color: BOT }}>{num(b.bot)}</span>
          <span className="text-muted/60"> / </span>
          <span style={{ color: MANUAL }}>{num(b.manual)}</span>
        </span>
      ) },
    { key: 'b', head: 'Budget closed', align: 'r', render: (b) => rs(b.budget) },
    { key: 's', head: 'Burnt first', align: 'r', render: (b) => rs(b.spend) },
    { key: 'p', head: 'Median burn', align: 'r', render: (b) => (
        <span className={b.medPct >= 80 ? 'text-warn' : ''}>{pct(b.medPct)}</span>
      ) },
    { key: 'r', head: 'ROAS at cut', align: 'r', render: (b) =>
        b.spend > 0 ? <Roas v={b.roas} /> : <span className="text-muted">–</span> },
    { key: 'u', head: 'Undone', align: 'r', render: (b) =>
        b.reopened ? <span className="text-warn">{num(b.reopened)}</span> : <span className="text-muted">–</span> },
  ];

  const bookCols: Col<ClosingDayRow>[] = [
    { key: 'd', head: 'Day', align: 'l', render: (b) => (
        <span className="whitespace-nowrap">
          <span className={isWeekend(b.date) ? 'text-muted/70' : 'text-muted'}>{weekday(b.date)}</span>{' '}
          <span className="text-text-strong">{dayLabel(b.date)}</span>
          {b.date === range.today && <span className="ml-1.5 text-[10px] text-warn">so far</span>}
        </span>
      ) },
    { key: 'a', head: 'Book', align: 'r', render: (b) => rs(b.allocated) },
    { key: 'c', head: 'Closed', align: 'r', render: (b) => (
        <span className="whitespace-nowrap">
          {rs(b.closed)} <span className="text-muted/70">· {num(b.closedCamps)}</span>
        </span>
      ) },
    { key: 'p', head: '% of book', align: 'r', render: (b) => {
        const p = shareOf(b.closed, b.allocated);
        return <span className={p >= 60 ? 'text-warn' : ''}>{pct(p)}</span>;
      } },
    { key: 'bm', head: 'Bot / manual', align: 'r', render: (b) => (
        <span className="whitespace-nowrap tabular-nums">
          <span style={{ color: BOT }}>{rs(b.botBudget)}</span>
          <span className="text-muted/60"> / </span>
          <span style={{ color: MANUAL }}>{rs(b.manualBudget)}</span>
        </span>
      ) },
    { key: 's', head: 'Burnt first', align: 'r', render: (b) => rs(b.closedSpend) },
    { key: 'r', head: 'ROAS at cut', align: 'r', render: (b) =>
        b.closedSpend > 0
          ? <Roas v={roasOf(b.closedRevenue, b.closedSpend)} />
          : <span className="text-muted">–</span> },
  ];

  const logCols: Col<CloseEvent>[] = [
    { key: 'w', head: 'When', align: 'l', render: (e) => (
        <span className="whitespace-nowrap">
          <span className={isWeekend(e.date) ? 'text-muted/70' : 'text-muted'}>{weekday(e.date)}</span>{' '}
          <span className="text-muted">{dayLabel(e.date)}</span>{' '}
          <span className="tabular-nums text-text-strong">{e.at}</span>
        </span>
      ) },
    { key: 'c', head: 'Campaign', align: 'l', render: (e) => (
        <span className="block max-w-[330px] truncate" title={`${e.campaignName}  ·  ${e.campaignId}`}>
          {e.campaignName}
          {e.reopened && <span className="ml-1.5 text-[10px] text-warn">reopened</span>}
        </span>
      ) },
    { key: 'p', head: 'Portal', align: 'l', render: (e) => <span className="text-muted">{e.portal}</span> },
    { key: 'pr', head: 'Product', align: 'l', render: (e) => (
        <span className="block max-w-[130px] truncate text-muted" title={e.product}>{e.product}</span>
      ) },
    { key: 'b', head: 'Audience block', align: 'l', render: (e) => (
        <span className="block max-w-[210px] truncate text-muted" title={e.saleBlock}>{e.saleBlock}</span>
      ) },
    { key: 'ct', head: 'Creative', align: 'l', render: (e) => (
        <span className="block max-w-[130px] truncate text-muted" title={e.creativeType}>{e.creativeType}</span>
      ) },
    { key: 'sn', head: 'Sentiment', align: 'l', render: (e) => (
        <span className={`block max-w-[120px] truncate ${e.sentiments[0] === 'unmarked' ? 'text-muted/60' : 'text-muted'}`}
              title={e.sentiments.join(', ')}>
          {e.sentiments.join(', ')}
        </span>
      ) },
    { key: 'd', head: 'Day', align: 'r', render: (e) => (
        <span className={e.dayNo <= 1 ? 'text-gold' : 'text-muted'}>{num(e.dayNo)}</span>
      ) },
    { key: 'bu', head: 'Budget', align: 'r', render: (e) => rs(e.budget) },
    { key: 'sp', head: 'Spent', align: 'r', render: (e) => rs(e.spend) },
    { key: 'pc', head: 'Burn %', align: 'r', render: (e) => (
        e.budget > 0
          ? <span className={e.pct >= 80 ? 'text-warn' : ''}>{pct(e.pct)}</span>
          : <span className="text-muted">–</span>
      ) },
    { key: 'r', head: 'ROAS', align: 'r', render: (e) =>
        e.spend > 0 ? <Roas v={e.roas} /> : <span className="text-muted">–</span> },
    { key: 'by', head: 'Closed by', align: 'l', render: (e) => (
        <span
          className="whitespace-nowrap text-[11.5px]"
          style={{ color: e.actor === 'bot' ? BOT : MANUAL }}
          title={e.rule ? `ladder rule ${e.rule}${e.gate ? ` — gate Rs ${num(e.gate)}` : ''}` : 'no bot claim in this interval — switched off in Ads Manager'}
        >
          {e.actor === 'bot' ? `bot${e.gate ? ` · ${rs(e.gate)}` : ''}` : 'manual'}
        </span>
      ) },
  ];

  const chip = (key: string, label: string, count: number) => {
    const qs = new URLSearchParams();
    if (range.custom) { qs.set('from', range.from); qs.set('to', range.to); }
    else qs.set('days', String(range.days));
    if (scope.key !== 'all') qs.set('site', scope.key);
    if (key !== 'all') qs.set('by', key);
    const on = actorFilter === key;
    return (
      <Link
        key={key}
        href={`/closing-log?${qs.toString()}`}
        className={`rounded-lg border px-3 py-1.5 text-[12px] transition ${
          on ? 'border-gold/50 bg-gold/10 text-gold' : 'border-edge text-muted hover:text-text'
        }`}
      >
        {label} <span className="text-muted/70">{num(count)}</span>
      </Link>
    );
  };

  return (
    <Page
      title="Closing Log"
      subtitle={`${from} → ${to} · ${num(all.length)} closes · ${scope.label}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat
          label="Closes"
          value={num(all.length)}
          sub={`${days} days · ${(all.length / days).toFixed(0)} a day`}
        />
        <Stat
          label="By the bot"
          value={pct((bots.length / all.length) * 100)}
          sub={`${num(bots.length)} bot · ${num(mans.length)} by hand`}
        />
        <Stat
          label="Budget switched off"
          value={lakh(closedBudget)}
          sub={`${money(burntBefore)} of it already spent when cut`}
        />
        <Stat
          label="ROAS at the cut"
          value={roasOf(revBefore, burntBefore).toFixed(2)}
          sub={`median burn ${pct(med(all.filter((e) => e.budget > 0).map((e) => e.pct)))} of budget`}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${all.length} closes, ${days} days`} />

      <Card title="Who closes what" note="the same question from both sides: what the ladder catches, and what only a person catches">
        <ShareBar
          fmt={(v) => `${num(v)} closes`}
          parts={[
            { label: 'bot', value: bots.length, color: BOT },
            { label: 'manual', value: mans.length, color: MANUAL },
          ]}
        />
        <div className="mt-4">
          <Table cols={patternCols('Closed by')} rows={byActor} />
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        {chip('all', 'Everything', all.length)}
        {chip('bot', 'Bot only', bots.length)}
        {chip('manual', 'By hand only', mans.length)}
      </div>

      <Card
        title="When closing happens"
        note="three-hour blocks, IST. The bot's window is 00:00–23:59, so this is when campaigns fail their gate rather than when anything happens to be looking."
      >
        <StackedBars
          categories={HOUR_BLOCKS}
          fmt={(v) => num(v)}
          series={[
            { key: 'bot', label: 'bot', color: BOT, values: byHour.map((h) => h.bot) },
            { key: 'manual', label: 'manual', color: MANUAL, values: byHour.map((h) => h.manual) },
          ]}
        />
        <div className="mt-4">
          <Table
            cols={[
              { key: 'k', head: 'Block', align: 'l', render: (h: (typeof byHour)[number]) => h.key },
              { key: 'c', head: 'Closes', align: 'r', render: (h: (typeof byHour)[number]) => num(h.closes) },
              { key: 's', head: 'Bot / manual', align: 'r', render: (h: (typeof byHour)[number]) => (
                  <span className="tabular-nums">
                    <span style={{ color: BOT }}>{num(h.bot)}</span>
                    <span className="text-muted/60"> / </span>
                    <span style={{ color: MANUAL }}>{num(h.manual)}</span>
                  </span>
                ) },
              { key: 'b', head: 'Budget closed', align: 'r', render: (h: (typeof byHour)[number]) => rs(h.budget) },
              { key: 'p', head: 'Median burn', align: 'r', render: (h: (typeof byHour)[number]) => pct(h.medPct) },
              { key: 'r', head: 'ROAS at cut', align: 'r', render: (h: (typeof byHour)[number]) =>
                  h.closes ? <Roas v={h.roas} /> : <span className="text-muted">–</span> },
            ]}
            rows={byHour.filter((h) => h.closes > 0)}
          />
        </div>
      </Card>

      <Card
        title="Day by day, against the book"
        note={doneDays.length
          ? `campaigns that ended their day switched off, against everything allocated that day · complete-day average: ${pct(avgClosedPct)} of the book closed, cut at ${roasOf(doneClosedRev, doneClosedSpend).toFixed(2)}`
          : 'campaigns that ended their day switched off, against everything allocated that day'}
      >
        <Table cols={bookCols} rows={bookDays} empty="No snapshot days in this window." />
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card title="By campaign age" note="age counts from the first day the campaign spent">
          <Table cols={patternCols('Day window')} rows={byAge} />
        </Card>
        <Card title="Every flip per day" note="closes per calendar day — every intraday flip, reopened ones included">
          <Table cols={patternCols('Day')} rows={byDay} />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card
          title="By creative type"
          note="a campaign using two styles counts under both, so the closes column does not sum"
        >
          <Table cols={patternCols('Creative')} rows={byType} />
        </Card>
        <Card
          title="By creative sentiment"
          note="read from the marker in the ad name — an ad carrying two counts under both"
        >
          <Table cols={patternCols('Sentiment')} rows={bySent} />
        </Card>
      </div>

      <Card title="By audience block" note="the fourteen blocks absorbing the most cuts">
        <BarList
          fmt={(v) => `${num(v)} closes`}
          rows={byBlock.map((b) => ({
            label: b.key,
            value: b.closes,
            sub: `${rs(b.budget)} closed · ${rs(b.spend)} burnt · ${b.roas.toFixed(2)} at cut`,
            color: b.roas >= 0.75 ? '#eda100' : MANUAL,
          }))}
        />
        <div className="mt-4">
          <Table cols={patternCols('Audience block', true)} rows={byBlock} />
        </div>
      </Card>

      <Card
        title="Every close, newest first"
        note={`${num(ev.length)} events${actorFilter !== 'all' ? ` · ${actorFilter} only` : ''} · time is the first ten-minute snapshot that showed it off, so the cut happened at or just before it`}
      >
        <Table cols={logCols} rows={ev} empty="Nothing matches that filter." />
      </Card>

      <Note>
        <b className="text-text-strong">How &quot;bot or manual&quot; is decided.</b>{' '}
        Meta&apos;s snapshot tells us a campaign went from ACTIVE to PAUSED between two reads, but
        not who did it. The auto-pause bot keeps its own record of everything it switches off, which
        is synced from the box every ten minutes into{' '}
        <span className="text-text">bot_pause_event</span>. A flip whose interval contains a bot
        claim is the bot&apos;s; a flip with no claim was made by a person in Ads Manager.
        {log.unmatchedBotPauses > 0 && (
          <>{' '}<b className="text-text-strong">{num(log.unmatchedBotPauses)} bot pauses</b> in this
          window have no matching flip — the campaign was already showing off by the next read, so
          those cuts are counted once, not twice.</>
        )}
        {log.botRecordFrom && log.botRecordFrom > from && (
          <>{' '}The bot&apos;s record only starts at{' '}
          <b className="text-warn">{log.botRecordFrom}</b>, so anything before that date reads as
          manual whether it was or not.</>
        )}
        {' '}<b className="text-text-strong">Burn %</b> is spend against that day&apos;s budget at
        the moment of the cut, and can exceed 100% where Meta over-delivered.
      </Note>
    </Page>
  );
}
