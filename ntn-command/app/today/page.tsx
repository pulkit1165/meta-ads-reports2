import { todayRead, delta, pctOf, type SiteNow, type HourRow } from '@/lib/today';
import { roasOf } from '@/lib/ads';
import { resolveScope, type SearchParams } from '@/lib/range';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Delta, Note, rs, lakh, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function TodayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const scope = resolveScope(sp);
  const read = await todayRead(scope.codes);

  // The date picker is meaningless here — this module is only ever "now".
  const controls = <PageControls scope={scope} dates={false} />;

  if (!read.sites.length) {
    return (
      <Page title="Today's ROAS" subtitle="no campaign snapshot yet today" actions={controls}>
        <Note kind="warn">
          Nothing in <span className="text-warn">meta_campaign_snapshot</span> for today. The pipeline
          writes one every half hour, so an empty read after 01:00 IST means it is stuck rather than
          that nothing is running.
        </Note>
      </Page>
    );
  }

  const T = read.sites.reduce(
    (a, s) => ({
      sales: a.sales + s.sales, orders: a.orders + s.orders, spend: a.spend + s.spend,
      ySales: a.ySales + s.ySales, yOrders: a.yOrders + s.yOrders, ySpend: a.ySpend + s.ySpend,
      budgetLive: a.budgetLive + s.budgetLive, budgetLeft: a.budgetLeft + s.budgetLeft,
      allocated: a.allocated + s.allocated, closedBudget: a.closedBudget + s.closedBudget,
      camps: a.camps + s.camps, activeCamps: a.activeCamps + s.activeCamps,
      products: a.products + s.products,
    }),
    { sales: 0, orders: 0, spend: 0, ySales: 0, yOrders: 0, ySpend: 0, budgetLive: 0,
      budgetLeft: 0, allocated: 0, closedBudget: 0, camps: 0, activeCamps: 0, products: 0 },
  );
  const totalRow: SiteNow = {
    portal: 'all', name: 'All', ...T,
    roas: roasOf(T.sales, T.spend),
    yRoas: roasOf(T.ySales, T.ySpend),
    ydayFinal: read.sites.reduce((a, s) => a + s.ydayFinal * s.ySpend, 0) / Math.max(T.ySpend, 1),
  };

  const money = (v: number) => <span className="tabular-nums">{rs(v)}</span>;

  const cols: Col<SiteNow>[] = [
    { key: 'w', head: 'Website', align: 'l', render: (s) => (
        <span className={s.portal === 'all' ? 'font-medium' : ''}>{s.name}</span>
      ) },
    { key: 's', head: 'Sales', align: 'r', render: (s) => (
        <span className="whitespace-nowrap">{money(s.sales)}{' '}
          <Delta v={delta(s.sales, s.ySales)} tone="auto" /></span>
      ) },
    { key: 'o', head: 'Orders', align: 'r', render: (s) => (
        <span className="whitespace-nowrap">{num(s.orders)}{' '}
          <Delta v={delta(s.orders, s.yOrders)} tone="auto" /></span>
      ) },
    { key: 'sp', head: 'Spend', align: 'r', render: (s) => (
        <span className="whitespace-nowrap">{money(s.spend)}{' '}
          <Delta v={delta(s.spend, s.ySpend)} tone="flat" /></span>
      ) },
    { key: 'r', head: 'ROAS', align: 'r', render: (s) => (
        <span className="whitespace-nowrap"><Roas v={s.roas} />{' '}
          <Delta v={delta(s.roas, s.yRoas)} tone="auto" /></span>
      ) },
    { key: 'yf', head: 'Yday final', align: 'r', render: (s) => (
        <span className="tabular-nums text-muted">{s.ydayFinal.toFixed(2)}</span>
      ) },
    { key: 'bl', head: 'Budget live', align: 'r', render: (s) => money(s.budgetLive) },
    { key: 'bf', head: 'Budget left', align: 'r', render: (s) => money(s.budgetLeft) },
    { key: 'lp', head: 'Left %', align: 'r', render: (s) => (
        <span className="text-muted">{pct(pctOf(s.budgetLeft, s.budgetLive))}</span>
      ) },
    { key: 'ac', head: 'Active %', align: 'r', render: (s) => (
        <span title={`${s.activeCamps} of ${s.camps} campaigns still on`}>
          {pct(pctOf(s.activeCamps, s.camps))}
        </span>
      ) },
    { key: 'dp', head: 'Day %', align: 'r', render: (s) => (
        <span title="spend against the whole allocated book">{pct(pctOf(s.spend, s.allocated))}</span>
      ) },
    { key: 'cb', head: 'Closed', align: 'r', render: (s) => money(s.closedBudget) },
    { key: 'cp', head: 'Closed %', align: 'r', render: (s) => (
        <span className={pctOf(s.closedBudget, s.allocated) >= 60 ? 'text-warn' : ''}>
          {pct(pctOf(s.closedBudget, s.allocated))}
        </span>
      ) },
    { key: 'p', head: 'Products', align: 'r', render: (s) => num(s.products) },
  ];

  const hourCols: Col<HourRow>[] = [
    { key: 'w', head: 'Website', align: 'l', render: (h) => h.name },
    { key: 's', head: 'Sales', align: 'r', render: (h) => (
        <span className="whitespace-nowrap">{money(h.sales)}{' '}
          <Delta v={delta(h.sales, h.pSales)} tone="auto" /></span>
      ) },
    { key: 'o', head: 'Orders', align: 'r', render: (h) => (
        <span className="whitespace-nowrap">{num(h.orders)}{' '}
          <Delta v={delta(h.orders, h.pOrders)} tone="auto" /></span>
      ) },
    { key: 'b', head: 'Budget live', align: 'r', render: (h) => money(h.budgetLive) },
  ];
  const hourTotal: HourRow = {
    portal: 'all', name: 'All', spend: 0, roas: 0, pSpend: 0, pRoas: 0,
    sales: read.hours.reduce((a, h) => a + h.sales, 0),
    orders: read.hours.reduce((a, h) => a + h.orders, 0),
    budgetLive: T.budgetLive,
    pSales: read.hours.reduce((a, h) => a + h.pSales, 0),
    pOrders: read.hours.reduce((a, h) => a + h.pOrders, 0),
  };

  return (
    <Page
      title="Today&rsquo;s ROAS"
      subtitle={`live at ${read.cutIST} IST · against the same time yesterday · ${scope.label}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Sales" value={lakh(T.sales)} sub={`${num(T.orders)} orders`}
              delta={delta(T.sales, T.ySales)} />
        <Stat label="Spend" value={lakh(T.spend)} sub={`of ${lakh(T.allocated)} allocated`}
              delta={delta(T.spend, T.ySpend)} tone="flat" />
        <Stat label="ROAS" value={totalRow.roas.toFixed(2)}
              sub={`${totalRow.yRoas.toFixed(2)} at this hour yesterday · ${totalRow.ydayFinal.toFixed(2)} by its end`}
              delta={delta(totalRow.roas, totalRow.yRoas)} />
        <Stat label="Budget still live" value={lakh(T.budgetLive)}
              sub={`${lakh(T.budgetLeft)} of it unspent · ${pct(pctOf(T.closedBudget, T.allocated))} of the book closed`} />
      </Grid>

      <Card
        title="Today so far"
        note={`against the same clock time yesterday · sales from Shopify with cancellations excluded, spend from Meta`}
      >
        <Table cols={cols} rows={read.sites} footer={totalRow} />
      </Card>

      <Card
        title={`Last complete hour · ${read.hourLabel}`}
        note="against the hour before it"
      >
        <Table cols={hourCols} rows={read.hours} footer={hourTotal} />
      </Card>

      <Note>
        <b className="text-text-strong">Everything is cut at the same clock time.</b> At{' '}
        {read.cutIST} the day is part-finished, so comparing it with yesterday&apos;s final numbers
        would report a collapse that has not happened. Yesterday is read at {read.cutIST} too, and{' '}
        <span className="text-text">Yday final</span> is where that day actually ended — the gap
        between the two is roughly what today still has left to earn.
        {' '}<b className="text-text-strong">ROAS here is shop revenue over ad spend</b>, not
        Meta&apos;s attributed figure, which counts conversions the shop never recorded.
        {' '}<b className="text-text-strong">Day %</b> is spend against the whole allocated book and{' '}
        <b className="text-text-strong">Left %</b> is the unspent share of what is still switched on.
        {' '}The hourly table carries sales and orders only: hourly spend would need two campaign
        snapshots bracketing the hour and they arrive 30–60 minutes apart, so it is left out rather
        than estimated into something that looks measured.
      </Note>
    </Page>
  );
}
