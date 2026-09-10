import { BANDS, cohortHistory, c1Inflow, frequency } from '@/lib/rfm';
import { ShareBar, Line, BarList, StackedBars } from '@/components/charts';
import { resolveScope, type SearchParams } from '@/lib/range';
import { rank, pctOf, type Finding } from '@/lib/insights';
import PageControls from '@/components/PageControls';
import { Page, Card, Grid, Stat, Table, Note, Analysis, lakh, rs, pct, num, Delta, type Col } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function RfmPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const scope = resolveScope(sp);
  const controls = <PageControls scope={scope} dates={false} />;
  const storeKey = scope.single ? scope.key : 'ALL';
  const storeFilter = scope.single ? scope.codes : [];
  const [hist, inflow, freq] = await Promise.all([
    cohortHistory(storeKey),
    c1Inflow(28, storeFilter),
    frequency(storeFilter),
  ]);

  const asOfs = [...new Set(hist.map((h) => h.asOf))].sort();
  const latest = asOfs[asOfs.length - 1];
  const now = hist.filter((h) => h.asOf === latest);

  if (!now.length) {
    return (
      <Page title="RFM Cohorts" subtitle="Snapshot not built yet" actions={controls}>
        <Note kind="warn">
          cohort_daily is empty. Sizes are snapshotted rather than derived live because computing a
          single as-of date costs about 19 seconds across 3.4M orders.
        </Note>
      </Page>
    );
  }

  const size = (band: string, at = latest) =>
    hist.find((h) => h.asOf === at && h.band === band)?.customers ?? 0;
  const revOf = (band: string, at = latest) =>
    hist.find((h) => h.asOf === at && h.band === band)?.revenue ?? 0;

  const total = now.reduce((s, h) => s + h.customers, 0);
  const warm = size('c1') + size('c2');

  // A comparison point roughly a quarter back, whichever snapshot is nearest.
  const older = asOfs.length > 1 ? asOfs[0] : null;
  const shiftPP = (band: string) =>
    older
      ? (size(band) / total) * 100 -
        (size(band, older) / hist.filter((h) => h.asOf === older).reduce((s, h) => s + h.customers, 0)) * 100
      : null;

  const label = (d: string) => d.slice(8) + '/' + d.slice(5, 7);

  type BRow = { key: string; label: string; blurb: string; customers: number; revenue: number };
  const brows: BRow[] = BANDS.map((b) => ({
    key: b.key, label: b.label, blurb: b.blurb,
    customers: size(b.key), revenue: revOf(b.key),
  }));

  const cols: Col<BRow>[] = [
    { key: 'b', head: 'Cohort', align: 'l', render: (r) => (
        <span>
          {r.label}
          <span className="ml-2 text-[11px] text-muted">{r.blurb}</span>
        </span>
      ) },
    { key: 'c', head: 'Customers', align: 'r', render: (r) => num(r.customers) },
    { key: 's', head: '% of base', align: 'r', render: (r) => pct((r.customers / total) * 100, 1) },
    { key: 'd', head: older ? `Shift since ${label(older)}` : 'Shift', align: 'r', render: (r) => {
        const v = shiftPP(r.key);
        return v == null ? <span className="text-muted">–</span> : <Delta v={v} tone="flat" unit="pp" />;
      } },
    { key: 'v', head: 'Lifetime revenue', align: 'r', render: (r) => lakh(r.revenue) },
    { key: 'a', head: 'Per customer', align: 'r', render: (r) => rs(r.customers ? r.revenue / r.customers : 0) },
  ];

  const oneTime = freq.find((f) => f.orders === 1);
  const freqTotal = freq.reduce((s, f) => s + f.customers, 0);

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const warmPct = pctOf(warm, total);
  const dormantPct = pctOf(size('c6'), total);
  const recent = inflow.slice(-14);
  const winBackShare = recent.reduce((s, i) => s + i.entered, 0)
    ? pctOf(recent.reduce((s, i) => s + i.reactivated, 0), recent.reduce((s, i) => s + i.entered, 0))
    : 0;

  if (dormantPct >= 50) {
    findings.push({
      severity: 'watch',
      headline: `${dormantPct.toFixed(0)}% of the base has not bought in over a year`,
      detail: `${num(size('c6'))} customers sit in C6. Prior cohort work found C6 win-back is low-yield for everything except crystals, which are bimodal.`,
      action: 'Treat C6 as a list to mine selectively, not a reactivation campaign to run wholesale.',
    });
  }

  if (warmPct <= 5) {
    findings.push({
      severity: 'watch',
      headline: `Only ${warmPct.toFixed(1)}% of the base is warm`,
      detail: `${num(warm)} customers bought within 45 days. C1+C2 is where roughly 55-60% of all future repurchases come from, so this is the pool worth working.`,
    });
  }

  if (oneTime && pctOf(oneTime.customers, freqTotal) >= 70) {
    findings.push({
      severity: 'critical',
      headline: `${pctOf(oneTime.customers, freqTotal).toFixed(0)}% of customers never bought twice`,
      detail: `${num(oneTime.customers)} of ${num(freqTotal)} have exactly one lifetime order. Every point of second-purchase rate is worth more than the same point of new acquisition.`,
      action: 'The 0-15 day window after a first order is the highest-yield intervention available.',
    });
  }

  if (winBackShare >= 15) {
    findings.push({
      severity: 'good',
      headline: `${winBackShare.toFixed(0)}% of recent intake was a win-back`,
      detail: 'Customers whose previous order was more than 45 days earlier. Genuine reactivation rather than regular repeat buying.',
    });
  }

  return (
    <Page
      title="RFM Cohorts"
      subtitle={`${scope.label} · recency bands as at ${latest} · ${num(total)} customers with a phone number on file`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Customer base" value={num(total)} sub="reachable, matched on phone" />
        <Stat
          label="Warm (C1+C2)"
          value={pct((warm / total) * 100, 1)}
          sub={`${num(warm)} bought in the last 45 days`}
          delta={shiftPP('c1') != null ? (shiftPP('c1') ?? 0) + (shiftPP('c2') ?? 0) : null}
          tone="flat"
          unit="pp"
        />
        <Stat
          label="Dormant (C6)"
          value={pct((size('c6') / total) * 100, 1)}
          sub={`${num(size('c6'))} have not bought in over a year`}
          delta={shiftPP('c6')}
          tone="flat"
          unit="pp"
        />
        <Stat
          label="One-time buyers"
          value={oneTime ? pct((oneTime.customers / freqTotal) * 100, 1) : '–'}
          sub={oneTime ? `${num(oneTime.customers)} never came back` : undefined}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${num(total)} customers as at ${latest}`} />

      <Card title="Where the base sits today" note={`as at ${latest}`}>
        <ShareBar
          fmt={num}
          parts={BANDS.map((b) => ({ label: b.label, value: size(b.key), color: b.color }))}
        />
      </Card>

      {asOfs.length > 1 && (
        <Card title="Which window is filling and which is draining" note="cohort sizes over time">
          <StackedBars
            height={220}
            fmt={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)))}
            categories={asOfs.map(label)}
            series={BANDS.map((b) => ({
              key: b.key, label: b.label, color: b.color,
              values: asOfs.map((a) => size(b.key, a)),
            }))}
          />
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {BANDS.map((b) => (
              <div key={b.key} className="flex items-center gap-1.5 text-[11px]">
                <span className="h-2 w-2 rounded-sm" style={{ background: b.color }} />
                <span className="text-text">{b.label}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="C1 intake" note="everyone who orders lands in C1 that day">
          <Line
            fmt={num}
            categories={inflow.map((i) => label(i.date))}
            series={[
              { label: 'Entered C1', color: '#1baf7a', values: inflow.map((i) => i.entered) },
              { label: 'Of which win-backs (>45d cold)', color: '#eb6834', values: inflow.map((i) => i.reactivated) },
            ]}
          />
        </Card>
        <Card title="Purchase frequency" note="lifetime orders per customer">
          <BarList
            fmt={num}
            rows={freq.map((f) => ({
              label: f.orders >= 6 ? '6+ orders' : `${f.orders} order${f.orders > 1 ? 's' : ''}`,
              value: f.customers,
              sub: pct((f.customers / freqTotal) * 100, 1),
              color: f.orders === 1 ? '#7c2b26' : '#2a78d6',
            }))}
          />
        </Card>
      </div>

      <Card title="Cohort detail" note={`as at ${latest}`}>
        <Table cols={cols} rows={brows} />
      </Card>

      <Note>
        Bands are the ones the WhatsApp cohort work already uses, so a list pulled here describes
        the same people as a list pulled there. Sizes are snapshotted into{' '}
        <span className="text-text">cohort_daily</span> rather than computed on the page: a
        single as-of date costs about 19 seconds across 3.4M orders, because there is no index on
        the phone number and it has to be normalised row by row. The trend deepens as snapshots
        accumulate.
      </Note>
    </Page>
  );
}
