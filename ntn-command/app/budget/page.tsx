import { campDays, bandOf, BAND_KEYS, LOSING, PORTAL_NAME, PORTALS, roasOf, share } from '@/lib/ads';
import { ROAS_BANDS, StackedBars, Line, ShareBar } from '@/components/charts';
import { resolveRange, resolveScope, istToday, weekday, isWeekend, type SearchParams } from '@/lib/range';
import { rank, pctOf, money, trend, type Finding } from '@/lib/insights';
import PageControls from '@/components/PageControls';
import { Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function BudgetPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 60);
  const scope = resolveScope(sp);
  const DAYS = range.span;
  const controls = <PageControls range={range} scope={scope} />;
  const all = await campDays(range.from, range.to, scope.codes);
  if (!all.length) {
    return (
      <Page title="Budget & ROAS" subtitle={range.label} actions={controls}>
        <Note kind="warn">meta_analysis_campaign_daily returned nothing between {range.from} and {range.to}.</Note>
      </Page>
    );
  }

  const dates = [...new Set(all.map((r) => r.date))].sort();
  // Whether a day is partial is a fact about the clock, not about its position
  // in the array — windows now end at yesterday, so the last row is usually a
  // settled day and treating it as partial would silently drop it.
  const istNow = istToday();
  const hasToday = dates.includes(istNow);

  // Campaigns with no spend never entered the auction; bucketing them as
  // "zero ROAS" would invent failures that never happened.
  const spent = all.filter((r) => r.spend > 0);

  const cell = (date: string, band: string) =>
    spent.filter((r) => r.date === date && bandOf(r.roas) === band).reduce((s, r) => s + r.spend, 0);

  const daySpend = (d: string) => spent.filter((r) => r.date === d).reduce((s, r) => s + r.spend, 0);
  const dayRev = (d: string) => spent.filter((r) => r.date === d).reduce((s, r) => s + r.revenue, 0);
  const dayBudget = (d: string) => all.filter((r) => r.date === d).reduce((s, r) => s + r.budget, 0);
  const dayLosing = (d: string) =>
    spent.filter((r) => r.date === d && LOSING.includes(bandOf(r.roas))).reduce((s, r) => s + r.spend, 0);

  const label = (d: string) => d.slice(8) + '/' + d.slice(5, 7);

  // Yesterday is the last complete day; today is still filling and its ROAS
  // reads low because revenue lags spend inside the day.
  // A one-day window has no earlier day to compare against; fall back to the
  // only day present rather than indexing off the end of the array.
  const complete = dates.filter((d) => d !== istNow);
  const lastComplete = complete[complete.length - 1] ?? dates[dates.length - 1];
  const prevComplete = complete[complete.length - 2] ?? lastComplete;

  type DRow = { date: string; budget: number; spend: number; rev: number; losing: number };
  const drows: DRow[] = dates.map((d) => ({
    date: d, budget: dayBudget(d), spend: daySpend(d), rev: dayRev(d), losing: dayLosing(d),
  })).reverse();

  const cols: Col<DRow>[] = [
    { key: 'wd', head: 'Day', align: 'l', render: (r) => (
        <span className={isWeekend(r.date) ? 'text-muted/70' : 'text-muted'}>{weekday(r.date)}</span>
      ) },
    { key: 'd', head: 'Date', align: 'l', render: (r) => (
        <span className={r.date === istNow ? 'text-warn' : ''}>
          {label(r.date)}{r.date === istNow && <span className="ml-1.5 text-[10px]">partial</span>}
        </span>
      ) },
    { key: 'b', head: 'Budget on the book', align: 'r', render: (r) => lakh(r.budget) },
    { key: 's', head: 'Spend', align: 'r', render: (r) => lakh(r.spend) },
    { key: 'u', head: 'Used', align: 'r', render: (r) => pct(share(r.spend, r.budget)) },
    { key: 'v', head: 'Revenue', align: 'r', render: (r) => lakh(r.rev) },
    { key: 'r', head: 'ROAS', align: 'r', render: (r) => <Roas v={roasOf(r.rev, r.spend)} /> },
    { key: 'l', head: 'Below 1.0', align: 'r', render: (r) => rs(r.losing) },
    { key: 'lp', head: 'Below 1.0 %', align: 'r', render: (r) => (
        <span className={share(r.losing, r.spend) >= 45 ? 'text-bad' : ''}>
          {pct(share(r.losing, r.spend))}
        </span>
      ) },
  ];

  const dToday = share(dayLosing(lastComplete), daySpend(lastComplete));
  const dPrev = share(dayLosing(prevComplete), daySpend(prevComplete));

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const roasSeries = complete.map((d) => roasOf(dayRev(d), daySpend(d)));
  const losingSeries = complete.map((d) => share(dayLosing(d), daySpend(d)));
  const roasTrend = trend(roasSeries);
  const losingTrend = trend(losingSeries);

  if (dToday >= 45) {
    findings.push({
      severity: dToday >= 55 ? 'critical' : 'watch',
      headline: `${dToday.toFixed(0)}% of ${lastComplete}'s spend returned under 1.0`,
      detail: `${money(dayLosing(lastComplete))} of ${money(daySpend(lastComplete))} went to campaigns that did not break even, against ${dPrev.toFixed(0)}% the day before.`,
      action: 'The closing ladder gates on spend, not on share. A day this heavy usually means volume arrived faster than the gates could cut it.',
    });
  } else if (dToday <= 30) {
    findings.push({
      severity: 'good',
      headline: `Only ${dToday.toFixed(0)}% of spend fell under 1.0`,
      detail: `${money(dayLosing(lastComplete))} of ${money(daySpend(lastComplete))} on ${lastComplete}, against ${dPrev.toFixed(0)}% the day before. The blended day closed at ${roasOf(dayRev(lastComplete), daySpend(lastComplete)).toFixed(3)}.`,
    });
  }

  if (losingTrend != null && Math.abs(losingTrend) > 3) {
    findings.push({
      severity: losingTrend > 0 ? 'watch' : 'good',
      headline: `Below-1.0 spend is ${losingTrend > 0 ? 'climbing' : 'falling'} across the window`,
      detail: `The share of spend under break-even is moving about ${Math.abs(losingTrend).toFixed(1)}% per day over ${complete.length} complete days, from ${losingSeries[0].toFixed(0)}% to ${losingSeries[losingSeries.length - 1].toFixed(0)}%.`,
    });
  }

  if (roasTrend != null && Math.abs(roasTrend) > 1.5) {
    findings.push({
      severity: roasTrend > 0 ? 'good' : 'watch',
      headline: `Blended ROAS is ${roasTrend > 0 ? 'improving' : 'drifting down'}`,
      detail: `About ${Math.abs(roasTrend).toFixed(1)}% per day over the window, ${roasSeries[0].toFixed(2)} → ${roasSeries[roasSeries.length - 1].toFixed(2)}.`,
    });
  }

  const util = share(daySpend(lastComplete), dayBudget(lastComplete));
  if (util < 35) {
    findings.push({
      severity: 'neutral',
      headline: `Only ${util.toFixed(0)}% of the budget on the book was spent`,
      detail: 'Budget on the book counts every campaign seen that day, including ones paused early, so it overstates what was simultaneously live. A low number here is usually the ladder working rather than delivery failing.',
    });
  }

  const zeroShare = share(cell(lastComplete, 'zero'), daySpend(lastComplete));
  if (zeroShare >= 4) {
    findings.push({
      severity: 'watch',
      headline: `${zeroShare.toFixed(1)}% of spend returned nothing at all`,
      detail: `${money(cell(lastComplete, 'zero'))} on ${lastComplete} went to campaigns with zero revenue. The flat gate cuts these at Rs 1,700, so this is spend that arrived before the gate could act.`,
    });
  }

  return (
    <Page
      title="Budget & ROAS"
      subtitle={`${range.label} · ${scope.label} · ${lastComplete} is the last complete day`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat
          label={`Spend · ${label(lastComplete)}`}
          value={lakh(daySpend(lastComplete))}
          sub={`${pct(share(daySpend(lastComplete), dayBudget(lastComplete)))} of the budget on the book`}
        />
        <Stat
          label="ROAS"
          value={roasOf(dayRev(lastComplete), daySpend(lastComplete)).toFixed(3)}
          sub={`vs ${roasOf(dayRev(prevComplete), daySpend(prevComplete)).toFixed(3)} the day before`}
          delta={roasOf(dayRev(lastComplete), daySpend(lastComplete)) - roasOf(dayRev(prevComplete), daySpend(prevComplete))}
          unit=""
        />
        <Stat
          label="Spend below 1.0"
          value={lakh(dayLosing(lastComplete))}
          sub={`${pct(dToday)} of the day's spend`}
          delta={dToday - dPrev}
          tone="invert"
          unit="pp"
        />
        {hasToday ? (
          <Stat
            label="Today so far"
            value={lakh(daySpend(istNow))}
            sub={`at ${roasOf(dayRev(istNow), daySpend(istNow)).toFixed(2)} — partial day, revenue lags spend`}
          />
        ) : (
          <Stat
            label="Window"
            value={`${complete.length} days`}
            sub={`${complete[0] ?? '–'} to ${lastComplete} — complete days only`}
          />
        )}
      </Grid>

      <Analysis findings={rank(findings)} basis={`${dates.length} days, ${num(spent.length)} campaign-days with spend`} />

      <Card title="Spend by ROAS band, day by day" note="the shape of the book over time">
        <StackedBars
          height={230}
          fmt={(v) => (v >= 100000 ? `${(v / 100000).toFixed(1)}L` : `${Math.round(v / 1000)}k`)}
          categories={dates.map(label)}
          series={ROAS_BANDS.map((b) => ({
            key: b.key, label: b.label, color: b.color,
            values: dates.map((d) => cell(d, b.key)),
          }))}
        />
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {ROAS_BANDS.map((b) => (
            <div key={b.key} className="flex items-center gap-1.5 text-[11px]">
              <span className="h-2 w-2 rounded-sm" style={{ background: b.color }} />
              <span className="text-text">{b.label}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="ROAS by day" note="complete days only; today excluded as partial">
          <Line
            fmt={(v) => v.toFixed(2)}
            baseline={{ value: 1, label: 'break-even 1.0' }}
            categories={complete.map(label)}
            series={[{
              label: 'Blended ROAS', color: '#2a78d6',
              values: complete.map((d) => roasOf(dayRev(d), daySpend(d))),
            }]}
          />
        </Card>

        <Card title={`Where ${label(lastComplete)} sat`} note="share of spend by band">
          <ShareBar
            fmt={rs}
            parts={ROAS_BANDS.map((b) => ({
              label: b.label, color: b.color, value: cell(lastComplete, b.key),
            })).filter((p) => p.value > 0)}
          />
          <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
            The three lowest bands are what the closing ladder exists to squeeze. They took{' '}
            <span className="text-text-strong">
              {pct(share(
                BAND_KEYS.slice(0, 3).reduce((s, b) => s + cell(lastComplete, b), 0),
                daySpend(lastComplete),
              ), 1)}
            </span>{' '}
            of spend that day.
          </p>
        </Card>
      </div>

      <Card title="Day by day" note={`budget on the book is every campaign seen that day, so it overstates what was simultaneously live`}>
        <Table cols={cols} rows={drows} />
      </Card>

      <Note>
        Campaigns that never spent are excluded from the bands — {num(all.length - spent.length)} of{' '}
        {num(all.length)} campaign-days over this window had zero spend, and counting them as
        zero-ROAS failures would invent losses that never happened. Today&apos;s row is a partial
        day: revenue is attributed later than spend, so its ROAS always reads low until the day
        closes.
      </Note>
    </Page>
  );
}
