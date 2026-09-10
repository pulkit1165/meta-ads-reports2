import { repeatRate, istDates, storeLabel } from '@/lib/commerce';
import { Line, ShareBar, BarList } from '@/components/charts';
import { Page, Card, Grid, Stat, Table, Note, lakh, rs, pct, num, type Col } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WINDOW = 21;

export default async function CohortsPage() {
  const { today, yesterday } = await istDates();
  const from = new Date(new Date(today).getTime() - WINDOW * 86400000).toISOString().slice(0, 10);
  const rows = await repeatRate(from, today);

  if (!rows.length) {
    return (
      <Page title="New vs Returning" subtitle="No data">
        <Note kind="warn">No attributable orders between {from} and {today}.</Note>
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

  const yday = on(yesterday);
  const yNew = sum(yday, 'newOrders'), yRep = sum(yday, 'repeatOrders');
  const yNewRev = sum(yday, 'newRevenue'), yRepRev = sum(yday, 'repeatRevenue');
  const yTot = yNew + yRep;

  // Complete days only for the trend — today is still filling.
  const complete = dates.filter((d) => d !== today);
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

  return (
    <Page
      title="New vs Returning"
      subtitle={`Yesterday, ${yesterday} · ${WINDOW}-day trend · matched on phone number against the full order history`}
    >
      <Grid cols={4}>
        <Stat label="Orders yesterday" value={num(yTot)} sub={`${lakh(yNewRev + yRepRev)} attributed`} />
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

      <Card title="Repeat share by day" note={`${WINDOW}-day average is ${pct(avgRepeat, 1)}; today excluded as partial`}>
        <Line
          fmt={(v) => `${v.toFixed(0)}%`}
          categories={complete.map(label)}
          series={[{ label: 'Returning % of orders', color: '#1baf7a', values: complete.map(repeatShare) }]}
          baseline={{ value: avgRepeat, label: `avg ${avgRepeat.toFixed(1)}%` }}
        />
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="Yesterday's mix" note="by order count">
          <ShareBar
            fmt={num}
            parts={[
              { label: `Returning · ${rs(yRepRev)}`, value: yRep, color: '#1baf7a' },
              { label: `New · ${rs(yNewRev)}`, value: yNew, color: '#2a78d6' },
            ]}
          />
        </Card>
        <Card title="Repeat share by store" note={yesterday}>
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

      <Card title="By store" note={yesterday}>
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
