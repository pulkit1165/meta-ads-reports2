import {
  closingOn, groupStates, familyOf, roasOf, share,
  PORTAL_NAME, PORTALS, bandOf,
} from '@/lib/ads';
import { resolveRange, resolveScope, type SearchParams } from '@/lib/range';
import { rank, pctOf, money, concentration, type Finding } from '@/lib/insights';
import { ROAS_BANDS, BarList, ShareBar } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Row = {
  key: string; camps: number; budget: number; closed: number;
  closedCamps: number; closedSpend: number; closedRevenue: number;
};

export default async function ClosingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  // 0 = today: this page reports the live state of the book, not a settled day.
  const range = resolveRange(sp, 0);
  const scope = resolveScope(sp);
  // Closing is a state, not a window: it reads one day's snapshot. The picker
  // chooses which day, and `to` is the end of whatever window was selected.
  const day = range.to;
  const snap = await closingOn(day, scope.codes);
  const rows = snap.rows;

  const controls = <PageControls range={range} scope={scope} />;

  if (!rows.length) {
    return (
      <Page title="Closing Desk" subtitle={`No snapshot for ${day}`} actions={controls}>
        <Note kind="warn">
          No rows in <span className="text-warn">meta_campaign_snapshot</span> for {day}. The EC2
          pipeline writes it every ten minutes, so an empty day past 01:00 IST means the pipeline
          is stuck rather than that nothing ran.
        </Note>
      </Page>
    );
  }

  const alloc = rows.reduce((s, r) => s + r.budget, 0);
  const closedRows = rows.filter((r) => r.closed);
  const closedBudget = closedRows.reduce((s, r) => s + r.budget, 0);
  const closedSpend = closedRows.reduce((s, r) => s + r.spend, 0);
  const closedRev = closedRows.reduce((s, r) => s + r.revenue, 0);
  const liveRows = rows.filter((r) => !r.closed);
  const liveSpend = liveRows.reduce((s, r) => s + r.spend, 0);
  const liveRev = liveRows.reduce((s, r) => s + r.revenue, 0);

  const byFamily = groupStates(rows, (r) => familyOf(r.saleBlock));
  const byPortal = groupStates(rows, (r) => r.portal);
  const byBlock = groupStates(rows, (r) => r.saleBlock).filter((a) => a.budget >= 20000);

  const bandTotals = new Map<string, number>();
  for (const r of closedRows) {
    const k = bandOf(roasOf(r.revenue, r.spend));
    bandTotals.set(k, (bandTotals.get(k) ?? 0) + r.spend);
  }
  // The ladder only closes below 0.75. Anything cut above that came from a
  // different rule, and that is worth knowing about.
  const aboveLadder = ['b5', 'b6', 'b7'].reduce((s, b) => s + (bandTotals.get(b) ?? 0), 0);

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const closedPct = pctOf(closedBudget, alloc);

  if (closedPct >= 55) {
    findings.push({
      severity: closedPct >= 70 ? 'critical' : 'watch',
      headline: `${closedPct.toFixed(0)}% of today's book is already switched off`,
      detail: `${money(closedBudget)} of ${money(alloc)} closed across ${closedRows.length} campaigns, at ${roasOf(closedRev, closedSpend).toFixed(2)} ROAS. What still runs is at ${roasOf(liveRev, liveSpend).toFixed(2)}.`,
      action: closedPct >= 70
        ? 'At this rate the day ends on a small live book. Check whether new launches are replacing what the ladder is cutting.'
        : undefined,
    });
  }

  const heavy = byFamily.filter((f) => f.budget >= 50000 && pctOf(f.closed, f.budget) >= 60);
  for (const f of heavy.slice(0, 2)) {
    findings.push({
      severity: 'watch',
      headline: `${f.key} is being cut hardest`,
      detail: `${pctOf(f.closed, f.budget).toFixed(0)}% of its ${money(f.budget)} is off — ${f.closedCamps} of ${f.camps} campaigns — after spending ${money(f.closedSpend)} at ${roasOf(f.closedRevenue, f.closedSpend).toFixed(2)}.`,
      action: 'If this repeats daily, the gate is catching a structural problem rather than a bad day. Worth reviewing the targeting rather than the ladder.',
    });
  }

  const wiped = byBlock.filter((b) => b.budget >= 40000 && pctOf(b.closed, b.budget) >= 99);
  if (wiped.length) {
    findings.push({
      severity: 'critical',
      headline: `${wiped.length} block${wiped.length > 1 ? 's are' : ' is'} fully eliminated`,
      detail: wiped.slice(0, 3).map((b) => `${b.key.slice(0, 44)} (${money(b.budget)}, ${b.closedCamps}/${b.camps} camps)`).join('; ') + '.',
      action: 'Every campaign in these blocks died today. That is an audience verdict, not a campaign one — stop relaunching into them until something changes.',
    });
  }

  if (aboveLadder > 0) {
    findings.push({
      severity: 'watch',
      headline: `${money(aboveLadder)} was closed above the ladder's ceiling`,
      detail: 'The day-1–3 ladder stops at 0.75 ROAS, so spend closed in the 1.0+ bands was cut by something else — a manual pause, or the GitHub Actions closer still running the old 40%-of-budget rule.',
      action: 'Worth confirming these were deliberate. The GHA closer operates outside the ladder entirely.',
    });
  }

  const conc = concentration(byBlock, (b) => b.budget);
  if (conc.top && conc.topShare >= 25) {
    findings.push({
      severity: 'neutral',
      headline: `One block holds ${conc.topShare.toFixed(0)}% of the allocated budget`,
      detail: `${conc.top.key.slice(0, 60)} — ${money(conc.top.budget)}. Concentration is only a risk if it stops returning; today it is at ${roasOf(conc.top.revenue, conc.top.spend).toFixed(2)}.`,
    });
  }

  if (snap.dormantBudget > alloc * 0.3) {
    findings.push({
      severity: 'neutral',
      headline: `${money(snap.dormantBudget)} of budget never went live today`,
      detail: `${snap.dormantCount} campaigns hold budget on paper but were already off at midnight. They are excluded from every figure here — counting them would drag the closed share down by about a third for no real reason.`,
    });
  }

  /* ── table ────────────────────────────────────────────────────────────── */
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
        r.closedSpend > 0
          ? <Roas v={roasOf(r.closedRevenue, r.closedSpend)} />
          : <span className="text-muted">–</span> },
  ];

  const total: Row = {
    key: 'TOTAL', camps: rows.length, budget: alloc, closed: closedBudget,
    closedCamps: closedRows.length, closedSpend, closedRevenue: closedRev,
  };

  return (
    <Page
      title="Closing Desk"
      subtitle={`${day} · snapshot at ${snap.cutIST} IST · ${scope.label}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Allocated" value={lakh(alloc)} sub={`${rows.length} campaigns that ran`} />
        <Stat label="Closed" value={lakh(closedBudget)} sub={`${closedRows.length} campaigns switched off`} />
        <Stat label="Closed share" value={pct(closedPct)} sub="of the book that actually ran" />
        <Stat
          label="Spent before the cut"
          value={lakh(closedSpend)}
          sub={`at ${roasOf(closedRev, closedSpend).toFixed(2)} ROAS · still-live is at ${roasOf(liveRev, liveSpend).toFixed(2)}`}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${day}, ${rows.length} campaigns`} />

      <Card title="Where the closed money was" note="closed spend by the ROAS band each campaign was in when cut">
        <ShareBar
          fmt={rs}
          parts={ROAS_BANDS.map((b) => ({
            label: b.label, color: b.color, value: bandTotals.get(b.key) ?? 0,
          })).filter((p) => p.value > 0)}
        />
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="By audience family" note="share of each family's budget that is off">
          <BarList
            fmt={(v) => pct(v)} max={100}
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
            fmt={(v) => pct(v)} max={100}
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
        <b className="text-text-strong">Allocated</b> counts only campaigns that were ACTIVE at
        some point on {day}. A further{' '}
        <b className="text-text-strong">{snap.dormantCount} campaigns holding {lakh(snap.dormantBudget)}</b>{' '}
        never went live and are excluded. Spend shown against closed campaigns is the figure at the
        latest snapshot, so it includes any post-pause delivery.
      </Note>
    </Page>
  );
}
