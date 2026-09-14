import {
  campDays, productMap, creativeTags, roasOf, share,
  LOSING, bandOf, PORTAL_NAME,
} from '@/lib/ads';
import { resolveRange, resolveScope, istToday, weekday, isWeekend, type SearchParams } from '@/lib/range';
import { rank, money, pctOf, trend, steadiness, type Finding } from '@/lib/insights';
import { Line, BarList, SERIES } from '@/components/charts';
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
  const [all, pmap] = await Promise.all([
    campDays(range.from, range.to, scope.codes),
    productMap(),
  ]);

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


  /* ── breakdowns: product, sale block, creative ────────────────────────── */
  type Cut = {
    key: string; days: number; spend: number; revenue: number;
    clicks: number; impressions: number; winners: number;
  };
  function cutBy(keyOf: (r: (typeof spent)[number]) => string[]): Cut[] {
    const m = new Map<string, Cut>();
    for (const r of spent) {
      for (const k of keyOf(r)) {
        const c = m.get(k) ?? {
          key: k, days: 0, spend: 0, revenue: 0, clicks: 0, impressions: 0, winners: 0,
        };
        c.days += 1;
        c.spend += r.spend;
        c.revenue += r.revenue;
        c.clicks += r.clicks;
        c.impressions += r.impressions;
        if (r.roas >= 1) c.winners += 1;
        m.set(k, c);
      }
    }
    return [...m.values()].sort((a, b) => b.spend - a.spend);
  }

  const byProduct = cutBy((r) => [pmap.get(r.campaignId) ?? 'unmapped']);
  const byBlock = cutBy((r) => [r.saleBlock]);
  const byCreative = cutBy((r) => creativeTags(r.creativeType));

  /* ── volatility: which things hold a KPI steady, and which swing ───────── */
  // Daily ROAS per campaign and per block, across the window.
  function dailySeries(keyOf: (r: (typeof spent)[number]) => string) {
    const m = new Map<string, Map<string, { spend: number; rev: number }>>();
    for (const r of spent) {
      const k = keyOf(r);
      const byDay = m.get(k) ?? new Map<string, { spend: number; rev: number }>();
      const d = byDay.get(r.date) ?? { spend: 0, rev: 0 };
      d.spend += r.spend;
      d.rev += r.revenue;
      byDay.set(r.date, d);
      m.set(k, byDay);
    }
    return [...m.entries()].map(([key, byDay]) => ({
      key,
      spend: [...byDay.values()].reduce((s2, d) => s2 + d.spend, 0),
      series: [...byDay.values()].filter((d) => d.spend > 0).map((d) => d.rev / d.spend),
    }));
  }

  // Only things carrying real money: a steadiness ranking led by campaigns
  // spending a few hundred rupees would be arithmetically true and useless.
  const VOL_MIN_SPEND = 20000;
  const campSeries = dailySeries((r) => r.campaignName || r.campaignId)
    .filter((x) => x.spend >= VOL_MIN_SPEND);
  const blockSeries = dailySeries((r) => r.saleBlock)
    .filter((x) => x.spend >= VOL_MIN_SPEND);

  const campVol = steadiness(campSeries, (x) => x.key, (x) => x.series, 5);
  const blockVol = steadiness(blockSeries, (x) => x.key, (x) => x.series, 5);

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

  if (blockVol.erratic.length) {
    const e = blockVol.erratic[0];
    findings.push({
      severity: 'watch',
      headline: `${e.key.slice(0, 52)} is the most erratic block`,
      detail: `Its daily ROAS swings ±${e.cvPct.toFixed(0)}% around a mean of ${e.mean.toFixed(2)} across ${e.points} days. A block this unsteady cannot be planned around even when its average looks acceptable.`,
    });
  }
  if (blockVol.steady.length) {
    const st = blockVol.steady[0];
    findings.push({
      severity: st.mean >= 1 ? 'good' : 'neutral',
      headline: `${st.key.slice(0, 52)} is the steadiest block`,
      detail: `Daily ROAS varies only ±${st.cvPct.toFixed(0)}% around ${st.mean.toFixed(2)} over ${st.points} days.`,
      action: st.mean >= 1
        ? 'Steady and above break-even is the profile worth scaling — the return is predictable, not lucky.'
        : 'Steady but below break-even means it reliably loses money. Predictability is not the same as working.',
    });
  }

  const cutCols = (label: string, total: number): Col<Cut>[] => [
    { key: 'k', head: label, align: 'l', render: (c) => (
        <span className={`block max-w-[300px] truncate ${c.key === 'unmapped' ? 'text-muted' : ''}`} title={c.key}>
          {c.key}
        </span>
      ) },
    { key: 'd', head: 'Camp-days', align: 'r', render: (c) => num(c.days) },
    { key: 's', head: 'Spend', align: 'r', render: (c) => rs(c.spend) },
    { key: 'sh', head: '% of spend', align: 'r', render: (c) => pct(share(c.spend, total), 1) },
    { key: 'i', head: 'Impressions', align: 'r', render: (c) => num(c.impressions) },
    { key: 'm', head: 'CPM', align: 'r', render: (c) => rs(cpm(c.spend, c.impressions)) },
    { key: 't', head: 'CTR', align: 'r', render: (c) => `${ctr(c.clicks, c.impressions).toFixed(2)}%` },
    { key: 'pc', head: 'CPC', align: 'r', render: (c) => rs(cpc(c.spend, c.clicks)) },
    { key: 'rp', head: 'RPM', align: 'r', render: (c) => rs(rpm(c.revenue, c.impressions)) },
    { key: 'mg', head: 'Margin/1k', align: 'r', render: (c) => {
        const v = rpm(c.revenue, c.impressions) - cpm(c.spend, c.impressions);
        return <span className={v >= 0 ? 'text-good' : 'text-bad'}>{rs(v)}</span>;
      } },
    { key: 'r', head: 'ROAS', align: 'r', render: (c) => <Roas v={roasOf(c.revenue, c.spend)} /> },
    { key: 'w', head: 'Clear 1.0', align: 'r', render: (c) => pct(share(c.winners, c.days)) },
  ];

  const cols: Col<DRow>[] = [
    { key: 'wd', head: 'Day', align: 'l', render: (r) => (
        <span className={isWeekend(r.date) ? 'text-muted/70' : 'text-muted'}>{weekday(r.date)}</span>
      ) },
    { key: 'd', head: 'Date', align: 'l', render: (r) => label(r.date) },
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

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card
          title="Steadiest"
          note={`daily ROAS variation · campaigns and blocks above ${rs(VOL_MIN_SPEND)}`}
        >
          {blockVol.steady.length || campVol.steady.length ? (
            <BarList
              fmt={(v) => `±${v.toFixed(0)}%`}
              rows={[
                ...blockVol.steady.slice(0, 5).map((x) => ({
                  label: `BLOCK · ${x.key}`,
                  value: x.cvPct,
                  sub: `mean ${x.mean.toFixed(2)} · ${x.points}d`,
                  color: x.mean >= 1 ? '#1baf7a' : '#eda100',
                })),
                ...campVol.steady.slice(0, 5).map((x) => ({
                  label: `CAMP · ${x.key}`,
                  value: x.cvPct,
                  sub: `mean ${x.mean.toFixed(2)} · ${x.points}d`,
                  color: x.mean >= 1 ? '#2a78d6' : '#eda100',
                })),
              ]}
            />
          ) : (
            <p className="py-4 text-center text-[12px] text-muted">
              Nothing has five days of spend above {rs(VOL_MIN_SPEND)} in this window.
            </p>
          )}
        </Card>

        <Card title="Most erratic" note="same measure, ranked the other way">
          {blockVol.erratic.length || campVol.erratic.length ? (
            <BarList
              fmt={(v) => `±${v.toFixed(0)}%`}
              rows={[
                ...blockVol.erratic.slice(0, 5).map((x) => ({
                  label: `BLOCK · ${x.key}`,
                  value: x.cvPct,
                  sub: `mean ${x.mean.toFixed(2)} · ${x.points}d`,
                  color: '#eb6834',
                })),
                ...campVol.erratic.slice(0, 5).map((x) => ({
                  label: `CAMP · ${x.key}`,
                  value: x.cvPct,
                  sub: `mean ${x.mean.toFixed(2)} · ${x.points}d`,
                  color: '#b3402f',
                })),
              ]}
            />
          ) : (
            <p className="py-4 text-center text-[12px] text-muted">Not enough history to rank.</p>
          )}
        </Card>
      </div>

      <Card title="By product" note="delivery and return per product">
        <Table cols={cutCols('Product', tot.spend)} rows={byProduct.slice(0, 25)} />
      </Card>

      <Card title="By sale block" note="delivery and return per audience">
        <Table cols={cutCols('Sale block', tot.spend)} rows={byBlock.slice(0, 25)} />
      </Card>

      <Card title="By creative type" note="a campaign using two styles counts in both">
        <Table cols={cutCols('Creative', tot.spend)} rows={byCreative} />
      </Card>

      <Card title="Day by day" note="complete days only; today is excluded as partial">
        <Table cols={cols} rows={drows} footer={totalRow} />
      </Card>

      <Note>
        CPM, CTR and CPC come from the impressions and clicks Meta reports against each campaign.
        RPM is the same denominator applied to revenue, so RPM minus CPM is the margin on a
        thousand impressions — the number that says whether delivery is worth what it costs.
        Cost per acquisition is not shown: no Meta table here ingests a purchase count, so it would
        have to be inferred rather than measured.
        {' '}<b className="text-text-strong">Steadiness</b> is the coefficient of variation of daily
        ROAS — the standard deviation as a share of the mean — which is what lets a campaign
        averaging 3.0 be compared with one averaging 0.5. Only things with five days of data and
        over {rs(VOL_MIN_SPEND)} of spend are ranked; volatility measured over three days is noise
        about noise. Steady is not the same as good: a block can hold a losing ROAS very
        reliably.
      </Note>
    </Page>
  );
}
