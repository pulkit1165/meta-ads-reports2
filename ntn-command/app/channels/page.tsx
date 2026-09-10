import { channelsByDay, istDates, storeLabel } from '@/lib/commerce';
import { ShareBar, BarList, SERIES } from '@/components/charts';
import { Page, Card, Grid, Stat, Table, Note, lakh, rs, pct, num, type Col } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WINDOW = 14;

export default async function ChannelsPage() {
  const { today, yesterday } = await istDates();
  const from = new Date(new Date(today).getTime() - WINDOW * 86400000).toISOString().slice(0, 10);
  const rows = await channelsByDay(from, today);

  if (!rows.length) {
    return (
      <Page title="Channels" subtitle="No data">
        <Note kind="warn">No orders between {from} and {today}.</Note>
      </Page>
    );
  }

  const yday = rows.filter((r) => r.date === yesterday);
  const ord = (xs: typeof rows) => xs.reduce((s, r) => s + r.orders, 0);
  const rev = (xs: typeof rows) => xs.reduce((s, r) => s + r.revenue, 0);

  const chans = [...new Set(rows.map((r) => r.channel))];
  const stores = [...new Set(yday.map((r) => r.store))];

  type CRow = { channel: string; orders: number; revenue: number };
  const crows: CRow[] = chans
    .map((c) => {
      const mine = yday.filter((r) => r.channel === c);
      return { channel: c, orders: ord(mine), revenue: rev(mine) };
    })
    .filter((c) => c.orders > 0)
    .sort((a, b) => b.revenue - a.revenue);

  const yOrd = ord(yday), yRev = rev(yday);

  const cols: Col<CRow>[] = [
    { key: 'c', head: 'Channel', align: 'l', render: (r) => r.channel },
    { key: 'o', head: 'Orders', align: 'r', render: (r) => num(r.orders) },
    { key: 'os', head: '% of orders', align: 'r', render: (r) => pct(yOrd ? (r.orders / yOrd) * 100 : 0, 1) },
    { key: 'v', head: 'Revenue', align: 'r', render: (r) => rs(r.revenue) },
    { key: 'vs', head: '% of revenue', align: 'r', render: (r) => pct(yRev ? (r.revenue / yRev) * 100 : 0, 1) },
    { key: 'a', head: 'AOV', align: 'r', render: (r) => rs(r.orders ? r.revenue / r.orders : 0) },
  ];

  const totalRow: CRow = { channel: 'ALL', orders: yOrd, revenue: yRev };
  const storefront = rev(yday.filter((r) => r.channel === 'Headless storefront'));

  return (
    <Page title="Channels" subtitle={`Sales channel, ${yesterday} · from source_name`}>
      <Grid cols={3}>
        <Stat label="Orders yesterday" value={num(yOrd)} sub={lakh(yRev)} />
        <Stat label="Channels in use" value={num(crows.length)} sub="excluding the Matrixify importer" />
        <Stat
          label="Storefront share"
          value={pct(yRev ? (storefront / yRev) * 100 : 0, 1)}
          sub="of revenue through the headless storefront"
        />
      </Grid>

      <Card title="Channel mix" note={`${yesterday}, by revenue`}>
        <ShareBar
          fmt={rs}
          parts={crows.map((c, i) => ({ label: c.channel, value: c.revenue, color: SERIES[i % SERIES.length] }))}
        />
      </Card>

      <Card title="By store" note={`${yesterday}, revenue per store`}>
        <BarList
          fmt={rs}
          rows={stores
            .map((s, i) => ({
              label: storeLabel(s),
              value: rev(yday.filter((r) => r.store === s)),
              sub: `${num(ord(yday.filter((r) => r.store === s)))} orders`,
              color: SERIES[i % SERIES.length],
            }))
            .sort((a, b) => b.value - a.value)}
        />
      </Card>

      <Card title="Channel detail" note={yesterday}>
        <Table cols={cols} rows={crows} footer={totalRow} />
      </Card>

      <Note kind="warn">
        <b className="text-[#e8d3a8]">This is not an app-versus-website split, and it cannot be one
        yet.</b> The mobile app tags its carts with{' '}
        <span className="text-[#e8d3a8]">utm_medium=mobile_app</span>, but that marker lives in{' '}
        <span className="text-[#e8d3a8]">note_attributes</span> and{' '}
        <span className="text-[#e8d3a8]">landing_site</span>, and the ingest stores neither column,
        so every order in the warehouse reads as web. What{' '}
        <span className="text-[#e8d3a8]">source_name</span> does hold is the Shopify sales-channel
        id, which is what this page reports. Making the app split real needs one extra column at
        ingest, not a change on this page.
      </Note>
    </Page>
  );
}
