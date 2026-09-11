import { repeatRate, istDates, storeLabel } from '@/lib/commerce';
import { Line, ShareBar, BarList } from '@/components/charts';
import { resolveRange, resolveScope, type SearchParams } from '@/lib/range';
import { rank, pctOf, money, trend, type Finding } from '@/lib/insights';
import PageControls from '@/components/PageControls';
import { Page, Card, Grid, Stat, Table, Note, Analysis, lakh, rs, pct, num, type Col } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function CohortsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const spar = await searchParams;
  const range = resolveRange(spar, 60);
  const scope = resolveScope(spar);
  const controls = <PageControls range={range} scope={scope} />;
  const { today, yesterday } = await istDates();
  const rows = await repeatRate(range.from, range.to, scope.codes);

  if (!rows.length) {
    return (
      <Page title="New vs Returning" subtitle={range.label} actions={controls}>
        <Note kind="warn">No attributable orders between {range.from} and {range.to}.</Note>
      </Page>
    );
  }

  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const label = (d: string) => d.slice(8) + '/' + d.slice(5, 7);
  const on = (d: string) => rows.filter((r) => r.date === d);
  const sum = (rs_: typeof rows, k: 'newOrders' | 'repeatOrders' | 'newRevenue' | 'repeatRevenue') =>
    rs_.reduce((s, r) => s + r[k], 0);

  const repeatShare = (d: string) => {
    const day = on(d);
    const t = sum(day, 'newOrders') + sum(day, 'repeatOrders');
    return t ? (sum(day, 'repeatOrders') / t) * 100 : 0;
  };

  const focus = dates.includes(yesterday) ? yesterday : dates[dates.length - 1];
  const yday = on(focus);
  const yNew = sum(yday, 'newOrders'), yRep = sum(yday, 'repeatOrders');
  const yNewRev = sum(yday, 'newRevenue'), yRepRev = sum(yday, 'repeatRevenue');
  const yTot = yNew + yRep;

  // Complete days only for the trend — today is still filling.
  // Windows end at yesterday, so `today` is usually absent entirely; the
  // fallback keeps the trend alive when someone picks the Today preset.
  const complete = dates.filter((d) => d !== today).length
    ? dates.filter((d) => d !== today)
    : dates;
  const avgRepeat = complete.length
    ? complete.reduce((s, d) => s + repeatShare(d), 0) / complete.length
    : 0;

  const stores = [...new Set(yday.map((r) => r.store))];
  type SRow = { store: string; n: number; r: number; nRev: number; rRev: number };
  const srows: SRow[] = stores.map((s) => {
    const mine = yday.filter((x) => x.store === s);
    return {
      store: s,
      n: sum(mine, 'newOrders'), r: sum(mine, 'repeatOrders'),
      nRev: sum(mine, 'newRevenue'), rRev: sum(mine, 'repeatRevenue'),
    };
  }).sort((a, b) => b.n + b.r - (a.n + a.r));

  const cols: Col<SRow>[] = [
    { key: 's', head: 'Store', align: 'l', render: (r) => storeLabel(r.store) },
    { key: 'o', head: 'Orders', align: 'r', render: (r) => num(r.n + r.r) },
    { key: 'n', head: 'New', align: 'r', render: (r) => num(r.n) },
    { key: 'rp', head: 'Returning', align: 'r', render: (r) => num(r.r) },
    { key: 'p', head: 'Repeat %', align: 'r', render: (r) => (
        <span className={r.n + r.r && r.r / (r.n + r.r) >= 0.55 ? 'text-good' : ''}>
          {pct(r.n + r.r ? (r.r / (r.n + r.r)) * 100 : 0)}
        </span>
      ) },
    { key: 'nv', head: 'New revenue', align: 'r', render: (r) => rs(r.nRev) },
    { key: 'rv', head: 'Returning revenue', align: 'r', render: (r) => rs(r.rRev) },
    { key: 'na', head: 'New AOV', align: 'r', render: (r) => rs(r.n ? r.nRev / r.n : 0) },
    { key: 'ra', head: 'Returning AOV', align: 'r', render: (r) => rs(r.r ? r.rRev / r.r : 0) },
  ];

  const totalRow: SRow = {
    store: 'ALL', n: yNew, r: yRep, nRev: yNewRev, rRev: yRepRev,
  };

  const newAov = yNew ? yNewRev / yNew : 0;
  const repAov = yRep ? yRepRev / yRep : 0;

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const repPct = pctOf(yRep, yTot);
  const series = complete.map(repeatShare);
  const tr = trend(series);

  if (repPct >= 55) {
    findings.push({
      severity: 'good',
      headline: `${repPct.toFixed(0)}% of orders came from someone who bought before`,
      detail: `${num(yRep)} of ${num(yTot)} orders, worth ${money(yRepRev)}. A repeat share this high means acquisition spend is compounding rather than renting demand.`,
    });
  } else if (repPct <= 35) {
    findings.push({
      severity: 'watch',
      headline: `Only ${repPct.toFixed(0)}% of orders were repeat buyers`,
      detail: `${num(yRep)} of ${num(yTot)}. The book is leaning on new acquisition, which is the expensive half.`,
      action: 'Worth checking the C1/C2 cohorts — the 0–45 day window is where repeat purchase actually happens.',
    });
  }

  if (tr != null && Math.abs(tr) > 2) {
    findings.push({
      severity: tr > 0 ? 'good' : 'watch',
      headline: `Repeat share is ${tr > 0 ? 'climbing' : 'slipping'}`,
      detail: `About ${Math.abs(tr).toFixed(1)}% per day across ${complete.length} days, ${series[0].toFixed(0)}% → ${series[series.length - 1].toFixed(0)}%.`,
    });
  }

  if (newAov > 0 && repAov / newAov >= 1.15) {
    findings.push({
      severity: 'good',
      headline: `Returning customers spend ${(repAov / newAov).toFixed(2)}× more per order`,
      detail: `${rs(repAov)} against ${rs(newAov)} on a first order. Every retained customer is worth more than the acquisition number alone suggests.`,
    });
  } else if (newAov > 0 && repAov / newAov <= 0.85) {
    findings.push({
      severity: 'watch',
      headline: `Returning baskets are smaller than first orders`,
      detail: `${rs(repAov)} against ${rs(newAov)}. Repeat buyers are topping up rather than buying the full set — an upsell gap rather than a retention one.`,
    });
  }

  return (
    <Page
      title="New vs Returning"
      subtitle={`${focus} · ${range.label} trend · matched on phone number against the full order history`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Orders" value={num(yTot)} sub={`${lakh(yNewRev + yRepRev)} attributed`} />
        <Stat
          label="Returning"
          value={pct(yTot ? (yRep / yTot) * 100 : 0)}
          sub={`${num(yRep)} orders · ${rs(yRepRev)}`}
          delta={(yTot ? (yRep / yTot) * 100 : 0) - avgRepeat}
          unit="pp"
        />
        <Stat label="New" value={pct(yTot ? (yNew / yTot) * 100 : 0)} sub={`${num(yNew)} orders · ${rs(yNewRev)}`} />
        <Stat
          label="Returning basket"
          value={newAov ? `${(repAov / newAov).toFixed(2)}×` : '–'}
          sub={`${rs(repAov)} vs ${rs(newAov)} for a first order`}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${focus}, ${num(yTot)} attributable orders`} />

      <Card title="Repeat share by day" note={`${range.label} average is ${pct(avgRepeat, 1)}; today excluded as partial`}>
        <Line
          fmt={(v) => `${v.toFixed(0)}%`}
          categories={complete.map(label)}
          series={[{ label: 'Returning % of orders', color: '#1baf7a', values: complete.map(repeatShare) }]}
          baseline={{ value: avgRepeat, label: `avg ${avgRepeat.toFixed(1)}%` }}
        />
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title={`${focus} mix`} note="by order count">
          <ShareBar
            fmt={num}
            parts={[
              { label: `Returning · ${rs(yRepRev)}`, value: yRep, color: '#1baf7a' },
              { label: `New · ${rs(yNewRev)}`, value: yNew, color: '#2a78d6' },
            ]}
          />
        </Card>
        <Card title="Repeat share by store" note={focus}>
          <BarList
            fmt={(v) => pct(v)}
            max={100}
            rows={srows.map((s) => ({
              label: storeLabel(s.store),
              value: s.n + s.r ? (s.r / (s.n + s.r)) * 100 : 0,
              sub: `${num(s.r)} of ${num(s.n + s.r)}`,
              color: '#1baf7a',
            }))}
          />
        </Card>
      </div>

      <Card title="By store" note={focus}>
        <Table cols={cols} rows={srows} footer={totalRow} />
      </Card>

      <Note>
        An order counts as returning when that phone number appears on an earlier order anywhere in
        the history, so the test runs against all 3.4M orders rather than the window on screen.
        Orders with no phone number are excluded rather than counted as new — defaulting them
        would inflate the new rate every time checkout dropped a number.
      </Note>
    </Page>
  );
}
