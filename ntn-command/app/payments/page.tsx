import { paymentsByDay, isCOD, istDates, storeLabel } from '@/lib/commerce';
import { ShareBar, Line, BarList } from '@/components/charts';
import { Page, Card, Grid, Stat, Table, Note, lakh, rs, pct, num, type Col } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WINDOW = 14;

export default async function PaymentsPage() {
  const { today, yesterday } = await istDates();
  const from = new Date(new Date(today).getTime() - WINDOW * 86400000).toISOString().slice(0, 10);
  const rows = await paymentsByDay(from, today);

  if (!rows.length) {
    return (
      <Page title="Payments" subtitle="No orders in the window">
        <Note kind="warn">shopify_orders returned nothing between {from} and {today}.</Note>
      </Page>
    );
  }

  const yday = rows.filter((r) => r.date === yesterday);
  const rev = (rs_: typeof rows) => rs_.reduce((s, r) => s + r.revenue, 0);
  const ord = (rs_: typeof rows) => rs_.reduce((s, r) => s + r.orders, 0);

  const yRev = rev(yday), yOrd = ord(yday);
  const yCod = yday.filter((r) => isCOD(r.mode));
  const yPre = yday.filter((r) => !isCOD(r.mode));
  const codRev = rev(yCod), preRev = rev(yPre);
  const codOrd = ord(yCod), preOrd = ord(yPre);

  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const label = (d: string) => d.slice(8) + '/' + d.slice(5, 7);
  const codShareOn = (d: string) => {
    const day = rows.filter((r) => r.date === d);
    const t = rev(day);
    return t ? (rev(day.filter((r) => isCOD(r.mode))) / t) * 100 : 0;
  };

  const stores = [...new Set(yday.map((r) => r.store))];
  type SRow = { store: string; orders: number; revenue: number; cod: number; codOrders: number };
  const srows: SRow[] = stores.map((s) => {
    const mine = yday.filter((r) => r.store === s);
    const c = mine.filter((r) => isCOD(r.mode));
    return {
      store: s, orders: ord(mine), revenue: rev(mine),
      cod: rev(c), codOrders: ord(c),
    };
  }).sort((a, b) => b.revenue - a.revenue);

  const cols: Col<SRow>[] = [
    { key: 's', head: 'Store', align: 'l', render: (r) => storeLabel(r.store) },
    { key: 'o', head: 'Orders', align: 'r', render: (r) => num(r.orders) },
    { key: 'v', head: 'Revenue', align: 'r', render: (r) => rs(r.revenue) },
    { key: 'a', head: 'AOV', align: 'r', render: (r) => rs(r.orders ? r.revenue / r.orders : 0) },
    { key: 'p', head: 'Prepaid', align: 'r', render: (r) => rs(r.revenue - r.cod) },
    { key: 'po', head: 'Prepaid orders', align: 'r', render: (r) => num(r.orders - r.codOrders) },
    { key: 'c', head: 'COD', align: 'r', render: (r) => rs(r.cod) },
    { key: 'co', head: 'COD orders', align: 'r', render: (r) => num(r.codOrders) },
    { key: 'cp', head: 'COD % of value', align: 'r', render: (r) => (
        <span className={r.revenue && r.cod / r.revenue > 0.35 ? 'text-warn' : ''}>
          {pct(r.revenue ? (r.cod / r.revenue) * 100 : 0)}
        </span>
      ) },
  ];

  const totalRow: SRow = {
    store: 'ALL', orders: yOrd, revenue: yRev, cod: codRev, codOrders: codOrd,
  };

  // COD orders are smaller or larger than prepaid? A real operational signal.
  const codAov = codOrd ? codRev / codOrd : 0;
  const preAov = preOrd ? preRev / preOrd : 0;

  return (
    <Page title="Payments" subtitle={`Yesterday, ${yesterday} · ${WINDOW}-day trend · cancelled and Matrixify re-imports excluded`}>
      <Grid cols={4}>
        <Stat label="Orders yesterday" value={num(yOrd)} sub={`${lakh(yRev)} · AOV ${rs(yOrd ? yRev / yOrd : 0)}`} />
        <Stat label="Prepaid" value={pct(yRev ? (preRev / yRev) * 100 : 0)} sub={`${rs(preRev)} · ${num(preOrd)} orders`} />
        <Stat label="COD" value={pct(yRev ? (codRev / yRev) * 100 : 0)} sub={`${rs(codRev)} · ${num(codOrd)} orders`} />
        <Stat
          label="COD basket vs prepaid"
          value={preAov ? `${(codAov / preAov).toFixed(2)}×` : '–'}
          sub={`COD AOV ${rs(codAov)} · prepaid ${rs(preAov)}`}
        />
      </Grid>

      <Card title="Prepaid vs COD" note={`${yesterday}, by revenue`}>
        <ShareBar
          fmt={rs}
          parts={[
            { label: `Prepaid · ${num(preOrd)} orders`, value: preRev, color: '#1baf7a' },
            { label: `COD · ${num(codOrd)} orders`, value: codRev, color: '#eb6834' },
          ]}
        />
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="COD share by day" note="% of revenue taken as cash on delivery">
          <Line
            fmt={(v) => `${v.toFixed(0)}%`}
            categories={dates.map(label)}
            series={[{ label: 'COD % of revenue', color: '#eb6834', values: dates.map(codShareOn) }]}
          />
        </Card>
        <Card title="COD share by store" note={`${yesterday}, % of that store's revenue`}>
          <BarList
            fmt={(v) => pct(v)}
            max={100}
            rows={srows.map((s) => ({
              label: storeLabel(s.store),
              value: s.revenue ? (s.cod / s.revenue) * 100 : 0,
              sub: `${rs(s.cod)} of ${rs(s.revenue)}`,
              color: '#eb6834',
            }))}
          />
        </Card>
      </div>

      <Card title="By store" note={yesterday}>
        <Table cols={cols} rows={srows} footer={totalRow} />
      </Card>

      <Note>
        <span className="text-[#c3ccd7]">payment_gateway</span> is empty on every row in this
        database — checked across a full quarter of orders — so there is no per-processor split to
        show. The prepaid/COD cut comes from{' '}
        <span className="text-[#c3ccd7]">payment_mode</span>, which is populated on every order.
        Processor-level detail would have to be pulled from the Shopify API; it is not stored here.
      </Note>
    </Page>
  );
}
