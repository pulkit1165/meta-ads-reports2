import {
  allocationOn, groupByProduct, findGaps, productGaps,
  type AllocCampaign, type ProductGroup, type Gap,
} from '@/lib/allocation';
import { PORTAL_NAME } from '@/lib/ads';
import { adDatesAvailable } from '@/lib/brief';
import { resolveScope, istToday, type SearchParams } from '@/lib/range';
import { rank, money, pctOf, type Finding } from '@/lib/insights';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const roasOf = (rev: number, sp: number) => (sp > 0 ? rev / sp : 0);

export default async function ProductAudiencePage({
  searchParams,
}: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const scope = resolveScope(sp);
  const available = await adDatesAvailable(20);
  const istNow = istToday();
  const asked = Array.isArray(sp?.day) ? sp.day[0] : sp?.day;
  const settled = available.filter((d) => d < istNow);
  const day = asked && available.includes(asked) ? asked : (settled[0] ?? available[0] ?? istNow);

  const controls = (
    <PageControls scope={scope} dates={false} days={available.slice(0, 10)} day={day} today={istNow} />
  );

  const rows = await allocationOn(day, scope.codes);
  if (!rows.length) {
    return (
      <Page title="Product × Audience" subtitle={`${day} · ${scope.label}`} actions={controls}>
        <Note kind="warn">No campaign had budget or spend on {day} for {scope.label}.</Note>
      </Page>
    );
  }

  const portals = [...new Set(rows.map((r) => r.portal))].sort();
  const gaps = findGaps(rows);
  const constrained = gaps.filter((g) => g.kind === 'constrained');
  const starved = gaps.filter((g) => g.kind === 'starved');
  const overfunded = gaps.filter((g) => g.kind === 'overfunded');
  const upside = constrained.reduce((s, g) => s + g.projectedRevenue, 0);
  const waste = overfunded.reduce((s, g) => s + Math.abs(g.deltaBudget), 0);

  /* ── summary: portal × tier ───────────────────────────────────────────── */
  type Sum = {
    key: string; portal: string; tier: string; active: number; paused: number;
    budget: number; spend: number; revenue: number; spend7: number; revenue7: number;
  };
  const sums = new Map<string, Sum>();
  for (const c of rows) {
    const key = `${c.portal}|${c.tier}`;
    const s = sums.get(key) ?? {
      key, portal: c.portal, tier: c.tier, active: 0, paused: 0,
      budget: 0, spend: 0, revenue: 0, spend7: 0, revenue7: 0,
    };
    if (c.status === 'ACTIVE') s.active += 1;
    if (c.status === 'PAUSED TODAY') s.paused += 1;
    s.budget += c.budget; s.spend += c.spendToday; s.revenue += c.revenueToday;
    s.spend7 += c.spend7; s.revenue7 += c.revenue7;
    sums.set(key, s);
  }
  const summary = [...sums.values()].sort(
    (a, b) => a.portal.localeCompare(b.portal) || (a.tier === 'CORE' ? -1 : 1));

  const totalBudget = rows.reduce((s, c) => s + c.budget, 0);
  const totalSpend = rows.reduce((s, c) => s + c.spendToday, 0);
  const coreBudget = rows.filter((c) => c.tier === 'CORE').reduce((s, c) => s + c.budget, 0);

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  if (constrained.length) {
    const top = constrained.slice(0, 3);
    findings.push({
      severity: 'good',
      headline: `${constrained.length} campaigns are budget-constrained and profitable`,
      detail: `They spent 85%+ of their allowance at 1.3+ ROAS over 7 days. Raising them 25% adds ${money(constrained.reduce((s, g) => s + g.deltaBudget, 0))} of daily budget and would return about ${money(upside)} a day at their current rates. Largest: ${top.map((g) => `${g.campaign.product} (${g.roas7.toFixed(2)})`).join(', ')}.`,
      action: 'These are tomorrow’s pushes: the budget is the limit, not the audience.',
    });
  }
  if (overfunded.length) {
    findings.push({
      severity: 'critical',
      headline: `${overfunded.length} campaigns reliably convert budget into loss`,
      detail: `Each spends 70%+ of its budget at under 0.80 ROAS. Cutting them 40% frees ${money(waste)} of daily budget.`,
      action: 'Move that budget to the constrained list rather than adding new money.',
    });
  }
  if (starved.length) {
    findings.push({
      severity: 'watch',
      headline: `${starved.length} good campaigns cannot spend what they already have`,
      detail: `They return 1.5+ but used under 55% of their budget. More budget will not help — the audience size or the bid is the constraint.`,
    });
  }
  findings.push({
    severity: 'neutral',
    headline: `CORE holds ${pct(pctOf(coreBudget, totalBudget))} of the allocated budget`,
    detail: `${money(coreBudget)} of ${money(totalBudget)} on ${day}, spending ${pct(pctOf(totalSpend, totalBudget))} of the book overall.`,
  });

  /* ── tables ───────────────────────────────────────────────────────────── */
  const sumCols: Col<Sum>[] = [
    { key: 'p', head: 'Portal', align: 'l', render: (s) => PORTAL_NAME[s.portal] ?? s.portal },
    { key: 't', head: 'Section', align: 'l', render: (s) => (
        <span className={s.tier === 'CORE' ? 'text-gold' : 'text-muted'}>{s.tier}</span>
      ) },
    { key: 'a', head: '# Active', align: 'r', render: (s) => num(s.active) },
    { key: 'x', head: '# Paused today', align: 'r', render: (s) => num(s.paused) },
    { key: 'b', head: 'Daily budget', align: 'r', render: (s) => rs(s.budget) },
    { key: 's', head: 'Today spend', align: 'r', render: (s) => rs(s.spend) },
    { key: 'u', head: 'Used', align: 'r', render: (s) => pct(pctOf(s.spend, s.budget)) },
    { key: 'r', head: 'Today ROAS', align: 'r', render: (s) => <Roas v={roasOf(s.revenue, s.spend)} /> },
    { key: 's7', head: '7d spend', align: 'r', render: (s) => rs(s.spend7) },
    { key: 'r7', head: '7d ROAS', align: 'r', render: (s) => <Roas v={roasOf(s.revenue7, s.spend7)} /> },
  ];

  const gapCols: Col<Gap>[] = [
    { key: 'k', head: 'Gap', align: 'l', render: (g) => (
        <span className={
          g.kind === 'constrained' ? 'text-good'
            : g.kind === 'overfunded' ? 'text-bad' : 'text-warn'
        }>
          {g.kind === 'constrained' ? 'push' : g.kind === 'overfunded' ? 'cut' : 'stuck'}
        </span>
      ) },
    { key: 'pr', head: 'Product', align: 'l', render: (g) => (
        <span className="block max-w-[180px] truncate" title={g.campaign.product}>{g.campaign.product}</span>
      ) },
    { key: 'c', head: 'Campaign', align: 'l', render: (g) => (
        <span className="block max-w-[260px] truncate text-muted" title={g.campaign.campaignName}>
          {g.campaign.campaignName}
        </span>
      ) },
    { key: 'au', head: 'Audience', align: 'l', render: (g) => g.campaign.audience },
    { key: 'b', head: 'Budget', align: 'r', render: (g) => rs(g.campaign.budget) },
    { key: 'u', head: 'Used', align: 'r', render: (g) => pct(g.utilisation * 100) },
    { key: 'r', head: '7d ROAS', align: 'r', render: (g) => <Roas v={g.roas7} /> },
    { key: 'sg', head: 'Suggested', align: 'r', render: (g) =>
        g.deltaBudget === 0
          ? <span className="text-muted">no change</span>
          : <span className={g.deltaBudget > 0 ? 'text-good' : 'text-bad'}>
              {rs(g.suggestedBudget)} ({g.deltaBudget > 0 ? '+' : ''}{rs(g.deltaBudget)})
            </span> },
    { key: 'pj', head: 'Projected/day', align: 'r', render: (g) =>
        g.projectedRevenue === 0
          ? <span className="text-muted">–</span>
          : <span className={g.projectedRevenue > 0 ? 'text-good' : 'text-bad'}>
              {g.projectedRevenue > 0 ? '+' : ''}{rs(g.projectedRevenue)}
            </span> },
  ];

  const campCols: Col<AllocCampaign>[] = [
    { key: 'a', head: 'Audience', align: 'l', render: (c) => (
        <span className="rounded bg-gold/15 px-1.5 py-0.5 text-[11px] text-gold">{c.audience}</span>
      ) },
    { key: 's', head: 'Status', align: 'l', render: (c) => (
        <span className={c.status === 'ACTIVE' ? 'text-good' : c.status === 'PAUSED TODAY' ? 'text-warn' : 'text-muted'}>
          {c.status}
        </span>
      ) },
    { key: 'n', head: 'Campaign', align: 'l', render: (c) => (
        <span className="block max-w-[320px] truncate" title={c.campaignName}>{c.campaignName}</span>
      ) },
    { key: 'b', head: 'Daily budget', align: 'r', render: (c) => rs(c.budget) },
    { key: 'sp', head: 'Spend', align: 'r', render: (c) => rs(c.spendToday) },
    { key: 'u', head: 'Used', align: 'r', render: (c) => c.budget > 0 ? pct(pctOf(c.spendToday, c.budget)) : '–' },
    { key: 'r', head: 'Today ROAS', align: 'r', render: (c) => <Roas v={roasOf(c.revenueToday, c.spendToday)} /> },
    { key: 'r7', head: '7d ROAS', align: 'r', render: (c) => <Roas v={roasOf(c.revenue7, c.spend7)} /> },
  ];

  return (
    <Page
      title="Product × Audience"
      subtitle={`${day} · ${scope.label} · budget allocation and tomorrow's gaps`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Daily budget" value={lakh(totalBudget)} sub={`${num(rows.length)} campaigns with budget or spend`} />
        <Stat label="Spent" value={lakh(totalSpend)} sub={`${pct(pctOf(totalSpend, totalBudget))} of the book`} />
        <Stat
          label="Push tomorrow"
          value={num(constrained.length)}
          sub={upside > 0 ? `about ${rs(upside)}/day of upside at current rates` : 'nothing is budget-constrained'}
        />
        <Stat
          label="Cut tomorrow"
          value={num(overfunded.length)}
          sub={waste > 0 ? `${rs(waste)}/day could move elsewhere` : 'nothing is reliably losing'}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${day}, ${num(rows.length)} campaigns`} />

      <Card
        title="Tomorrow's pushes and cuts"
        note="ranked by the size of the projected daily move"
      >
        <Table
          cols={gapCols}
          rows={gaps.slice(0, 40)}
          empty="No campaign crossed a push, cut or stuck threshold on this day."
        />
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
          <b className="text-text-strong">push</b> means it spent 85%+ of its budget at 1.3+ ROAS —
          budget is the limit, not the audience. <b className="text-text-strong">cut</b> means it
          spends 70%+ of budget under 0.80 and converts budget into loss reliably.{' '}
          <b className="text-text-strong">stuck</b> returns 1.5+ but cannot spend what it already
          has, so more budget would change nothing. Projections assume the extra spend returns at
          the campaign&apos;s own 7-day rate — new budget usually buys slightly worse impressions
          than the budget already running, so read it as a ceiling rather than a forecast.
        </p>
      </Card>

      <Card title="Summary" note="portal × section, as the workbook lays it out">
        <Table cols={sumCols} rows={summary} />
      </Card>

      {portals.map((p) => {
        const groups = groupByProduct(rows.filter((r) => r.portal === p));
        const core = groups.filter((g) => g.tier === 'CORE');
        const supp = groups.filter((g) => g.tier === 'SUPPORT');
        const section = (title: string, gs: ProductGroup[]) =>
          gs.length === 0 ? null : (
            <div className="space-y-3">
              <div className="text-[10.5px] uppercase tracking-[0.16em] text-muted">
                {title} · {gs.length} products ·{' '}
                {gs.reduce((s, g) => s + g.active, 0)}A + {gs.reduce((s, g) => s + g.pausedToday, 0)}P
              </div>
              {gs.map((g) => (
                <div key={g.product} className="rounded-lg border border-edge/70">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-edge/70 px-3 py-2">
                    <span className="text-[12.5px] font-medium text-text-strong">{g.product}</span>
                    <span className="text-[11px] text-muted">{g.active}A + {g.pausedToday}P</span>
                    <span className="text-[11px] text-muted">Bud {rs(g.budget)}</span>
                    <span className="text-[11px] text-muted">Spent {rs(g.spendToday)}</span>
                    <span className="ml-auto flex items-center gap-2 text-[11px] text-muted">
                      today <Roas v={roasOf(g.revenueToday, g.spendToday)} />
                      7d <Roas v={roasOf(g.revenue7, g.spend7)} />
                    </span>
                  </div>
                  <div className="px-1 pb-1">
                    <Table cols={campCols} rows={g.campaigns} />
                  </div>
                </div>
              ))}
            </div>
          );
        return (
          <Card key={p} title={PORTAL_NAME[p] ?? p} note={`${groups.length} products on ${day}`}>
            <div className="space-y-6">
              {section('★ Core products', core)}
              {section('Supporting products', supp)}
            </div>
          </Card>
        );
      })}

      <Note>
        Products come from the same classifier the rest of the reporting uses, synced into{' '}
        <span className="text-text">camp_product_resolved</span>, so this page groups exactly as the
        daily reports do. Audience codes are read from the campaign name, which is where the
        targeting is actually written. <b className="text-text-strong">CORE/SUPPORT is a curated
        list</b> seeded from your workbook — 40 of its 61 entries matched a classifier product; the
        rest were offer and category labels rather than products, and fall to SUPPORT rather than
        being invented. Tell me where that list is maintained and I will read it from source.
      </Note>
    </Page>
  );
}
