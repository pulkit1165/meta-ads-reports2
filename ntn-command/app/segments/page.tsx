import { SEGMENTS, segments, productRepeat, repeatGaps } from '@/lib/rfm';
import { resolveScope, type SearchParams } from '@/lib/range';
import { rank, money, pctOf, type Finding } from '@/lib/insights';
import { ShareBar, BarList } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Note, Analysis, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const COLOR = Object.fromEntries(SEGMENTS.map((s) => [s.key, s.color])) as Record<string, string>;
const BLURB = Object.fromEntries(SEGMENTS.map((s) => [s.key, s.blurb])) as Record<string, string>;
const ORDER: string[] = SEGMENTS.map((s) => s.key);

export default async function SegmentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const scope = resolveScope(sp);
  const controls = <PageControls scope={scope} dates={false} />;
  const filter = scope.single ? scope.codes : [];

  const [segs, prods, gaps] = await Promise.all([
    segments(filter),
    productRepeat(filter, 30),
    repeatGaps(filter),
  ]);

  if (!segs.length) {
    return (
      <Page title="Customer Segments" subtitle={scope.label} actions={controls}>
        <Note kind="warn">customer_lifetime returned nothing for {scope.label}.</Note>
      </Page>
    );
  }

  const ordered = [...segs].sort((a, b) => ORDER.indexOf(a.segment) - ORDER.indexOf(b.segment));
  const total = segs.reduce((s, r) => s + r.customers, 0);
  const totalRev = segs.reduce((s, r) => s + r.revenue, 0);
  const get = (k: string) => segs.find((s) => s.segment === k);

  const vip = get('VIP'), loyal = get('Loyal'), atRisk = get('At risk'), cantLose = get('Cannot lose');
  const valuable = ['VIP', 'Loyal', 'Big spender'].reduce((s, k) => s + (get(k)?.customers ?? 0), 0);
  const valuableRev = ['VIP', 'Loyal', 'Big spender'].reduce((s, k) => s + (get(k)?.revenue ?? 0), 0);

  const gapTotal = gaps.reduce((s, g) => s + g.orders, 0);
  const c1 = gaps.find((g) => g.bucket.startsWith('c1'));

  /* ── findings ───────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];

  if (vip) {
    findings.push({
      severity: 'good',
      headline: `${num(vip.customers)} VIPs carry ${pctOf(vip.revenue, totalRev).toFixed(0)}% of lifetime revenue`,
      detail: `They are ${pctOf(vip.customers, total).toFixed(1)}% of the base, averaging ${vip.avgOrders.toFixed(1)} orders and ${rs(vip.avgValue)} each, last seen ${Math.round(vip.avgRecency)} days ago.`,
    });
  }

  if (atRisk && atRisk.customers > 0) {
    findings.push({
      severity: 'critical',
      headline: `${num(atRisk.customers)} good customers have gone quiet`,
      detail: `"At risk" means 3+ orders but nothing for 90–365 days. They average ${atRisk.avgOrders.toFixed(1)} orders and ${rs(atRisk.avgValue)} lifetime, worth ${money(atRisk.revenue)} in total, and are ${Math.round(atRisk.avgRecency)} days silent on average.`,
      action: 'This is the highest-yield list in the business: they have already proven they buy repeatedly, and they have not left yet.',
    });
  }

  if (cantLose && cantLose.customers > 0) {
    findings.push({
      severity: 'watch',
      headline: `${num(cantLose.customers)} top-value customers have been silent over a year`,
      detail: `${money(cantLose.revenue)} of lifetime revenue, averaging ${rs(cantLose.avgValue)} each. Prior cohort work found win-back past a year is low-yield for everything except crystals.`,
      action: 'Worth a targeted attempt rather than a broadcast — the volume is large enough that a blanket campaign wastes most of it.',
    });
  }

  if (c1 && gapTotal) {
    findings.push({
      severity: 'neutral',
      headline: `${pctOf(c1.orders, gapTotal).toFixed(0)}% of repeat orders land within 15 days`,
      detail: `Of ${num(gapTotal)} repeat purchases, ${num(c1.orders)} came inside a fortnight of the previous one. The window decays sharply after that.`,
      action: 'The fortnight after any order is when a second one is most likely. That is where a follow-up earns most.',
    });
  }

  const topReorder = prods[0];
  if (topReorder) {
    findings.push({
      severity: 'good',
      headline: `${topReorder.title} is the most re-bought product`,
      detail: `${topReorder.reorderRate.toFixed(1)}% of its ${num(topReorder.buyers)} buyers ordered it again on a separate order — ${num(topReorder.reorders)} people.`,
      action: 'A high reorder rate is a subscription candidate, not just a good product.',
    });
  }

  /* ── tables ─────────────────────────────────────────────────────────────── */
  const segCols: Col<(typeof segs)[number]>[] = [
    { key: 's', head: 'Segment', align: 'l', render: (r) => (
        <span className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: COLOR[r.segment] ?? '#888' }} />
          <span className="font-medium">{r.segment}</span>
          <span className="text-[11px] text-muted">{BLURB[r.segment]}</span>
        </span>
      ) },
    { key: 'c', head: 'Customers', align: 'r', render: (r) => num(r.customers) },
    { key: 'p', head: '% of base', align: 'r', render: (r) => pct(pctOf(r.customers, total), 1) },
    { key: 'v', head: 'Lifetime revenue', align: 'r', render: (r) => lakh(r.revenue) },
    { key: 'vp', head: '% of revenue', align: 'r', render: (r) => pct(pctOf(r.revenue, totalRev), 1) },
    { key: 'ao', head: 'Avg orders', align: 'r', render: (r) => r.avgOrders.toFixed(1) },
    { key: 'av', head: 'Avg value', align: 'r', render: (r) => rs(r.avgValue) },
    { key: 'ar', head: 'Days since last', align: 'r', render: (r) => num(r.avgRecency) },
  ];

  const prodCols: Col<(typeof prods)[number]>[] = [
    { key: 'r', head: '#', align: 'l', render: (p) => (
        <span className="text-muted">{prods.indexOf(p) + 1}</span>
      ) },
    { key: 't', head: 'Product', align: 'l', render: (p) => (
        <span className="block max-w-[320px] truncate" title={`${p.title} · ${p.sku}`}>{p.title}</span>
      ) },
    { key: 'b', head: 'Buyers', align: 'r', render: (p) => num(p.buyers) },
    { key: 'ro', head: 'Bought again', align: 'r', render: (p) => num(p.reorders) },
    { key: 'rr', head: 'Reorder rate', align: 'r', render: (p) => (
        <span className={p.reorderRate >= 15 ? 'text-good' : ''}>{pct(p.reorderRate, 1)}</span>
      ) },
    { key: 'u', head: 'Units', align: 'r', render: (p) => num(p.units) },
    { key: 'v', head: 'Revenue', align: 'r', render: (p) => lakh(p.revenue) },
  ];

  return (
    <Page
      title="Customer Segments"
      subtitle={`${scope.label} · ${num(total)} customers scored on recency, frequency and value`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Customers" value={num(total)} sub={`${lakh(totalRev)} lifetime revenue`} />
        <Stat
          label="VIP + Loyal"
          value={num((vip?.customers ?? 0) + (loyal?.customers ?? 0))}
          sub={`${pct(pctOf((vip?.revenue ?? 0) + (loyal?.revenue ?? 0), totalRev), 1)} of all revenue`}
        />
        <Stat
          label="Valuable base"
          value={pct(pctOf(valuable, total), 1)}
          sub={`${num(valuable)} customers holding ${pct(pctOf(valuableRev, totalRev), 1)} of revenue`}
        />
        <Stat
          label="At risk"
          value={num(atRisk?.customers ?? 0)}
          sub={atRisk ? `${lakh(atRisk.revenue)} of proven repeat buyers gone quiet` : undefined}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${num(total)} customers · ${scope.label}`} />

      <Card title="Where the base sits" note="by customer count">
        <ShareBar
          fmt={num}
          parts={ordered.map((r) => ({ label: r.segment, value: r.customers, color: COLOR[r.segment] ?? '#888' }))}
        />
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="Revenue by segment" note="lifetime value held in each">
          <BarList
            fmt={rs}
            rows={[...ordered].sort((a, b) => b.revenue - a.revenue).map((r) => ({
              label: r.segment,
              value: r.revenue,
              sub: `${num(r.customers)} people`,
              color: COLOR[r.segment] ?? '#888',
            }))}
          />
        </Card>
        <Card title="How long returning customers wait" note="gap between one order and the next">
          <BarList
            fmt={num}
            rows={gaps.map((g) => ({
              label: g.bucket,
              value: g.orders,
              sub: pct(pctOf(g.orders, gapTotal), 1),
              color: '#1baf7a',
            }))}
          />
        </Card>
      </div>

      <Card title="Every segment" note="scored on recency, order count and lifetime value">
        <Table cols={segCols} rows={ordered} />
      </Card>

      <Card title="Most re-bought products" note="ranked by the share of buyers who ordered it again, minimum 200 buyers">
        <Table cols={prodCols} rows={prods} />
      </Card>

      <Note>
        Frequency is banded on the actual order count rather than quintiled: roughly three quarters
        of this base has exactly one order, so quintiles would put most customers in the same
        bucket and call it a distribution. Recency uses the same windows as the C1–C6 cohorts, so a
        customer&apos;s segment and their cohort never disagree. Reorder rate counts buyers who
        bought the same product on a <b className="text-text-strong">separate order</b> — buying
        three at once is not a reorder.
      </Note>
    </Page>
  );
}
