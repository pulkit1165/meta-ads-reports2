import { campDays, familyOf, roasOf, share, PORTAL_NAME, PORTALS, LOSING, bandOf } from '@/lib/ads';
import { BarList, ShareBar, SERIES } from '@/components/charts';
import { Page, Card, Grid, Stat, Table, Roas, Note, lakh, rs, pct, num, type Col } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DAYS = 14;
const MIN_SPEND = 15000;

type Blk = {
  key: string; camps: number; spend: number; rev: number;
  winners: number; runners: number; losing: number;
};

export default async function BlocksPage() {
  const all = (await campDays(DAYS)).filter((r) => r.spend > 0);
  if (!all.length) {
    return (
      <Page title="Sales Blocks" subtitle="No data">
        <Note kind="warn">No campaign-days with spend in the last {DAYS} days.</Note>
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
      subtitle={`Audience performance over ${DAYS} days · ${PORTALS.map((p) => PORTAL_NAME[p]).join(' · ')}`}
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

      <Card title="Every block carrying real spend" note={`spend ≥ ${rs(MIN_SPEND)} over ${DAYS} days`}>
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
