import {
  campDays, productMap, roasOf, share, PORTAL_NAME, PORTALS, LOSING, bandOf,
} from '@/lib/ads';
import { resolveRange, type SearchParams } from '@/lib/range';
import { rank, wilson, enough, money, pctOf, concentration, type Finding } from '@/lib/insights';
import { BarList, SERIES } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MIN_SPEND = 20000;

type Prod = {
  key: string; days: number; camps: number; spend: number; rev: number;
  winners: number; losing: number;
};

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 30);
  const controls = <PageControls range={range} />;
  const [all, pmap] = await Promise.all([campDays(range.from, range.to), productMap()]);
  const spent = all.filter((r) => r.spend > 0);

  if (!spent.length) {
    return (
      <Page title="Product Success" subtitle={range.label} actions={controls}>
        <Note kind="warn">No campaign-days with spend between {range.from} and {range.to}.</Note>
      </Page>
    );
  }

  const m = new Map<string, Prod>();
  const seen = new Map<string, Set<string>>();
  for (const r of spent) {
    const key = pmap.get(r.campaignId) ?? 'unmapped';
    const p = m.get(key) ?? { key, days: 0, camps: 0, spend: 0, rev: 0, winners: 0, losing: 0 };
    p.days += 1;
    p.spend += r.spend;
    p.rev += r.revenue;
    if (r.roas >= 1) p.winners += 1;
    if (LOSING.includes(bandOf(r.roas))) p.losing += r.spend;
    m.set(key, p);
    const set = seen.get(key) ?? new Set<string>();
    set.add(r.campaignId);
    seen.set(key, set);
  }
  for (const [k, p] of m) p.camps = seen.get(k)?.size ?? 0;

  const rows = [...m.values()].sort((a, b) => b.spend - a.spend);
  const shown = rows.filter((p) => p.spend >= MIN_SPEND);
  const totalSpend = spent.reduce((s, r) => s + r.spend, 0);
  const totalRev = spent.reduce((s, r) => s + r.revenue, 0);
  const unmapped = m.get('unmapped');

  /* ── findings ───────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const solid = shown.filter((p) => enough(p.days, 20) && p.key !== 'unmapped');

  const winners = [...solid].sort((a, b) => roasOf(b.rev, b.spend) - roasOf(a.rev, a.spend));
  if (winners.length) {
    const p = winners[0];
    const w = wilson(p.winners, p.days);
    findings.push({
      severity: 'good',
      headline: `${p.key} is the strongest product carrying real budget`,
      detail: `${roasOf(p.rev, p.spend).toFixed(2)} ROAS on ${money(p.spend)} across ${p.camps} campaigns, clearing 1.0 on ${w.rate.toFixed(0)}% of ${p.days} campaign-days (CI ${w.lo.toFixed(0)}–${w.hi.toFixed(0)}%).`,
      action: 'Return plus volume is the case for more budget here.',
    });
  }

  const losers = solid
    .filter((p) => roasOf(p.rev, p.spend) < 0.9)
    .sort((a, b) => b.spend - a.spend);
  for (const p of losers.slice(0, 2)) {
    findings.push({
      severity: 'critical',
      headline: `${p.key} is not paying for its spend`,
      detail: `${money(p.spend)} at ${roasOf(p.rev, p.spend).toFixed(2)} ROAS — ${pctOf(p.spend, totalSpend).toFixed(1)}% of the book — with ${pctOf(p.losing, p.spend).toFixed(0)}% of it under break-even. Only ${pctOf(p.winners, p.days).toFixed(0)}% of its campaign-days cleared 1.0.`,
      action: 'Either the product does not convert on paid, or the creative around it does not. Both are answered faster by cutting than by waiting.',
    });
  }

  const conc = concentration(shown.filter((p) => p.key !== 'unmapped'), (p) => p.spend);
  if (conc.top && conc.topShare >= 30) {
    findings.push({
      severity: 'neutral',
      headline: `${conc.topShare.toFixed(0)}% of mapped spend sits on one product`,
      detail: `${conc.top.key} at ${roasOf(conc.top.rev, conc.top.spend).toFixed(2)} ROAS. Single-product concentration means a listing or stock problem becomes a revenue problem immediately.`,
    });
  }

  if (unmapped && unmapped.spend > totalSpend * 0.15) {
    findings.push({
      severity: 'watch',
      headline: `${pctOf(unmapped.spend, totalSpend).toFixed(0)}% of spend is on campaigns with no product mapped`,
      detail: `${money(unmapped.spend)} across ${unmapped.camps} campaigns has no row in meta_camp_product_map, so it cannot be attributed to a product at all.`,
      action: 'The classifier pipeline fills that table. Until it catches up, every product figure here is a floor.',
    });
  }

  const cols: Col<Prod>[] = [
    { key: 'k', head: 'Product', align: 'l', render: (p) => (
        <span className={`block max-w-[280px] truncate ${p.key === 'unmapped' ? 'text-muted' : ''}`} title={p.key}>
          {p.key}
        </span>
      ) },
    { key: 'c', head: 'Campaigns', align: 'r', render: (p) => num(p.camps) },
    { key: 'd', head: 'Camp-days', align: 'r', render: (p) => num(p.days) },
    { key: 's', head: 'Spend', align: 'r', render: (p) => rs(p.spend) },
    { key: 'sh', head: '% of spend', align: 'r', render: (p) => pct(share(p.spend, totalSpend), 1) },
    { key: 'v', head: 'Revenue', align: 'r', render: (p) => rs(p.rev) },
    { key: 'r', head: 'ROAS', align: 'r', render: (p) => <Roas v={roasOf(p.rev, p.spend)} /> },
    { key: 'w', head: 'Clear 1.0', align: 'r', render: (p) => (
        <span title={`${p.winners} of ${p.days}`}>{pct(share(p.winners, p.days))}</span>
      ) },
    { key: 'l', head: 'Below 1.0', align: 'r', render: (p) => (
        <span className={share(p.losing, p.spend) >= 50 ? 'text-bad' : ''}>
          {pct(share(p.losing, p.spend))}
        </span>
      ) },
  ];

  return (
    <Page
      title="Product Success"
      subtitle={`${range.label} · ${PORTALS.map((p) => PORTAL_NAME[p]).join(' · ')}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Products with real spend" value={num(shown.filter((p) => p.key !== 'unmapped').length)} sub={`at least ${rs(MIN_SPEND)} in the window`} />
        <Stat label="Blended ROAS" value={roasOf(totalRev, totalSpend).toFixed(3)} sub={lakh(totalSpend)} />
        <Stat
          label="Best product"
          value={winners[0] ? roasOf(winners[0].rev, winners[0].spend).toFixed(2) : '–'}
          sub={winners[0]?.key.slice(0, 42)}
        />
        <Stat
          label="Unmapped spend"
          value={unmapped ? pct(pctOf(unmapped.spend, totalSpend)) : '0%'}
          sub={unmapped ? `${lakh(unmapped.spend)} not attributable to a product` : 'everything mapped'}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${range.label}, ${num(spent.length)} campaign-days`} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="Spend by product" note={`top ${Math.min(12, shown.length)}`}>
          <BarList
            fmt={rs}
            rows={shown.slice(0, 12).map((p, i) => ({
              label: p.key,
              value: p.spend,
              sub: roasOf(p.rev, p.spend).toFixed(2),
              color: p.key === 'unmapped' ? '#5a6472' : SERIES[i % SERIES.length],
            }))}
          />
        </Card>
        <Card title="Return by product" note="products above the spend floor">
          <BarList
            fmt={(v) => v.toFixed(2)}
            rows={shown
              .filter((p) => p.key !== 'unmapped')
              .slice(0, 12)
              .map((p) => ({
                label: p.key,
                value: roasOf(p.rev, p.spend),
                sub: lakh(p.spend),
                color: roasOf(p.rev, p.spend) >= 1.3 ? '#1baf7a'
                  : roasOf(p.rev, p.spend) >= 1 ? '#eda100' : '#eb6834',
              }))}
          />
        </Card>
      </div>

      <Card title="Every product above the spend floor" note={`spend ≥ ${rs(MIN_SPEND)} over ${range.label.toLowerCase()}`}>
        <Table cols={cols} rows={shown} />
      </Card>

      <Note>
        Products come from <span className="text-text">meta_camp_product_map</span>, which the
        classifier pipeline maintains per campaign. Campaigns with no row appear as{' '}
        <span className="text-text">unmapped</span> rather than being dropped, so the totals
        reconcile with the ads modules. Products under {rs(MIN_SPEND)} are hidden — a couple of
        campaign-days is not evidence about a product.
      </Note>
    </Page>
  );
}
