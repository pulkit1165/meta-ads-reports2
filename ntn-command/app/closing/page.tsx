import {
  closingToday, groupStates, familyOf, roasOf, share,
  PORTAL_NAME, PORTALS, bandOf,
} from '@/lib/ads';
import { ROAS_BANDS, BarList, ShareBar } from '@/components/charts';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Row = {
  key: string; camps: number; budget: number; closed: number;
  closedCamps: number; closedSpend: number; closedRevenue: number;
};

export default async function ClosingPage() {
  const snap = await closingToday();
  const rows = snap.rows;

  if (!rows.length) {
    return (
      <Page title="Closing Desk" subtitle="No snapshot for today yet">
        <Note kind="warn">
          The hourly snapshot has not landed for today. This page reads
          <span className="text-[#e8d3a8]"> meta_campaign_snapshot</span>, which the EC2 pipeline
          fills every ten minutes — if it stays empty past 01:00 IST the pipeline is stuck.
        </Note>
      </Page>
    );
  }

  const alloc = rows.reduce((s, r) => s + r.budget, 0);
  const closedBudget = rows.filter((r) => r.closed).reduce((s, r) => s + r.budget, 0);
  const closedRows = rows.filter((r) => r.closed);
  const closedSpend = closedRows.reduce((s, r) => s + r.spend, 0);
  const closedRev = closedRows.reduce((s, r) => s + r.revenue, 0);
  const liveRows = rows.filter((r) => !r.closed);
  const liveSpend = liveRows.reduce((s, r) => s + r.spend, 0);
  const liveRev = liveRows.reduce((s, r) => s + r.revenue, 0);

  const byFamily = groupStates(rows, (r) => familyOf(r.saleBlock));
  const byPortal = groupStates(rows, (r) => r.portal);
  const byBlock = groupStates(rows, (r) => r.saleBlock).filter((a) => a.budget >= 20000);

  // Which ROAS band were the closed campaigns in when they were cut? This is
  // the protocol's own scorecard: everything here should sit under 0.75.
  const bandTotals = new Map<string, number>();
  for (const r of closedRows) {
    const k = bandOf(roasOf(r.revenue, r.spend));
    bandTotals.set(k, (bandTotals.get(k) ?? 0) + r.spend);
  }

  const cols: Col<Row>[] = [
    { key: 'k', head: 'Sale block', align: 'l', render: (r) => (
        <span className="block max-w-[340px] truncate" title={r.key}>{r.key}</span>
      ) },
    { key: 'c', head: 'Camps', align: 'r', render: (r) => num(r.camps) },
    { key: 'a', head: 'Allocated', align: 'r', render: (r) => rs(r.budget) },
    { key: 'x', head: 'Closed', align: 'r', render: (r) => rs(r.closed) },
    { key: 'p', head: 'Closed %', align: 'r', render: (r) => (
        <span className={share(r.closed, r.budget) >= 75 ? 'text-warn' : ''}>
          {pct(share(r.closed, r.budget))}
        </span>
      ) },
    { key: 'n', head: 'Camps cut', align: 'r', render: (r) => num(r.closedCamps) },
    { key: 's', head: 'Spent before cut', align: 'r', render: (r) => rs(r.closedSpend) },
    { key: 'r', head: 'ROAS at cut', align: 'r', render: (r) =>
        r.closedSpend > 0 ? <Roas v={roasOf(r.closedRevenue, r.closedSpend)} /> : <span className="text-muted">–</span> },
  ];

  const total: Row = {
    key: 'TOTAL', camps: rows.length, budget: alloc, closed: closedBudget,
    closedCamps: closedRows.length, closedSpend, closedRevenue: closedRev,
  };

  return (
    <Page
      title="Closing Desk"
      subtitle={`Today, at the ${snap.cutIST} IST snapshot · ${PORTALS.map((p) => PORTAL_NAME[p]).join(' · ')}`}
    >
      <Grid cols={4}>
        <Stat label="Allocated today" value={lakh(alloc)} sub={`${rows.length} campaigns that ran`} />
        <Stat
          label="Closed"
          value={lakh(closedBudget)}
          sub={`${closedRows.length} campaigns switched off`}
        />
        <Stat
          label="Closed share"
          value={pct(share(closedBudget, alloc))}
          sub="of the book that actually ran today"
        />
        <Stat
          label="Spent before the cut"
          value={lakh(closedSpend)}
          sub={`at ${roasOf(closedRev, closedSpend).toFixed(2)} ROAS · still-live is at ${roasOf(liveRev, liveSpend).toFixed(2)}`}
        />
      </Grid>

      <Card
        title="Where the closed money was"
        note="closed spend by the ROAS band each campaign was in when it was cut"
      >
        <ShareBar
          fmt={rs}
          parts={ROAS_BANDS.map((b) => ({
            label: b.label, color: b.color, value: bandTotals.get(b.key) ?? 0,
          })).filter((p) => p.value > 0)}
        />
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
          The ladder only closes below 0.75, so anything above that band was cut by a different
          rule — a manual pause, or the GitHub Actions closer still running the old
          40%-of-budget rule.
        </p>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="By audience family" note="share of each family's budget that is off">
          <BarList
            fmt={(v) => pct(v)}
            max={100}
            rows={byFamily.map((f) => ({
              label: f.key,
              value: share(f.closed, f.budget),
              sub: `${rs(f.closed)} of ${rs(f.budget)}`,
              color: share(f.closed, f.budget) >= 60 ? '#eb6834' : '#2a78d6',
            }))}
          />
        </Card>

        <Card title="By portal" note="share of each portal's budget that is off">
          <BarList
            fmt={(v) => pct(v)}
            max={100}
            rows={byPortal.map((p) => ({
              label: PORTAL_NAME[p.key] ?? p.key,
              value: share(p.closed, p.budget),
              sub: `${rs(p.closed)} of ${rs(p.budget)}`,
              color: share(p.closed, p.budget) >= 60 ? '#eb6834' : '#2a78d6',
            }))}
          />
        </Card>
      </div>

      <Card title="By exact sale block" note="allocated ≥ Rs 20,000">
        <Table cols={cols} rows={byBlock as Row[]} footer={total} />
      </Card>

      <Note>
        <b className="text-[#dbe3ec]">Allocated</b> counts only campaigns that were ACTIVE at some
        point today. A further <b className="text-[#dbe3ec]">{snap.dormantCount} campaigns holding{' '}
        {lakh(snap.dormantBudget)}</b> never went live today — that budget is parked, not closed,
        and folding it in would drag the closed share down by roughly a third for no real reason.
        {' '}Spend shown against closed campaigns is the figure at the latest snapshot, so it
        includes any post-pause delivery.
      </Note>
    </Page>
  );
}
