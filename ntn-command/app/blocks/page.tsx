import { campDays, familyOf, roasOf, share, PORTAL_NAME, PORTALS, LOSING, bandOf } from '@/lib/ads';
import { BarList, ShareBar, SERIES } from '@/components/charts';
import { resolveRange, resolveScope, type SearchParams } from '@/lib/range';
import { rank, pctOf, money, wilson, enough, concentration, type Finding } from '@/lib/insights';
import PageControls from '@/components/PageControls';
import { Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MIN_SPEND = 15000;

type Blk = {
  key: string; camps: number; spend: number; rev: number;
  winners: number; runners: number; losing: number;
};

export default async function BlocksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 60);
  const scope = resolveScope(sp);
  const controls = <PageControls range={range} scope={scope} />;
  const all = (await campDays(range.from, range.to, scope.codes)).filter((r) => r.spend > 0);
  if (!all.length) {
    return (
      <Page title="Sales Blocks" subtitle={range.label} actions={controls}>
        <Note kind="warn">No campaign-days with spend between {range.from} and {range.to}.</Note>
      </Page>
    );
  }

  function group(keyOf: (r: (typeof all)[number]) => string): Blk[] {
    const m = new Map<string, Blk>();
    for (const r of all) {
      const k = keyOf(r);
      const b = m.get(k) ?? { key: k, camps: 0, spend: 0, rev: 0, winners: 0, runners: 0, losing: 0 };
      b.camps += 1;
      b.spend += r.spend;
      b.rev += r.revenue;
      b.runners += 1;
      if (r.roas >= 1) b.winners += 1;
      if (LOSING.includes(bandOf(r.roas))) b.losing += r.spend;
      m.set(k, b);
    }
    return [...m.values()].sort((x, y) => y.spend - x.spend);
  }

  const fams = group((r) => familyOf(r.saleBlock));
  const blocks = group((r) => r.saleBlock).filter((b) => b.spend >= MIN_SPEND);
  const totalSpend = all.reduce((s, r) => s + r.spend, 0);
  const totalRev = all.reduce((s, r) => s + r.revenue, 0);

  const best = [...blocks].sort((a, b) => roasOf(b.rev, b.spend) - roasOf(a.rev, a.spend))[0];
  const worst = [...blocks].sort((a, b) => roasOf(a.rev, a.spend) - roasOf(b.rev, b.spend))[0];

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];

  const bigLosers = blocks
    .filter((b) => b.spend >= MIN_SPEND * 3 && roasOf(b.rev, b.spend) < 0.8)
    .sort((a, b) => b.spend - a.spend);
  for (const b of bigLosers.slice(0, 2)) {
    findings.push({
      severity: 'critical',
      headline: `${b.key.slice(0, 52)} is burning`,
      detail: `${money(b.spend)} over ${range.label.toLowerCase()} at ${roasOf(b.rev, b.spend).toFixed(2)} ROAS — ${pctOf(b.spend, totalSpend).toFixed(1)}% of all spend. Only ${pctOf(b.winners, b.runners).toFixed(0)}% of its campaign-days cleared 1.0.`,
      action: 'Large and losing is the worst combination. Cut the allocation rather than waiting for the per-campaign gates to do it one at a time.',
    });
  }

  const strong = blocks
    .filter((b) => enough(b.runners, 15) && roasOf(b.rev, b.spend) >= 1.5)
    .sort((a, b) => roasOf(b.rev, b.spend) - roasOf(a.rev, a.spend));
  if (strong.length) {
    const b = strong[0];
    const w = wilson(b.winners, b.runners);
    findings.push({
      severity: 'good',
      headline: `${b.key.slice(0, 52)} is the best block that carries real volume`,
      detail: `${roasOf(b.rev, b.spend).toFixed(2)} ROAS on ${money(b.spend)}, clearing 1.0 on ${w.rate.toFixed(0)}% of ${b.runners} campaign-days (95% CI ${w.lo.toFixed(0)}–${w.hi.toFixed(0)}%).`,
      action: 'Volume plus return is the case for more budget here, not less.',
    });
  }

  const conc = concentration(blocks, (b) => b.spend);
  if (conc.top && conc.topShare >= 30) {
    const r = roasOf(conc.top.rev, conc.top.spend);
    findings.push({
      severity: r < 1 ? 'critical' : 'neutral',
      headline: `${conc.topShare.toFixed(0)}% of spend sits in one block`,
      detail: `${conc.top.key.slice(0, 60)} at ${r.toFixed(2)} ROAS. ${r < 1 ? 'A concentrated block that does not return sets the blended number on its own.' : 'Concentration is only a problem if it stops returning.'}`,
    });
  }

  const thin = blocks.filter((b) => !enough(b.runners, 12) && roasOf(b.rev, b.spend) >= 2);
  if (thin.length) {
    findings.push({
      severity: 'neutral',
      headline: `${thin.length} block${thin.length > 1 ? 's look' : ' looks'} excellent on too little evidence`,
      detail: `${thin.slice(0, 2).map((b) => `${b.key.slice(0, 34)} (${b.runners} campaign-days)`).join('; ')}. Under a dozen campaign-days a single good day sets the rate, so these are not yet findings.`,
    });
  }

  const cols: Col<Blk>[] = [
    { key: 'k', head: 'Sale block', align: 'l', render: (b) => (
        <span className="block max-w-[360px] truncate" title={b.key}>{b.key}</span>
      ) },
    { key: 'n', head: 'Camp-days', align: 'r', render: (b) => num(b.camps) },
    { key: 's', head: 'Spend', align: 'r', render: (b) => rs(b.spend) },
    { key: 'sh', head: '% of spend', align: 'r', render: (b) => pct(share(b.spend, totalSpend), 1) },
    { key: 'v', head: 'Revenue', align: 'r', render: (b) => rs(b.rev) },
    { key: 'r', head: 'ROAS', align: 'r', render: (b) => <Roas v={roasOf(b.rev, b.spend)} /> },
    { key: 'w', head: 'Clear 1.0', align: 'r', render: (b) => (
        <span title={`${b.winners} of ${b.runners} campaign-days`}>
          {pct(share(b.winners, b.runners))}
        </span>
      ) },
    { key: 'l', head: 'Below 1.0', align: 'r', render: (b) => (
        <span className={share(b.losing, b.spend) >= 50 ? 'text-bad' : ''}>
          {pct(share(b.losing, b.spend))}
        </span>
      ) },
  ];

  const totalRow: Blk = {
    key: 'TOTAL', camps: all.length, spend: totalSpend, rev: totalRev,
    winners: all.filter((r) => r.roas >= 1).length, runners: all.length,
    losing: all.filter((r) => LOSING.includes(bandOf(r.roas))).reduce((s, r) => s + r.spend, 0),
  };

  return (
    <Page
      title="Sales Blocks"
      subtitle={`${range.label} · ${scope.label}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Blocks carrying spend" value={num(blocks.length)} sub={`with at least ${rs(MIN_SPEND)} over the window`} />
        <Stat label="Blended ROAS" value={roasOf(totalRev, totalSpend).toFixed(3)} sub={`${lakh(totalSpend)} of spend`} />
        <Stat
          label="Best block"
          value={best ? roasOf(best.rev, best.spend).toFixed(2) : '–'}
          sub={best?.key.slice(0, 46)}
        />
        <Stat
          label="Worst block"
          value={worst ? roasOf(worst.rev, worst.spend).toFixed(2) : '–'}
          sub={worst?.key.slice(0, 46)}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${range.label}, ${num(all.length)} campaign-days`} />

      <Card title="Spend by audience family" note="how the book divides across targeting styles">
        <ShareBar
          fmt={rs}
          parts={fams.map((f, i) => ({ label: f.key, value: f.spend, color: SERIES[i % SERIES.length] }))}
        />
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="Return by family" note="revenue ÷ spend">
          <BarList
            fmt={(v) => v.toFixed(2)}
            rows={fams.map((f) => ({
              label: f.key,
              value: roasOf(f.rev, f.spend),
              sub: lakh(f.spend),
              color: roasOf(f.rev, f.spend) >= 1.3 ? '#1baf7a' : roasOf(f.rev, f.spend) >= 1 ? '#eda100' : '#eb6834',
            }))}
          />
        </Card>
        <Card title="Hit rate by family" note="share of campaign-days clearing 1.0 ROAS">
          <BarList
            fmt={(v) => pct(v)}
            max={100}
            rows={fams.map((f) => ({
              label: f.key,
              value: share(f.winners, f.runners),
              sub: `${f.winners} of ${f.runners}`,
              color: '#2a78d6',
            }))}
          />
        </Card>
      </div>

      <Card title="Every block carrying real spend" note={`spend ≥ ${rs(MIN_SPEND)} over ${range.label.toLowerCase()}`}>
        <Table cols={cols} rows={blocks} footer={totalRow} />
      </Card>

      <Note>
        A campaign-day is one campaign on one date, so a campaign running all fortnight counts
        fourteen times — that is deliberate, since the question is how often a block delivers, not
        how many campaigns exist. Blocks under {rs(MIN_SPEND)} are hidden: with a handful of
        campaign-days a single good day swings the rate to 100% and reads as a discovery.
      </Note>
    </Page>
  );
}
