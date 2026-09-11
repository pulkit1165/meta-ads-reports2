import { campDays, roasOf, share, LOSING, bandOf, PORTAL_NAME } from '@/lib/ads';
import { resolveRange, resolveScope, istToday, type SearchParams } from '@/lib/range';
import { rank, money, pctOf, trend, type Finding } from '@/lib/insights';
import { Line, SERIES } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Rupees per thousand impressions. */
const cpm = (spend: number, impr: number) => (impr > 0 ? (spend / impr) * 1000 : 0);
const ctr = (clicks: number, impr: number) => (impr > 0 ? (clicks / impr) * 100 : 0);
const cpc = (spend: number, clicks: number) => (clicks > 0 ? spend / clicks : 0);
/** Revenue per thousand impressions — the other half of CPM. */
const rpm = (rev: number, impr: number) => (impr > 0 ? (rev / impr) * 1000 : 0);

export default async function OverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 60);
  const scope = resolveScope(sp);
  const controls = <PageControls range={range} scope={scope} />;
  const all = await campDays(range.from, range.to, scope.codes);

  if (!all.length) {
    return (
      <Page title="Ads Overview" subtitle={range.label} actions={controls}>
        <Note kind="warn">
          meta_analysis_campaign_daily returned nothing between {range.from} and {range.to}.
        </Note>
      </Page>
    );
  }

  const spent = all.filter((r) => r.spend > 0);
  const dates = [...new Set(spent.map((r) => r.date))].sort();
  const label = (d: string) => d.slice(8) + '/' + d.slice(5, 7);
  const on = (d: string) => spent.filter((r) => r.date === d);

  const totals = (rows: typeof spent) =>
    rows.reduce(
      (a, r) => ({
        spend: a.spend + r.spend,
        revenue: a.revenue + r.revenue,
        clicks: a.clicks + r.clicks,
        impressions: a.impressions + r.impressions,
      }),
      { spend: 0, revenue: 0, clicks: 0, impressions: 0 },
    );
  const tot = totals(spent);

  // Partial-ness is a fact about the clock: windows end at yesterday now, so
  // the last row is normally a settled day.
  const istNow = istToday();
  const complete = dates.filter((d) => d !== istNow).length
    ? dates.filter((d) => d !== istNow)
    : dates;
  const dayTot = (d: string) => totals(on(d));

  const series = complete.map(dayTot);
  const lastD = complete[complete.length - 1];
  const prevD = complete[complete.length - 2] ?? lastD;
  const L = dayTot(lastD), P = dayTot(prevD);

  type DRow = { date: string; spend: number; revenue: number; clicks: number; impressions: number };
  const drows: DRow[] = [...complete].reverse().map((d) => ({ date: d, ...dayTot(d) }));

  /* ── findings ───────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const cpmTrend = trend(series.map((s) => cpm(s.spend, s.impressions)));
  const ctrTrend = trend(series.map((s) => ctr(s.clicks, s.impressions)));

  if (cpmTrend != null && Math.abs(cpmTrend) > 1.5) {
    findings.push({
      severity: cpmTrend > 0 ? 'watch' : 'good',
      headline: `CPM is ${cpmTrend > 0 ? 'rising' : 'falling'} about ${Math.abs(cpmTrend).toFixed(1)}% a day`,
      detail: `${rs(cpm(series[0].spend, series[0].impressions))} → ${rs(cpm(L.spend, L.impressions))} per thousand impressions across ${complete.length} days.`,
      action: cpmTrend > 0
        ? 'Rising CPM with flat CTR means auction pressure, not creative fatigue. Rising CPM with falling CTR means the creative is tiring.'
        : undefined,
    });
  }
  if (ctrTrend != null && Math.abs(ctrTrend) > 2) {
    findings.push({
      severity: ctrTrend > 0 ? 'good' : 'watch',
      headline: `Click-through is ${ctrTrend > 0 ? 'improving' : 'declining'}`,
      detail: `${ctr(series[0].clicks, series[0].impressions).toFixed(2)}% → ${ctr(L.clicks, L.impressions).toFixed(2)}%, about ${Math.abs(ctrTrend).toFixed(1)}% a day.`,
      action: ctrTrend < 0 ? 'A falling CTR on stable CPM is the classic creative-fatigue signature.' : undefined,
    });
  }

  const rpmNow = rpm(L.revenue, L.impressions);
  const cpmNow = cpm(L.spend, L.impressions);
  findings.push({
    severity: rpmNow > cpmNow ? 'good' : 'critical',
    headline: rpmNow > cpmNow
      ? `Every thousand impressions earns ${rs(rpmNow - cpmNow)} more than it costs`
      : `Every thousand impressions costs ${rs(cpmNow - rpmNow)} more than it earns`,
    detail: `RPM ${rs(rpmNow)} against CPM ${rs(cpmNow)} on ${lastD}. This is ROAS restated per impression, which is where CPM and creative quality actually meet.`,
  });

  const losing = spent.filter((r) => LOSING.includes(bandOf(r.roas))).reduce((s, r) => s + r.spend, 0);
  findings.push({
    severity: pctOf(losing, tot.spend) >= 40 ? 'watch' : 'neutral',
    headline: `${pctOf(losing, tot.spend).toFixed(0)}% of spend across the window returned under 1.0`,
    detail: `${money(losing)} of ${money(tot.spend)} over ${dates.length} days.`,
  });

  const cols: Col<DRow>[] = [
    { key: 'd', head: 'Day', align: 'l', render: (r) => label(r.date) },
    { key: 's', head: 'Spend', align: 'r', render: (r) => rs(r.spend) },
    { key: 'i', head: 'Impressions', align: 'r', render: (r) => num(r.impressions) },
    { key: 'c', head: 'Clicks', align: 'r', render: (r) => num(r.clicks) },
    { key: 'm', head: 'CPM', align: 'r', render: (r) => rs(cpm(r.spend, r.impressions)) },
    { key: 't', head: 'CTR', align: 'r', render: (r) => `${ctr(r.clicks, r.impressions).toFixed(2)}%` },
    { key: 'pc', head: 'CPC', align: 'r', render: (r) => rs(cpc(r.spend, r.clicks)) },
    { key: 'rp', head: 'RPM', align: 'r', render: (r) => rs(rpm(r.revenue, r.impressions)) },
    { key: 'v', head: 'Revenue', align: 'r', render: (r) => rs(r.revenue) },
    { key: 'r', head: 'ROAS', align: 'r', render: (r) => <Roas v={roasOf(r.revenue, r.spend)} /> },
  ];

  const totalRow: DRow = { date: 'TOTAL', ...tot };

  return (
    <Page
      title="Ads Overview"
      subtitle={`${range.label} · ${scope.label} · delivery metrics alongside return`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat
          label="CPM"
          value={rs(cpm(tot.spend, tot.impressions))}
          sub={`per 1,000 impressions · ${num(tot.impressions)} served`}
          delta={cpm(P.spend, P.impressions) ? ((cpm(L.spend, L.impressions) / cpm(P.spend, P.impressions)) - 1) * 100 : null}
          tone="invert"
        />
        <Stat
          label="CTR"
          value={`${ctr(tot.clicks, tot.impressions).toFixed(2)}%`}
          sub={`${num(tot.clicks)} clicks`}
          delta={ctr(P.clicks, P.impressions) ? ((ctr(L.clicks, L.impressions) / ctr(P.clicks, P.impressions)) - 1) * 100 : null}
        />
        <Stat
          label="CPC"
          value={rs(cpc(tot.spend, tot.clicks))}
          sub="cost per click"
          delta={cpc(P.spend, P.clicks) ? ((cpc(L.spend, L.clicks) / cpc(P.spend, P.clicks)) - 1) * 100 : null}
          tone="invert"
        />
        <Stat
          label="ROAS"
          value={roasOf(tot.revenue, tot.spend).toFixed(3)}
          sub={`${lakh(tot.spend)} spent · ${lakh(tot.revenue)} back`}
        />
      </Grid>

      <Grid cols={4}>
        <Stat label="RPM" value={rs(rpm(tot.revenue, tot.impressions))} sub="revenue per 1,000 impressions" />
        <Stat
          label="Margin per 1,000"
          value={rs(rpm(tot.revenue, tot.impressions) - cpm(tot.spend, tot.impressions))}
          sub="RPM minus CPM"
        />
        <Stat
          label="Revenue per click"
          value={rs(tot.clicks ? tot.revenue / tot.clicks : 0)}
          sub={`against ${rs(cpc(tot.spend, tot.clicks))} to buy it`}
        />
        <Stat
          label="Campaign-days"
          value={num(spent.length)}
          sub={`${num(new Set(spent.map((r) => r.campaignId)).size)} campaigns over ${dates.length} days`}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${range.label}, ${num(spent.length)} campaign-days`} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="CPM vs RPM" note="what a thousand impressions costs, and what it earns">
          <Line
            fmt={(v) => rs(v)}
            categories={complete.map(label)}
            series={[
              { label: 'CPM (cost)', color: SERIES[1], values: series.map((s) => cpm(s.spend, s.impressions)) },
              { label: 'RPM (revenue)', color: SERIES[2], values: series.map((s) => rpm(s.revenue, s.impressions)) },
            ]}
          />
        </Card>
        <Card title="CTR and CPC" note="CTR as a percentage, CPC in rupees">
          <Line
            fmt={(v) => v.toFixed(1)}
            categories={complete.map(label)}
            series={[
              { label: 'CTR %', color: SERIES[0], values: series.map((s) => ctr(s.clicks, s.impressions)) },
              { label: 'CPC Rs', color: SERIES[3], values: series.map((s) => cpc(s.spend, s.clicks)) },
            ]}
          />
        </Card>
      </div>

      <Card title="Day by day" note="complete days only; today is excluded as partial">
        <Table cols={cols} rows={drows} footer={totalRow} />
      </Card>

      <Note>
        CPM, CTR and CPC come from the impressions and clicks Meta reports against each campaign.
        RPM is the same denominator applied to revenue, so RPM minus CPM is the margin on a
        thousand impressions — the number that says whether delivery is worth what it costs.
        Cost per acquisition is not shown: no Meta table here ingests a purchase count, so it would
        have to be inferred rather than measured.
      </Note>
    </Page>
  );
}
