import {
  campDays, productMap, familyOf, creativeTags, budgetBand, BUDGET_BANDS,
  roasOf, share, PORTAL_NAME, PORTALS,
} from '@/lib/ads';
import { resolveRange, resolveScope, type SearchParams } from '@/lib/range';
import { rank, wilson, enough, money, pctOf, type Finding } from '@/lib/insights';
import { BarList } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, pct, num, rs, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MIN_DAYS = 15;

type Combo = {
  key: string; days: number; spend: number; rev: number; winners: number;
};

export default async function PatternsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 60);
  const scope = resolveScope(sp);
  const controls = <PageControls range={range} scope={scope} />;
  const [all, pmap] = await Promise.all([campDays(range.from, range.to, scope.codes), productMap()]);
  const spent = all.filter((r) => r.spend > 0);

  if (!spent.length) {
    return (
      <Page title="Winning Patterns" subtitle={range.label} actions={controls}>
        <Note kind="warn">No campaign-days with spend between {range.from} and {range.to}.</Note>
      </Page>
    );
  }

  const overall = pctOf(spent.filter((r) => r.roas >= 1).length, spent.length);

  /** Group by any key function; a row may contribute to several keys. */
  function group(keyOf: (r: (typeof spent)[number]) => string[]): Combo[] {
    const m = new Map<string, Combo>();
    for (const r of spent) {
      for (const k of keyOf(r)) {
        const c = m.get(k) ?? { key: k, days: 0, spend: 0, rev: 0, winners: 0 };
        c.days += 1;
        c.spend += r.spend;
        c.rev += r.revenue;
        if (r.roas >= 1) c.winners += 1;
        m.set(k, c);
      }
    }
    return [...m.values()];
  }

  const allCombos = group((r) =>
    creativeTags(r.creativeType).map(
      (tag) => `${familyOf(r.saleBlock)} · ${tag} · ${budgetBand(r.budget)}`,
    ),
  );
  const combos = allCombos.filter((c) => enough(c.days, MIN_DAYS));

  // Ranked on the LOWER BOUND of the interval, never the raw rate: that is
  // what stops a three-for-three combination outranking sixty-for-a-hundred.
  const byFloor = (a: Combo, b: Combo) =>
    wilson(b.winners, b.days).lo - wilson(a.winners, a.days).lo;
  const ranked = [...combos].sort(byFloor);
  const best = ranked.slice(0, 8);
  const worst = [...ranked].reverse().slice(0, 6);

  const byBand = group((r) => [budgetBand(r.budget)])
    .filter((c) => enough(c.days, MIN_DAYS))
    .sort((a, b) => BUDGET_BANDS.indexOf(a.key) - BUDGET_BANDS.indexOf(b.key));
  const bandRank = [...byBand].sort(byFloor);

  const byProduct = group((r) => [pmap.get(r.campaignId) ?? 'unmapped'])
    .filter((c) => enough(c.days, MIN_DAYS))
    .sort(byFloor);

  /* ── findings ───────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];

  if (best.length) {
    const c = best[0];
    const w = wilson(c.winners, c.days);
    findings.push({
      severity: w.lo > overall ? 'good' : 'neutral',
      headline: `Best combination: ${c.key}`,
      detail: `${w.rate.toFixed(0)}% of ${c.days} campaign-days cleared 1.0 (CI ${w.lo.toFixed(0)}–${w.hi.toFixed(0)}%), on ${money(c.spend)} at ${roasOf(c.rev, c.spend).toFixed(2)} ROAS. The book overall clears ${overall.toFixed(0)}%.`,
      action: w.lo > overall
        ? 'Even its worst case beats the book average, so this is a pattern to repeat rather than a lucky run.'
        : 'Its interval overlaps the book average — leading, but not yet proven.',
    });
  }

  if (worst.length) {
    const c = worst[0];
    const w = wilson(c.winners, c.days);
    if (w.hi < overall) {
      findings.push({
        severity: 'critical',
        headline: `Worst combination: ${c.key}`,
        detail: `${w.rate.toFixed(0)}% of ${c.days} campaign-days cleared 1.0 (CI ${w.lo.toFixed(0)}–${w.hi.toFixed(0)}%), burning ${money(c.spend)} at ${roasOf(c.rev, c.spend).toFixed(2)}. Even its best case is under the ${overall.toFixed(0)}% book average.`,
        action: 'Reliably worse than average. Stop launching this shape.',
      });
    }
  }

  if (bandRank.length >= 2) {
    const top = bandRank[0], bot = bandRank[bandRank.length - 1];
    const tw = wilson(top.winners, top.days), bw = wilson(bot.winners, bot.days);
    findings.push({
      severity: tw.lo > bw.hi ? 'good' : 'neutral',
      headline: `Launch budget ${top.key} performs best`,
      detail: `${tw.rate.toFixed(0)}% over ${top.days} campaign-days (CI ${tw.lo.toFixed(0)}–${tw.hi.toFixed(0)}%) against ${bw.rate.toFixed(0)}% for ${bot.key}. Cost per winner ${money(top.spend / Math.max(1, top.winners))} versus ${money(bot.spend / Math.max(1, bot.winners))}.`,
      action: tw.lo > bw.hi
        ? 'The intervals separate, so budget size genuinely matters.'
        : 'The intervals overlap — treat the ordering as indicative, not settled.',
    });
  }

  const topProd = byProduct.find((p) => p.key !== 'unmapped');
  if (topProd) {
    const w = wilson(topProd.winners, topProd.days);
    if (w.lo > overall) {
      findings.push({
        severity: 'good',
        headline: `${topProd.key} is the most reliable product to launch behind`,
        detail: `${w.rate.toFixed(0)}% of ${topProd.days} campaign-days cleared 1.0 (CI ${w.lo.toFixed(0)}–${w.hi.toFixed(0)}%) on ${money(topProd.spend)}.`,
      });
    }
  }

  const dropped = allCombos.length - combos.length;
  if (dropped > 0) {
    findings.push({
      severity: 'neutral',
      headline: `${dropped} combinations were too thin to rank`,
      detail: `Of ${allCombos.length} seen, only ${combos.length} had at least ${MIN_DAYS} campaign-days. Ranking the rest would surface whichever happened to have a good day.`,
    });
  }

  const cols: Col<Combo>[] = [
    { key: 'k', head: 'Audience · creative · budget', align: 'l', render: (c) => (
        <span className="block max-w-[380px] truncate" title={c.key}>{c.key}</span>
      ) },
    { key: 'd', head: 'Camp-days', align: 'r', render: (c) => num(c.days) },
    { key: 's', head: 'Spend', align: 'r', render: (c) => rs(c.spend) },
    { key: 'r', head: 'ROAS', align: 'r', render: (c) => <Roas v={roasOf(c.rev, c.spend)} /> },
    { key: 'w', head: 'Clear 1.0', align: 'r', render: (c) => pct(share(c.winners, c.days)) },
    { key: 'ci', head: '95% CI', align: 'r', render: (c) => {
        const w = wilson(c.winners, c.days);
        return <span className="text-muted">{w.lo.toFixed(0)}–{w.hi.toFixed(0)}%</span>;
      } },
    { key: 'cpw', head: 'Cost per winner', align: 'r', render: (c) =>
        c.winners ? rs(c.spend / c.winners) : <span className="text-muted">none</span> },
  ];

  return (
    <Page
      title="Winning Patterns"
      subtitle={`${range.label} · ${scope.label} · ranked by worst-case hit rate`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Combinations ranked" value={num(combos.length)} sub={`of ${num(allCombos.length)} seen, ≥ ${MIN_DAYS} campaign-days`} />
        <Stat label="Book hit rate" value={pct(overall)} sub={`${num(spent.filter((r) => r.roas >= 1).length)} of ${num(spent.length)} campaign-days`} />
        <Stat
          label="Best combination"
          value={best[0] ? pct(share(best[0].winners, best[0].days)) : '–'}
          sub={best[0]?.key.slice(0, 46)}
        />
        <Stat
          label="Best launch budget"
          value={bandRank[0]?.key ?? '–'}
          sub={bandRank[0] ? `${pct(share(bandRank[0].winners, bandRank[0].days))} hit rate` : undefined}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${range.label}, ${num(spent.length)} campaign-days`} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="Hit rate by launch budget" note="worst-case rate, so small samples cannot win">
          <BarList
            fmt={(v) => pct(v)} max={100}
            rows={byBand.map((b) => ({
              label: b.key,
              value: wilson(b.winners, b.days).lo,
              sub: `${pct(share(b.winners, b.days))} raw · ${b.days} days`,
              color: '#2a78d6',
            }))}
          />
        </Card>
        <Card title="Hit rate by product" note="products with enough campaign-days to rank">
          <BarList
            fmt={(v) => pct(v)} max={100}
            rows={byProduct.slice(0, 10).map((p) => ({
              label: p.key,
              value: wilson(p.winners, p.days).lo,
              sub: `${pct(share(p.winners, p.days))} raw · ${p.days} days`,
              color: p.key === 'unmapped' ? '#5a6472' : '#1baf7a',
            }))}
          />
        </Card>
      </div>

      <Card title="Best combinations" note={`≥ ${MIN_DAYS} campaign-days, ranked by worst-case hit rate`}>
        <Table cols={cols} rows={best} empty={`No combination reached ${MIN_DAYS} campaign-days in this window.`} />
      </Card>

      <Card title="Worst combinations" note="the shapes to stop launching">
        <Table cols={cols} rows={worst} empty="Nothing to report." />
      </Card>

      <Note>
        Ranking uses the <b className="text-text-strong">lower bound</b> of the 95% interval, not
        the raw hit rate. A combination that went three-for-three has a raw rate of 100% and tells
        you nothing; ranking on the worst case is what stops it outranking one that went
        sixty-for-a-hundred. Creative tags are split, so a campaign using two styles appears in two
        combinations and the percentages do not sum to 100.
      </Note>
    </Page>
  );
}
