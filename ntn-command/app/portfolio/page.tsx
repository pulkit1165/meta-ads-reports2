import {
  portfolio, BANDS, forDay, roasOf, verdictOf, type PortfolioRow,
} from '@/lib/portfolio';
import { PORTAL_NAME } from '@/lib/ads';
import { adDatesAvailable } from '@/lib/brief';
import { resolveRange, resolveScope, istToday, type SearchParams } from '@/lib/range';
import { rank, money, pctOf, type Finding } from '@/lib/insights';
import { Line, StackedBars, SERIES } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BAND_COLOR: Record<string, string> = {
  d1: '#eb6834', d13: '#eda100', d47: '#5aa9a3', d8: '#1baf7a',
};

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 14);
  const scope = resolveScope(sp);
  const available = await adDatesAvailable(30);
  const istNow = istToday();
  const asked = Array.isArray(sp?.day) ? sp.day[0] : sp?.day;
  const settled = available.filter((d) => d < istNow);
  const day = asked && available.includes(asked) ? asked : (settled[0] ?? available[0] ?? istNow);

  const controls = (
    <PageControls range={range} scope={scope} days={available.slice(0, 10)} day={day} today={istNow} />
  );

  // The history window must cover the chosen day even if it sits outside it.
  const from = range.from < day ? range.from : day;
  const to = range.to > day ? range.to : day;
  const rows = await portfolio(from, to, scope.codes);

  if (!rows.length) {
    return (
      <Page title="Portfolio by Age" subtitle={`${day} · ${scope.label}`} actions={controls}>
        <Note kind="warn">No campaign had spend or budget between {from} and {to}.</Note>
      </Page>
    );
  }

  const { bands, total } = forDay(rows, day);
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const label = (d: string) => d.slice(8) + '/' + d.slice(5, 7);
  const cell = (d: string, k: string) => rows.find((r) => r.date === d && r.bandKey === k);

  const totalRoas = roasOf(total.revenue, total.spend);

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const below = bands.filter((b) => b.row && roasOf(b.row.revenue, b.row.spend) < b.band.target);
  const worst = [...below].sort((a, b) =>
    (roasOf(a.row!.revenue, a.row!.spend) - a.band.target) -
    (roasOf(b.row!.revenue, b.row!.spend) - b.band.target))[0];

  if (worst?.row) {
    const actual = roasOf(worst.row.revenue, worst.row.spend);
    findings.push({
      severity: actual < worst.band.target - 0.25 ? 'critical' : 'watch',
      headline: `${worst.band.label} is ${(worst.band.target - actual).toFixed(2)} under its target`,
      detail: `${actual.toFixed(2)} against ${worst.band.target.toFixed(2)} on ${money(worst.row.spend)} of spend across ${worst.row.camps} campaigns.`,
      action: worst.band.lo === 1
        ? 'Day-1 campaigns carry the loosest target for a reason — but missing it still means the launch cohort is paying for itself less than the book assumes.'
        : 'A mature band under target is the expensive kind of miss: the money is committed and the learning excuse is gone.',
    });
  }

  const d1 = bands.find((b) => b.band.key === 'd1')?.row;
  if (d1 && total.spend > 0) {
    findings.push({
      severity: pctOf(d1.spend, total.spend) > 30 ? 'watch' : 'neutral',
      headline: `Today's launches are ${pct(pctOf(d1.spend, total.spend))} of the day's spend`,
      detail: `${money(d1.spend)} of ${money(total.spend)} across ${d1.camps} day-1 campaigns, returning ${roasOf(d1.revenue, d1.spend).toFixed(2)}. Of that, ${money(d1.closedBudget)} of budget was closed the same day.`,
    });
  }

  const closedTotal = bands.filter((b) => !b.band.subset)
    .reduce((s, b) => s + (b.row?.closedBudget ?? 0), 0);
  const d1Closed = d1?.closedBudget ?? 0;
  if (closedTotal > 0) {
    findings.push({
      severity: 'neutral',
      headline: `${pct(pctOf(d1Closed, closedTotal))} of everything closed that day was a day-1 campaign`,
      detail: `${money(d1Closed)} of ${money(closedTotal)}. The ladder is doing most of its work on the newest cohort, which is what it is designed for.`,
    });
  }

  /* ── summary table ────────────────────────────────────────────────────── */
  type SRow = { key: string; label: string; target: number | null; row?: PortfolioRow; subset: boolean };
  const srows: SRow[] = [
    ...bands.map((b) => ({
      key: b.band.key, label: b.band.label, target: b.band.target, row: b.row, subset: !!b.band.subset,
    })),
    {
      key: 'total', label: 'TOTAL', target: null, subset: false,
      row: {
        date: day, bandKey: 'total', camps: total.camps, budget: total.budget,
        spend: total.spend, revenue: total.revenue, closedBudget: total.closedBudget,
        closedCamps: total.closedCamps, closedSpend: 0, closedRevenue: 0,
      },
    },
  ];

  const cols: Col<SRow>[] = [
    { key: 'b', head: 'Bucket', align: 'l', render: (r) => (
        <span className={r.key === 'total' ? 'font-medium' : r.subset ? 'italic text-muted' : ''}>
          {r.label}
        </span>
      ) },
    { key: 'c', head: '# Camps', align: 'r', render: (r) => num(r.row?.camps ?? 0) },
    { key: 'bu', head: 'Budget', align: 'r', render: (r) => rs(r.row?.budget ?? 0) },
    { key: 's', head: 'Spend', align: 'r', render: (r) => rs(r.row?.spend ?? 0) },
    { key: 'v', head: 'Rev', align: 'r', render: (r) => rs(r.row?.revenue ?? 0) },
    { key: 'r', head: 'Actual ROAS', align: 'r', render: (r) =>
        <Roas v={roasOf(r.row?.revenue ?? 0, r.row?.spend ?? 0)} /> },
    { key: 't', head: 'Target', align: 'r', render: (r) =>
        r.target == null ? <span className="text-muted">—</span>
          : <span className="text-muted">{r.target.toFixed(2)}×</span> },
    { key: 'd', head: 'Δ', align: 'r', render: (r) => {
        if (r.target == null || !r.row) return <span className="text-muted">—</span>;
        const d = roasOf(r.row.revenue, r.row.spend) - r.target;
        return (
          <span className={d >= 0 ? 'text-good' : d > -0.10 ? 'text-warn' : 'text-bad'}>
            {d >= 0 ? '↑' : '↓'} {Math.abs(d).toFixed(2)}×
          </span>
        );
      } },
    { key: 'vd', head: 'Verdict', align: 'r', render: (r) => {
        if (r.target == null || !r.row) return <span className="text-muted">—</span>;
        const v = verdictOf(roasOf(r.row.revenue, r.row.spend), r.target);
        return (
          <span className={v === 'Above' ? 'text-good' : v === 'Near' ? 'text-warn' : 'text-bad'}>
            {v}
          </span>
        );
      } },
    { key: 'cb', head: 'Closed that day', align: 'r', render: (r) => (
        <span title={`${r.row?.closedCamps ?? 0} campaigns`}>
          {rs(r.row?.closedBudget ?? 0)}
          {r.row && r.row.budget > 0 && (
            <span className="ml-1.5 text-[11px] text-muted">
              {pct(pctOf(r.row.closedBudget, r.row.budget))}
            </span>
          )}
        </span>
      ) },
  ];

  /* ── day-wise history ─────────────────────────────────────────────────── */
  type HRow = { date: string };
  const hcols: Col<HRow>[] = [
    { key: 'd', head: 'Day', align: 'l', render: (h) => (
        <span className={h.date === day ? 'text-gold' : ''}>{label(h.date)}</span>
      ) },
    ...BANDS.map((b) => ({
      key: `r_${b.key}`,
      head: b.label.replace(' (today’s launches)', ''),
      align: 'r' as const,
      render: (h: HRow) => {
        const c = cell(h.date, b.key);
        if (!c || c.spend <= 0) return <span className="text-muted">–</span>;
        const v = roasOf(c.revenue, c.spend);
        return (
          <span title={`${c.camps} camps · ${rs(c.spend)} spend · target ${b.target.toFixed(2)}`}>
            <Roas v={v} />
            <span className={`ml-1.5 text-[11px] ${v >= b.target ? 'text-good' : 'text-muted'}`}>
              {v >= b.target ? '↑' : '↓'}{Math.abs(v - b.target).toFixed(2)}
            </span>
          </span>
        );
      },
    })),
    { key: 'cl', head: 'Closed (all bands)', align: 'r', render: (h) => {
        const t = BANDS.filter((b) => !b.subset)
          .reduce((s, b) => s + (cell(h.date, b.key)?.closedBudget ?? 0), 0);
        return rs(t);
      } },
    { key: 'c1', head: 'of which day 1', align: 'r', render: (h) => {
        const d1c = cell(h.date, 'd1')?.closedBudget ?? 0;
        const t = BANDS.filter((b) => !b.subset)
          .reduce((s, b) => s + (cell(h.date, b.key)?.closedBudget ?? 0), 0);
        return (
          <span>
            {rs(d1c)}
            {t > 0 && <span className="ml-1.5 text-[11px] text-muted">{pct(pctOf(d1c, t))}</span>}
          </span>
        );
      } },
  ];

  const hrows: HRow[] = [...dates].reverse().map((d) => ({ date: d }));

  return (
    <Page
      title="Portfolio by Age"
      subtitle={`${day} · ${scope.label} · ROAS against target by campaign age, and what closed`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Campaigns" value={num(total.camps)} sub={`${rs(total.budget)} of budget`} />
        <Stat label="Spend" value={lakh(total.spend)} sub={`${pct(pctOf(total.spend, total.budget))} of budget`} />
        <Stat label="Blended ROAS" value={totalRoas.toFixed(2)} sub={`${lakh(total.revenue)} revenue`} />
        <Stat
          label="Closed that day"
          value={rs(total.closedBudget)}
          sub={`${num(total.closedCamps)} campaigns · ${pct(pctOf(total.closedBudget, total.budget))} of budget`}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${day}, ${num(total.camps)} campaigns`} />

      <Card title="Portfolio summary" note={`${day} · Day 1 is a subset of Day 1-3, so the bands do not sum to TOTAL`}>
        <Table cols={cols} rows={srows} />
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="ROAS by age, day by day" note="dashed lines are the per-band targets">
          <Line
            fmt={(v) => v.toFixed(2)}
            categories={dates.map(label)}
            baseline={{ value: 1, label: 'break-even' }}
            series={BANDS.filter((b) => !b.subset).map((b) => ({
              label: b.label,
              color: BAND_COLOR[b.key],
              values: dates.map((d) => {
                const c = cell(d, b.key);
                return c && c.spend > 0 ? roasOf(c.revenue, c.spend) : null;
              }),
            }))}
          />
        </Card>
        <Card title="Closed budget by age band" note="which cohort the ladder switched off each day">
          <StackedBars
            height={200}
            fmt={(v) => (v >= 100000 ? `${(v / 100000).toFixed(1)}L` : `${Math.round(v / 1000)}k`)}
            categories={dates.map(label)}
            series={BANDS.filter((b) => !b.subset).map((b) => ({
              key: b.key, label: b.label, color: BAND_COLOR[b.key],
              values: dates.map((d) => cell(d, b.key)?.closedBudget ?? 0),
            }))}
          />
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {BANDS.filter((b) => !b.subset).map((b) => (
              <div key={b.key} className="flex items-center gap-1.5 text-[11px]">
                <span className="h-2 w-2 rounded-sm" style={{ background: BAND_COLOR[b.key] }} />
                <span className="text-text">{b.label}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Every day" note="ROAS against target per band, and the budget closed that day">
        <Table cols={hcols} rows={hrows} />
      </Card>

      <Note>
        A campaign&apos;s age counts from the first day it actually <b className="text-text-strong">spent</b>,
        not from when it was created — one built on Monday and switched on Thursday is on day 1 on
        Thursday, which is when Meta&apos;s learning starts and what the closing ladder gates on.
        {' '}<b className="text-text-strong">Day 1 is shown as a subset of Day 1-3</b>, so the bands
        deliberately do not sum to TOTAL; the total is Day 1-3 + Day 4-7 + 7 days+. Budget is the
        largest daily budget seen in that day&apos;s snapshots, because a campaign closed before the
        last capture still had its allowance available. Targets are 1.15 / 1.40 / 1.60 / 1.80 —
        tell me if yours differ and I will change them.
      </Note>
    </Page>
  );
}
