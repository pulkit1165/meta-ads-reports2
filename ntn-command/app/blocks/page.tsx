import {
  campDays, closingOn, groupStates, familyOf, roasOf, share,
  PORTAL_NAME, PORTALS, LOSING, bandOf,
} from '@/lib/ads';
import { BarList, ShareBar, SERIES } from '@/components/charts';
import { resolveRange, resolveScope, type SearchParams } from '@/lib/range';
import { rank, pctOf, money, wilson, enough, concentration, type Finding } from '@/lib/insights';
import PageControls from '@/components/PageControls';
import { Page, Card, Grid, Stat, Table, Roas, Note, Analysis, Delta, lakh, rs, pct, num, type Col } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The table lists every block. This floor governs only which blocks are allowed
 * to produce a FINDING — a block with two campaign-days can look perfect or
 * catastrophic on one result, and saying so would be worse than saying nothing.
 * Hiding those rows was the older behaviour and it concealed 103 of 194 blocks.
 */
const MIN_SPEND = 15000;

type Blk = {
  key: string; camps: number; spend: number; rev: number;
  winners: number; runners: number; losing: number;
  /** campaign-days where the block was on the book but never spent */
  idle: number;
};

export default async function BlocksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 60);
  const scope = resolveScope(sp);
  const controls = <PageControls range={range} scope={scope} />;
  // Every campaign-day, including those that never spent: a block whose
  // campaigns were all closed still existed, and leaving it out makes the
  // audience list look smaller than the account actually is.
  // Spend and return come from the daily table; allocated/closed come from the
  // hourly snapshots, which are the only place a budget's live-or-closed state
  // exists. The snapshot is a state at a moment, so it is read for the last day
  // of the window rather than summed across it.
  // The comparison period is the window immediately before this one, of the
  // same length — so "Today" compares against yesterday, and a 7-day window
  // against the 7 days before it. Comparing a 60-day window to a single day
  // would be meaningless, and comparing to "yesterday" regardless of window
  // length would silently change what the percentage means.
  const DAY_MS = 86400000;
  const prevTo = new Date(Date.parse(range.from) - DAY_MS).toISOString().slice(0, 10);
  const prevFrom = new Date(Date.parse(prevTo) - (range.span - 1) * DAY_MS)
    .toISOString().slice(0, 10);

  const [all, snap, prevAll] = await Promise.all([
    campDays(range.from, range.to, scope.codes),
    closingOn(range.to, scope.codes).catch(() => null),
    campDays(prevFrom, prevTo, scope.codes),
  ]);
  if (!all.length) {
    return (
      <Page title="Sales Blocks" subtitle={range.label} actions={controls}>
        <Note kind="warn">No campaign-days between {range.from} and {range.to}.</Note>
      </Page>
    );
  }
  const spentRows = all.filter((r) => r.spend > 0);

  function group(keyOf: (r: (typeof all)[number]) => string): Blk[] {
    const m = new Map<string, Blk>();
    for (const r of all) {
      const k = keyOf(r);
      const b = m.get(k) ?? {
        key: k, camps: 0, spend: 0, rev: 0, winners: 0, runners: 0, losing: 0, idle: 0,
      };
      b.camps += 1;
      b.spend += r.spend;
      b.rev += r.revenue;
      // Hit rate counts only days the block actually ran — a closed day is not
      // a failed attempt, and folding it in would deflate every rate.
      if (r.spend > 0) {
        b.runners += 1;
        if (r.roas >= 1) b.winners += 1;
        if (LOSING.includes(bandOf(r.roas))) b.losing += r.spend;
      } else {
        b.idle += 1;
      }
      m.set(k, b);
    }
    return [...m.values()].sort((x, y) => y.spend - x.spend);
  }

  // Closing state for the window's last day, keyed by block.
  const stateByBlock = new Map(
    (snap ? groupStates(snap.rows, (r) => r.saleBlock) : []).map((a) => [a.key, a]),
  );
  const stateOf = (k: string) => stateByBlock.get(k);
  const liveRoasOf = (k: string) => {
    const a = stateOf(k);
    if (!a) return null;
    const sp = a.spend - a.closedSpend, rv = a.revenue - a.closedRevenue;
    return sp > 0 ? rv / sp : null;
  };
  const closedRoasOf = (k: string) => {
    const a = stateOf(k);
    return a && a.closedSpend > 0 ? a.closedRevenue / a.closedSpend : null;
  };

  // Same aggregation over the previous window, keyed by block.
  const prevByBlock = new Map<string, { spend: number; rev: number; winners: number; runners: number }>();
  for (const r of prevAll) {
    const p = prevByBlock.get(r.saleBlock) ?? { spend: 0, rev: 0, winners: 0, runners: 0 };
    p.spend += r.spend;
    p.rev += r.revenue;
    if (r.spend > 0) {
      p.runners += 1;
      if (r.roas >= 1) p.winners += 1;
    }
    prevByBlock.set(r.saleBlock, p);
  }
  /** Percentage change, or null when there is no base to divide by. */
  const changeOf = (key: string, pick: (p: { spend: number; rev: number }) => number, now: number) => {
    const p = prevByBlock.get(key);
    if (!p) return null;
    const before = pick(p);
    return before > 0 ? ((now - before) / before) * 100 : null;
  };

  const fams = group((r) => familyOf(r.saleBlock)).filter((f) => f.spend > 0 || f.idle > 0);
  const blocks = group((r) => r.saleBlock);
  const withSpend = blocks.filter((b) => b.spend > 0);
  const rankable = blocks.filter((b) => b.spend >= MIN_SPEND);
  const totalSpend = spentRows.reduce((s, r) => s + r.spend, 0);
  const totalRev = spentRows.reduce((s, r) => s + r.revenue, 0);

  const best = [...rankable].sort((a, b) => roasOf(b.rev, b.spend) - roasOf(a.rev, a.spend))[0];
  const worst = [...rankable].sort((a, b) => roasOf(a.rev, a.spend) - roasOf(b.rev, b.spend))[0];

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];

  const bigLosers = rankable
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

  const strong = rankable
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

  const conc = concentration(rankable, (b) => b.spend);
  if (conc.top && conc.topShare >= 30) {
    const r = roasOf(conc.top.rev, conc.top.spend);
    findings.push({
      severity: r < 1 ? 'critical' : 'neutral',
      headline: `${conc.topShare.toFixed(0)}% of spend sits in one block`,
      detail: `${conc.top.key.slice(0, 60)} at ${r.toFixed(2)} ROAS. ${r < 1 ? 'A concentrated block that does not return sets the blended number on its own.' : 'Concentration is only a problem if it stops returning.'}`,
    });
  }

  const thin = withSpend.filter((b) => !enough(b.runners, 12) && roasOf(b.rev, b.spend) >= 2);
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
    { key: 'id', head: 'Idle days', align: 'r', render: (b) => (
        <span className={b.idle && !b.runners ? 'text-muted' : ''} title="on the book but never spent">
          {b.idle ? num(b.idle) : '–'}
        </span>
      ) },
    { key: 's', head: 'Spend', align: 'r', render: (b) => {
        const d = changeOf(b.key, (p) => p.spend, b.spend);
        return (
          <span className="whitespace-nowrap">
            {rs(b.spend)}
            {d != null && <span className="ml-1.5"><Delta v={d} tone="flat" /></span>}
          </span>
        );
      } },
    { key: 'sh', head: '% of spend', align: 'r', render: (b) => pct(share(b.spend, totalSpend), 1) },
    { key: 'v', head: 'Revenue', align: 'r', render: (b) => {
        const d = changeOf(b.key, (p) => p.rev, b.rev);
        return (
          <span className="whitespace-nowrap">
            {rs(b.rev)}
            {d != null && <span className="ml-1.5"><Delta v={d} /></span>}
          </span>
        );
      } },
    { key: 'al', head: 'Allocated', align: 'r', render: (b) => {
        const a = stateOf(b.key);
        return a ? rs(a.budget) : <span className="text-muted">–</span>;
      } },
    { key: 'cl', head: 'Closed', align: 'r', render: (b) => {
        const a = stateOf(b.key);
        if (!a) return <span className="text-muted">–</span>;
        return (
          <span title={`${a.closedCamps} of ${a.camps} campaigns`}>
            {rs(a.closed)}
            <span className="ml-1.5 text-[11px] text-muted">{pct(share(a.closed, a.budget))}</span>
          </span>
        );
      } },
    { key: 'cr', head: 'Closed ROAS', align: 'r', render: (b) => {
        const v = closedRoasOf(b.key);
        return v == null ? <span className="text-muted">–</span> : <Roas v={v} />;
      } },
    { key: 'ar', head: 'Active ROAS', align: 'r', render: (b) => {
        const v = liveRoasOf(b.key);
        return v == null ? <span className="text-muted">–</span> : <Roas v={v} />;
      } },
    { key: 'r', head: 'ROAS', align: 'r', render: (b) => {
        if (b.spend <= 0) return <span className="text-muted">never ran</span>;
        const p = prevByBlock.get(b.key);
        const before = p && p.spend > 0 ? p.rev / p.spend : null;
        const now = roasOf(b.rev, b.spend);
        return (
          <span className="whitespace-nowrap">
            <Roas v={now} />
            {before != null && (
              <span
                className={`ml-1.5 text-[11px] ${
                  now - before > 0.01 ? 'text-good' : now - before < -0.01 ? 'text-bad' : 'text-muted'
                }`}
                title={`was ${before.toFixed(2)} in the previous ${range.span} day(s)`}
              >
                {now - before > 0 ? '+' : ''}{(now - before).toFixed(2)}
              </span>
            )}
          </span>
        );
      } },
    { key: 'w', head: 'Clear 1.0', align: 'r', render: (b) => {
        if (!b.runners) return <span className="text-muted">–</span>;
        const p = prevByBlock.get(b.key);
        const nowRate = share(b.winners, b.runners);
        const beforeRate = p && p.runners ? (p.winners / p.runners) * 100 : null;
        return (
          <span className="whitespace-nowrap" title={`${b.winners} of ${b.runners} campaign-days that ran`}>
            {pct(nowRate)}
            {beforeRate != null && (
              <span className="ml-1.5"><Delta v={nowRate - beforeRate} unit="pp" /></span>
            )}
          </span>
        );
      } },
    { key: 'l', head: 'Below 1.0', align: 'r', render: (b) => (
        <span className={share(b.losing, b.spend) >= 50 ? 'text-bad' : ''}>
          {pct(share(b.losing, b.spend))}
        </span>
      ) },
  ];

  const totalRow: Blk = {
    key: 'TOTAL', camps: all.length, spend: totalSpend, rev: totalRev,
    winners: spentRows.filter((r) => r.roas >= 1).length,
    runners: spentRows.length,
    losing: spentRows.filter((r) => LOSING.includes(bandOf(r.roas))).reduce((s, r) => s + r.spend, 0),
    idle: all.length - spentRows.length,
  };

  return (
    <Page
      title="Sales Blocks"
      subtitle={`${range.label} · ${scope.label}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat
          label="Sale blocks"
          value={num(blocks.length)}
          sub={`${num(withSpend.length)} spent · ${num(blocks.length - withSpend.length)} on the book but idle`}
        />
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

      <Card
        title="Every sale block"
        note={`all ${num(blocks.length)} seen in ${range.label.toLowerCase()} · changes are vs ${prevFrom}${range.span > 1 ? ` → ${prevTo}` : ''} · allocated, closed and the two ROAS columns are the state on ${range.to}`}
      >
        <Table cols={cols} rows={blocks} footer={totalRow} />
      </Card>

      <Note>
        A campaign-day is one campaign on one date, so a campaign running all fortnight counts
        fourteen times — deliberate, since the question is how often a block delivers, not how many
        campaigns exist. <b className="text-text-strong">Every block is listed</b>, including ones
        whose campaigns sat closed all window; those show idle days and &ldquo;never ran&rdquo;
        rather than being dropped. Hit rate counts only days a block actually spent, because a
        closed day is not a failed attempt. The {rs(MIN_SPEND)} floor now governs only which blocks
        the analysis will draw a conclusion from — on a couple of campaign-days a single result
        swings the rate to 100% and reads as a discovery.
        {' '}<b className="text-text-strong">Allocated, Closed, Closed ROAS and Active ROAS</b> read
        the hourly snapshot for {range.to}, which is the only source that knows whether a budget is
        still running. Spend and revenue either side of that split are the figures at the latest
        capture, so a campaign closed minutes ago still carries the spend it made. A dash means the
        block had no campaign in that day&apos;s snapshot at all.
        {' '}Changes compare against the window immediately before this one, of the same length —
        Today against yesterday, a 7-day window against the 7 days before it. A block with no
        spend in that earlier window shows no change rather than an infinite one. Spend carries a
        neutral arrow: spending more is neither good nor bad on its own.
      </Note>
    </Page>
  );
}
