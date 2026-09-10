import { campDays, creativeTags, roasOf, share, PORTAL_NAME, PORTALS, LOSING, bandOf } from '@/lib/ads';
import { resolveRange, type SearchParams } from '@/lib/range';
import { rank, wilson, enough, money, pctOf, concentration, type Finding } from '@/lib/insights';
import { BarList, ShareBar, SERIES } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Cr = {
  key: string; days: number; spend: number; rev: number;
  winners: number; losing: number;
};

export default async function CreativePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 30);
  const controls = <PageControls range={range} />;
  const all = (await campDays(range.from, range.to)).filter((r) => r.spend > 0);

  if (!all.length) {
    return (
      <Page title="Creative Success" subtitle={range.label} actions={controls}>
        <Note kind="warn">No campaign-days with spend between {range.from} and {range.to}.</Note>
      </Page>
    );
  }

  // A campaign tagged "Paras | Motion" counts toward both tags: the question is
  // which styles show up in winners, not which exact combination string does.
  const m = new Map<string, Cr>();
  for (const r of all) {
    for (const tag of creativeTags(r.creativeType)) {
      const c = m.get(tag) ?? { key: tag, days: 0, spend: 0, rev: 0, winners: 0, losing: 0 };
      c.days += 1;
      c.spend += r.spend;
      c.rev += r.revenue;
      if (r.roas >= 1) c.winners += 1;
      if (LOSING.includes(bandOf(r.roas))) c.losing += r.spend;
      m.set(tag, c);
    }
  }
  const rows = [...m.values()].sort((a, b) => b.spend - a.spend);

  const totalSpend = all.reduce((s, r) => s + r.spend, 0);
  const totalRev = all.reduce((s, r) => s + r.revenue, 0);
  const overallHit = pctOf(all.filter((r) => r.roas >= 1).length, all.length);

  /* ── findings ───────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const solid = rows.filter((c) => enough(c.days, 25));

  const best = [...solid].sort((a, b) => roasOf(b.rev, b.spend) - roasOf(a.rev, a.spend))[0];
  const worst = [...solid].sort((a, b) => roasOf(a.rev, a.spend) - roasOf(b.rev, b.spend))[0];

  if (best && worst && best.key !== worst.key) {
    const bw = wilson(best.winners, best.days);
    const ww = wilson(worst.winners, worst.days);
    const separated = bw.lo > ww.hi;
    findings.push({
      severity: separated ? 'good' : 'neutral',
      headline: separated
        ? `${best.key} genuinely beats ${worst.key}`
        : `${best.key} leads ${worst.key}, but not conclusively`,
      detail: `${best.key} clears 1.0 on ${bw.rate.toFixed(0)}% of ${best.days} campaign-days (CI ${bw.lo.toFixed(0)}–${bw.hi.toFixed(0)}%) at ${roasOf(best.rev, best.spend).toFixed(2)} ROAS; ${worst.key} on ${ww.rate.toFixed(0)}% of ${worst.days} (CI ${ww.lo.toFixed(0)}–${ww.hi.toFixed(0)}%) at ${roasOf(worst.rev, worst.spend).toFixed(2)}.`,
      action: separated
        ? `The intervals do not overlap, so this is a real difference. Weight new launches toward ${best.key}.`
        : 'The confidence intervals overlap, so the gap could be noise. Not yet a reason to shift budget.',
    });
  }

  const burners = solid
    .filter((c) => roasOf(c.rev, c.spend) < 0.9 && c.spend >= totalSpend * 0.08)
    .sort((a, b) => b.spend - a.spend);
  for (const c of burners.slice(0, 2)) {
    findings.push({
      severity: 'critical',
      headline: `${c.key} carries ${pctOf(c.spend, totalSpend).toFixed(0)}% of spend and does not return`,
      detail: `${money(c.spend)} at ${roasOf(c.rev, c.spend).toFixed(2)} ROAS, with ${pctOf(c.losing, c.spend).toFixed(0)}% of its spend under break-even.`,
      action: 'A creative style this large and this weak sets the blended number by itself.',
    });
  }

  const conc = concentration(rows, (c) => c.spend);
  if (conc.top && conc.topShare >= 45) {
    findings.push({
      severity: 'watch',
      headline: `${conc.topShare.toFixed(0)}% of spend runs on one creative style`,
      detail: `${conc.top.key} at ${roasOf(conc.top.rev, conc.top.spend).toFixed(2)} ROAS. Concentration this high means creative fatigue hits the whole book at once rather than one segment.`,
    });
  }

  const thin = rows.filter((c) => !enough(c.days, 25));
  if (thin.length) {
    findings.push({
      severity: 'neutral',
      headline: `${thin.length} style${thin.length > 1 ? 's have' : ' has'} too little volume to judge`,
      detail: `${thin.slice(0, 3).map((c) => `${c.key} (${c.days} campaign-days)`).join('; ')}. Rates on samples this small move on a single day.`,
    });
  }

  const cols: Col<Cr>[] = [
    { key: 'k', head: 'Creative style', align: 'l', render: (c) => c.key },
    { key: 'd', head: 'Camp-days', align: 'r', render: (c) => num(c.days) },
    { key: 's', head: 'Spend', align: 'r', render: (c) => rs(c.spend) },
    { key: 'sh', head: '% of spend', align: 'r', render: (c) => pct(share(c.spend, totalSpend), 1) },
    { key: 'r', head: 'ROAS', align: 'r', render: (c) => <Roas v={roasOf(c.rev, c.spend)} /> },
    { key: 'w', head: 'Clear 1.0', align: 'r', render: (c) => pct(share(c.winners, c.days)) },
    { key: 'ci', head: '95% CI', align: 'r', render: (c) => {
        const w = wilson(c.winners, c.days);
        return enough(c.days, 25)
          ? <span className="text-muted">{w.lo.toFixed(0)}–{w.hi.toFixed(0)}%</span>
          : <span className="text-muted">too few</span>;
      } },
    { key: 'l', head: 'Below 1.0', align: 'r', render: (c) => (
        <span className={share(c.losing, c.spend) >= 50 ? 'text-bad' : ''}>
          {pct(share(c.losing, c.spend))}
        </span>
      ) },
  ];

  return (
    <Page
      title="Creative Success"
      subtitle={`${range.label} · ${PORTALS.map((p) => PORTAL_NAME[p]).join(' · ')}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Styles in use" value={num(rows.length)} sub={`over ${num(all.length)} campaign-days`} />
        <Stat label="Blended ROAS" value={roasOf(totalRev, totalSpend).toFixed(3)} sub={lakh(totalSpend)} />
        <Stat label="Overall hit rate" value={pct(overallHit)} sub="campaign-days clearing 1.0" />
        <Stat
          label="Best style with volume"
          value={best ? roasOf(best.rev, best.spend).toFixed(2) : '–'}
          sub={best ? `${best.key} · ${num(best.days)} campaign-days` : 'none with enough volume'}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${range.label}, ${num(all.length)} campaign-days`} />

      <Card title="Spend by creative style" note="a campaign using two styles counts toward both">
        <ShareBar
          fmt={rs}
          parts={rows.map((c, i) => ({ label: c.key, value: c.spend, color: SERIES[i % SERIES.length] }))}
        />
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="Return by style" note="revenue ÷ spend">
          <BarList
            fmt={(v) => v.toFixed(2)}
            rows={rows.map((c) => ({
              label: c.key,
              value: roasOf(c.rev, c.spend),
              sub: lakh(c.spend),
              color: roasOf(c.rev, c.spend) >= 1.3 ? '#1baf7a'
                : roasOf(c.rev, c.spend) >= 1 ? '#eda100' : '#eb6834',
            }))}
          />
        </Card>
        <Card title="Hit rate by style" note="share of campaign-days clearing 1.0">
          <BarList
            fmt={(v) => pct(v)} max={100}
            rows={rows.map((c) => ({
              label: c.key,
              value: share(c.winners, c.days),
              sub: `${c.winners}/${c.days}`,
              color: enough(c.days, 25) ? '#2a78d6' : '#5aa9a3',
            }))}
          />
        </Card>
      </div>

      <Card title="Every creative style" note="95% interval shown where there is enough volume to mean anything">
        <Table cols={cols} rows={rows} />
      </Card>

      <Note>
        <span className="text-text">creative_type</span> arrives as pipe-joined combinations, so
        &ldquo;Paras | Motion&rdquo; is counted under both Paras and Motion. Percentages therefore
        sum above 100% — deliberately, because the question is which styles appear in winners
        rather than which exact combination string does. Sentiment is classified by a separate
        workflow and is not on this table yet.
      </Note>
    </Page>
  );
}
