import {
  adDays, adDatesAvailable, accumulate, emptyPerf, perfRoas, blockCodes,
  type AdRow, type Perf,
} from '@/lib/brief';
import { ydayFinal, totalRow, chg, type YdayRow } from '@/lib/yday';
import { changesOn, tally, sentimentsFor, typesFor } from '@/lib/changes';
import { roasOf, share, bandOf, PORTAL_NAME } from '@/lib/ads';
import { resolveScope, istToday, type SearchParams } from '@/lib/range';
import { rank, wilson, enough, money, pctOf, type Finding } from '@/lib/insights';
import { dailyClosing, shareOf } from '@/lib/closingdaily';
import { weekday, isWeekend, dayLabel } from '@/lib/range';
import {
  closingBook, cleanSlate, slateTotal, learningBudget, learningTotal, profitFor,
  moveFor, MOVE_TEXT, PUSH_AT, MINUS_BELOW, AGE_TARGETS, type Move,
} from '@/lib/plan';
import ProfitBoard, { type ProfitSite } from '@/components/ProfitBoard';
import { BarList, SERIES, ROAS_BANDS } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, Delta, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Push, maintain or minus, coloured the way the desk reads them. */
function MoveChip({ move }: { move: Move }) {
  const cls = move === 'push'
    ? 'bg-good/15 text-good'
    : move === 'minus' ? 'bg-bad/15 text-bad' : 'bg-warn/15 text-warn';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-medium ${cls}`}>
      {MOVE_TEXT[move]}
    </span>
  );
}

/** Attempts before an elimination decision is defensible, per the template. */
const MIN_ATTEMPTS = 15;

export default async function BriefPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const scope = resolveScope(sp);

  // The brief is about one day, and the default has to be the last COMPLETE
  // one. Today is in the table from the first hour, but revenue is attributed
  // later than spend, so defaulting to it would show a half-finished day as if
  // it were final — sales reading a third of normal against full budgets.
  const available = await adDatesAvailable(120);
  const today = istToday();
  const asked = Array.isArray(sp?.day) ? sp.day[0] : sp?.day;
  const settled = available.filter((d) => d < today);
  const day = asked && available.includes(asked)
    ? asked
    : (settled[0] ?? available[0]);

  // Ten days to choose from, with today kept as an explicit option rather than
  // hidden — looking at it is legitimate as long as it is labelled partial.
  const pickable = available.slice(0, 10);

  const controls = (
    <PageControls scope={scope} dates={false} days={pickable} day={day} today={today} />
  );

  if (!day) {
    return (
      <Page title="Yesterday's Brief" subtitle="No ad-level data" actions={controls}>
        <Note kind="warn">
          <span className="text-warn">meta_analysis_ad_daily</span> is empty, so the brief has
          nothing to build from. It is the only table carrying ad ids alongside sale block,
          creative type and product.
        </Note>
      </Page>
    );
  }

  // A trailing window gives the elimination section enough attempts to mean
  // something; every other section reports the single day.
  const fromISO = new Date(Date.parse(day) - 29 * 86400000).toISOString().slice(0, 10);
  const prevDay = new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
  const [dayRows, history, finalRows, prevRows, changes, book, profits, byDay] = await Promise.all([
    adDays(day, day, scope.codes),
    adDays(fromISO, day, scope.codes),
    ydayFinal(day, scope.codes),
    ydayFinal(prevDay, scope.codes),
    changesOn(day, scope.codes),
    closingBook(day, day, scope.codes),
    profitFor(day),
    dailyClosing(
      new Date(Date.parse(day) - 13 * 86400000).toISOString().slice(0, 10),
      day, scope.codes,
    ).catch(() => []),
  ]);

  if (!dayRows.length) {
    return (
      <Page title="Yesterday's Brief" subtitle={`${day} · ${scope.label}`} actions={controls}>
        <Note kind="warn">No ad rows for {day} on {scope.label}.</Note>
      </Page>
    );
  }

  const spent = dayRows.filter((r) => r.spend > 0);
  const totalSpend = spent.reduce((s, r) => s + r.spend, 0);
  const totalRev = spent.reduce((s, r) => s + r.revenue, 0);

  /* ── 1. sale block code chart ─────────────────────────────────────────── */
  const blockPerf = new Map<string, Perf>();
  for (const r of spent) accumulate(blockPerf, r.saleBlock, r);
  const blocksRanked = [...blockPerf.values()].sort((a, b) => b.spend - a.spend);
  const codes = blockCodes(blocksRanked.map((b) => b.key));
  const codeOf = (b: string) => codes.get(b) ?? '?';

  /* ── 2 & 3. by product ────────────────────────────────────────────────── */
  const prodPerf = new Map<string, Perf>();
  for (const r of spent) accumulate(prodPerf, r.product, r);
  const products = [...prodPerf.values()].sort((a, b) => b.spend - a.spend).slice(0, 10);

  /** Best sub-key within a product, by ROAS among those with real spend. */
  function bestWithin(product: string, keyOf: (r: AdRow) => string[]) {
    const m = new Map<string, Perf>();
    for (const r of spent.filter((x) => x.product === product)) {
      for (const k of keyOf(r)) accumulate(m, k, r);
    }
    const cands = [...m.values()].filter((p) => p.spend >= 300);
    return cands.sort((a, b) => perfRoas(b) - perfRoas(a))[0] ?? null;
  }

  const creativeTagsOf = (r: AdRow) =>
    r.creativeType.split('|').map((x) => x.trim()).filter(Boolean) || ['unclassified'];

  type PRow = { product: string; perf: Perf; bestBlock: Perf | null; bestCreative: Perf | null };
  const prows: PRow[] = products.map((p) => ({
    product: p.key,
    perf: p,
    bestBlock: bestWithin(p.key, (r) => [r.saleBlock]),
    bestCreative: bestWithin(p.key, creativeTagsOf),
  }));

  /* ── 6. best combination per product ──────────────────────────────────── */
  type Combo = { product: string; block: string; creative: string; ad: string; adName: string; spend: number; rev: number };
  const combos: Combo[] = [];
  for (const p of products) {
    const m = new Map<string, Combo>();
    for (const r of spent.filter((x) => x.product === p.key)) {
      for (const t of creativeTagsOf(r)) {
        const k = `${r.saleBlock}||${t}||${r.adId}`;
        const c = m.get(k) ?? {
          product: p.key, block: r.saleBlock, creative: t,
          ad: r.adId, adName: r.adName, spend: 0, rev: 0,
        };
        c.spend += r.spend; c.rev += r.revenue;
        m.set(k, c);
      }
    }
    const best = [...m.values()].filter((c) => c.spend >= 300)
      .sort((a, b) => roasOf(b.rev, b.spend) - roasOf(a.rev, a.spend))[0];
    if (best) combos.push(best);
  }

  /* ── 7. elimination candidates ────────────────────────────────────────── */
  type Elim = { kind: string; key: string; attempts: number; winners: number; spend: number; rev: number };
  function elimOf(kind: string, keyOf: (r: AdRow) => string[]): Elim[] {
    const m = new Map<string, Elim>();
    for (const r of history.filter((x) => x.spend > 0)) {
      for (const k of keyOf(r)) {
        const e = m.get(k) ?? { kind, key: k, attempts: 0, winners: 0, spend: 0, rev: 0 };
        e.attempts += 1;
        e.spend += r.spend; e.rev += r.revenue;
        if (r.spend > 0 && r.revenue / r.spend >= 1) e.winners += 1;
        m.set(k, e);
      }
    }
    return [...m.values()].filter(
      (e) => enough(e.attempts, MIN_ATTEMPTS) && wilson(e.winners, e.attempts).hi < 30,
    );
  }
  const elims = [
    ...elimOf('Sale block', (r) => [r.saleBlock]),
    ...elimOf('Creative type', creativeTagsOf),
    ...elimOf('Product + block', (r) => [`${r.product} + ${r.saleBlock}`]),
  ].sort((a, b) => b.spend - a.spend).slice(0, 12);


  /* ── the day's final figures, as the printed report defines them ──────── */
  const finals = [...finalRows.filter((r) => r.budget > 0 || r.sales > 0), totalRow(finalRows)];
  const prevOf = (portal: string) =>
    portal === 'All' ? totalRow(prevRows) : prevRows.find((r) => r.portal === portal);

  const roasOfRow = (r: YdayRow) => (r.spend > 0 ? r.sales / r.spend : 0);
  const spentPct = (r: YdayRow) => (r.budget > 0 ? (r.spend / r.budget) * 100 : 0);
  const closedPct = (r: YdayRow) => (r.budget > 0 ? (r.closed / r.budget) * 100 : 0);
  const name = (p: string) => (p === 'All' ? 'All' : PORTAL_NAME[p] ?? p);

  const finalCols: Col<YdayRow>[] = [
    { key: 'w', head: 'Website', align: 'l', render: (r) => (
        <span className={r.portal === 'All' ? 'font-medium' : ''}>{name(r.portal)}</span>
      ) },
    { key: 's', head: 'Sales', align: 'r', render: (r) => rs(r.sales) },
    { key: 'o', head: 'Orders', align: 'r', render: (r) => num(r.orders) },
    { key: 'b', head: 'Budget', align: 'r', render: (r) => rs(r.budget) },
    { key: 'sp', head: 'Spend', align: 'r', render: (r) => rs(r.spend) },
    { key: 'pc', head: 'Spent %', align: 'r', render: (r) => pct(spentPct(r)) },
    { key: 'ro', head: 'ROAS', align: 'r', render: (r) => <Roas v={roasOfRow(r)} /> },
    { key: 'cl', head: 'Closed', align: 'r', render: (r) => rs(r.closed) },
    { key: 'cp', head: 'Closed %', align: 'r', render: (r) => pct(closedPct(r)) },
    { key: 'lv', head: 'Live @10PM', align: 'r', render: (r) => rs(r.live) },
  ];

  /** prev > now (±%), with the change coloured only where up-is-better holds. */
  const cmp = (r: YdayRow, pick: (x: YdayRow) => number, tone: 'auto' | 'flat' = 'auto') => {
    const p = prevOf(r.portal);
    if (!p) return <span className="text-muted">–</span>;
    const before = pick(p), now = pick(r);
    const d = chg(now, before);
    return (
      <span className="whitespace-nowrap">
        <span className="text-muted">{num(before)} &rsaquo; </span>
        {num(now)}
        {d != null && <span className="ml-1.5"><Delta v={d} tone={tone} /></span>}
      </span>
    );
  };

  const vsCols: Col<YdayRow>[] = [
    { key: 'w', head: 'Website', align: 'l', render: (r) => (
        <span className={r.portal === 'All' ? 'font-medium' : ''}>{name(r.portal)}</span>
      ) },
    { key: 's', head: 'Sales', align: 'r', render: (r) => cmp(r, (x) => x.sales) },
    { key: 'o', head: 'Orders', align: 'r', render: (r) => cmp(r, (x) => x.orders) },
    { key: 'sp', head: 'Spend', align: 'r', render: (r) => cmp(r, (x) => x.spend, 'flat') },
    { key: 'pc', head: 'Spent %', align: 'r', render: (r) => {
        const p = prevOf(r.portal);
        return p
          ? <span className="whitespace-nowrap text-muted">{pct(spentPct(p))} &rsaquo; <span className="text-text">{pct(spentPct(r))}</span></span>
          : <span className="text-muted">–</span>;
      } },
    { key: 'cl', head: 'Closed', align: 'r', render: (r) => cmp(r, (x) => x.closed, 'flat') },
    { key: 'cp', head: 'Closed %', align: 'r', render: (r) => {
        const p = prevOf(r.portal);
        return p
          ? <span className="whitespace-nowrap text-muted">{pct(closedPct(p))} &rsaquo; <span className="text-text">{pct(closedPct(r))}</span></span>
          : <span className="text-muted">–</span>;
      } },
    { key: 'lv', head: 'Live @10PM', align: 'r', render: (r) => cmp(r, (x) => x.live, 'flat') },
    { key: 'ro', head: 'ROAS', align: 'r', render: (r) => {
        const p = prevOf(r.portal);
        if (!p) return <span className="text-muted">–</span>;
        const d = roasOfRow(r) - roasOfRow(p);
        return (
          <span className={`whitespace-nowrap ${d > 0 ? 'text-good' : d < 0 ? 'text-bad' : 'text-muted'}`}>
            {d > 0 ? '+' : ''}{d.toFixed(2)}
          </span>
        );
      } },
  ];


  /* ── what changed on the ads today ────────────────────────────────────── */
  const freshCreatives = changes.newCreatives.filter((c) => !c.intoExisting);
  const refreshCreatives = changes.newCreatives.filter((c) => c.intoExisting);
  const newCampBudget = changes.newCampaigns.reduce((s2, c) => s2 + c.budget, 0);
  const newCampSpend = changes.newCampaigns.reduce((s2, c) => s2 + c.spend, 0);
  const newCampRev = changes.newCampaigns.reduce((s2, c) => s2 + c.revenue, 0);
  const raises = changes.budgetMoves.filter((m) => m.delta > 0);
  const cuts = changes.budgetMoves.filter((m) => m.delta < 0);
  const raised = raises.reduce((s2, m) => s2 + m.delta, 0);
  const cutAmt = cuts.reduce((s2, m) => s2 + Math.abs(m.delta), 0);
  const reactBudget = changes.reactivations.reduce((s2, r) => s2 + r.budget, 0);

  const newBlocks = tally(changes.newCampaigns, (c) => [c.saleBlock]);
  const newTypes = tally(changes.newCreatives, typesFor);
  const newSentiments = tally(changes.newCreatives, sentimentsFor);

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const topProd = products[0];
  if (topProd) {
    findings.push({
      severity: perfRoas(topProd) >= 1 ? 'good' : 'watch',
      headline: `${topProd.key} carried the day at ${perfRoas(topProd).toFixed(2)} ROAS`,
      detail: `${money(topProd.spend)} — ${pctOf(topProd.spend, totalSpend).toFixed(0)}% of the day — across ${topProd.ads.size} creatives in ${topProd.blocks.size} sale blocks.`,
    });
  }
  if (elims.length) {
    findings.push({
      severity: 'critical',
      headline: `${elims.length} candidate${elims.length > 1 ? 's have' : ' has'} failed enough times to eliminate`,
      detail: `Each has at least ${MIN_ATTEMPTS} completed attempts over 30 days and a hit rate whose best case is still under 30%. Combined they have spent ${money(elims.reduce((s, e) => s + e.spend, 0))}.`,
      action: 'The template asks for 15+ attempts before a decision. These clear that bar.',
    });
  }
  const noWinner = prows.filter((p) => p.bestBlock && perfRoas(p.bestBlock) < 1);
  if (noWinner.length) {
    findings.push({
      severity: 'watch',
      headline: `${noWinner.length} product${noWinner.length > 1 ? 's had' : ' had'} no block clear 1.0`,
      detail: noWinner.slice(0, 3).map((p) => `${p.product} (best ${perfRoas(p.bestBlock!).toFixed(2)})`).join('; ') + '.',
    });
  }

  /* ── profit, decisions, the clean slate, and what is still learning ───── */
  const profitOf = (portal: string) => profits.find((e) => e.portal === portal);
  const profitSites: ProfitSite[] = [
    ...finalRows.map((f) => ({
      portal: f.portal,
      name: PORTAL_NAME[f.portal] ?? f.portal,
      sales: f.sales,
      spend: f.spend,
      profit: profitOf(f.portal)?.profit ?? null,
      note: profitOf(f.portal)?.note ?? '',
      updatedAt: profitOf(f.portal)?.updatedAt ?? null,
    })),
    {
      portal: 'ALL', name: 'All three',
      sales: finalRows.reduce((a, f) => a + f.sales, 0),
      spend: finalRows.reduce((a, f) => a + f.spend, 0),
      profit: profitOf('ALL')?.profit ?? null,
      note: profitOf('ALL')?.note ?? '',
      updatedAt: profitOf('ALL')?.updatedAt ?? null,
    },
  ];

  // Portal decisions run on the SHOPIFY ratio the sales report shows, product
  // decisions on Meta revenue — the shop cannot attribute a sale to a product's
  // ads, and Meta can. Two measures, each used where it is the honest one.
  type Decision = {
    key: string; name: string; spend: number; revenue: number; roas: number;
    move: Move; camps?: number; source: 'shop' | 'meta';
  };
  const portalDecisions: Decision[] = finalRows.map((f) => ({
    key: f.portal,
    name: PORTAL_NAME[f.portal] ?? f.portal,
    spend: f.spend,
    revenue: f.sales,
    roas: roasOf(f.sales, f.spend),
    move: moveFor(roasOf(f.sales, f.spend)),
    source: 'shop' as const,
  }));

  const MIN_DECIDE = 300;
  const productDecisions: Decision[] = [...prodPerf.values()]
    .filter((pp) => pp.spend >= MIN_DECIDE)
    .map((pp) => ({
      key: pp.key,
      name: pp.key,
      spend: pp.spend,
      revenue: pp.revenue,
      roas: perfRoas(pp),
      move: moveFor(perfRoas(pp)),
      source: 'meta' as const,
    }))
    .sort((a, b) => b.spend - a.spend);

  const DECIDE_ROWS = 30;
  const shownDecisions = productDecisions.slice(0, DECIDE_ROWS);
  const hiddenDecisions = productDecisions.length - shownDecisions.length;
  const hiddenSpend = productDecisions.slice(DECIDE_ROWS).reduce((a, d) => a + d.spend, 0);

  const moveCount = (m: Move) => productDecisions.filter((d) => d.move === m).length;
  const moveSpend = (m: Move) =>
    productDecisions.filter((d) => d.move === m).reduce((a, d) => a + d.spend, 0);

  // The same campaigns as the clean slate, banded by what they returned
  // instead of by how old they are — the two answer different questions off
  // one fetch.
  const buckets = ROAS_BANDS.map((b) => {
    const rows = book.filter((r) => r.spend > 0 && bandOf(roasOf(r.revenue, r.spend)) === b.key);
    const spend = rows.reduce((a, r) => a + r.spend, 0);
    const revenue = rows.reduce((a, r) => a + r.revenue, 0);
    return {
      key: b.key, label: b.label, color: b.color,
      camps: rows.length,
      budget: rows.reduce((a, r) => a + r.budget, 0),
      spend, revenue, roas: roasOf(revenue, spend),
      closed: rows.filter((r) => r.closed).length,
    };
  }).filter((b) => b.camps > 0);
  const bucketTotal = {
    key: 'all', label: 'All campaigns', color: '',
    camps: buckets.reduce((a, b) => a + b.camps, 0),
    budget: buckets.reduce((a, b) => a + b.budget, 0),
    spend: buckets.reduce((a, b) => a + b.spend, 0),
    revenue: buckets.reduce((a, b) => a + b.revenue, 0),
    roas: roasOf(buckets.reduce((a, b) => a + b.revenue, 0), buckets.reduce((a, b) => a + b.spend, 0)),
    closed: buckets.reduce((a, b) => a + b.closed, 0),
  };

  const slate = cleanSlate(book);
  const slateAll = slateTotal(slate);
  const learning = learningBudget(book);
  const learningAll = learningTotal(learning);

  /* ── scale and cut, on four cuts of the same day ──────────────────────── */
  const offerPerf = new Map<string, Perf>();
  for (const r of spent) if (r.offer) accumulate(offerPerf, r.offer, r);
  const untaggedSpend = spent.filter((r) => !r.offer).reduce((a, r) => a + r.spend, 0);

  type Cut = {
    dim: string; key: string; spend: number; revenue: number; roas: number; net: number;
  };
  const toCuts = (m: Map<string, Perf>, dim: string, floor: number): Cut[] =>
    [...m.values()]
      .filter((x) => x.spend >= floor)
      .map((x) => ({
        dim, key: x.key, spend: x.spend, revenue: x.revenue,
        roas: perfRoas(x), net: x.revenue - x.spend,
      }));

  const FLOOR = 1000;
  const cutPool = [
    ...toCuts(blockPerf, 'Sale block', FLOOR),
    ...toCuts(prodPerf, 'Product', FLOOR),
    ...toCuts(offerPerf, 'Deal', FLOOR),
  ];
  const bestOf = (dim: string, n = 3) =>
    cutPool.filter((c) => c.dim === dim).sort((a, b) => b.roas - a.roas).slice(0, n);
  const worstOf = (dim: string, n = 3) =>
    cutPool.filter((c) => c.dim === dim).sort((a, b) => a.roas - b.roas).slice(0, n);
  // Profitability ranks on rupees kept, not on the ratio: a 3.0 on Rs 2,000 of
  // spend is a good sign and Rs 4,000 of margin; a 1.6 on Rs 2 lakh is the one
  // paying the bills.
  const bestMoney = [...cutPool].filter((c) => c.dim === 'Product')
    .sort((a, b) => b.net - a.net).slice(0, 3)
    .map((c) => ({ ...c, dim: 'Profitability' }));
  const worstMoney = [...cutPool].filter((c) => c.dim === 'Product')
    .sort((a, b) => a.net - b.net).slice(0, 3)
    .map((c) => ({ ...c, dim: 'Profitability' }));

  const scaleRows: Cut[] = [
    ...bestOf('Sale block'), ...bestOf('Product'), ...bestOf('Deal'), ...bestMoney,
  ];
  const cutRows: Cut[] = [
    ...worstOf('Sale block'), ...worstOf('Product'), ...worstOf('Deal'), ...worstMoney,
  ];

  const slateCols: Col<ReturnType<typeof cleanSlate>[number]>[] = [
    { key: 'b', head: 'Age', align: 'l', render: (r) => r.label },
    { key: 't', head: 'Target', align: 'r', render: (r) => (
        r.target ? <span className="text-muted tabular-nums">{r.target.toFixed(2)}</span>
                 : <span className="text-muted">–</span>) },
    { key: 'c', head: 'Camps', align: 'r', render: (r) => num(r.camps) },
    { key: 'bu', head: 'Budget', align: 'r', render: (r) => rs(r.budget) },
    { key: 'sp', head: 'Spend', align: 'r', render: (r) => rs(r.spend) },
    { key: 'ro', head: 'ROAS', align: 'r', render: (r) => <Roas v={r.roas} /> },
    { key: 'kc', head: 'Keep', align: 'r', render: (r) => (
        <span className="whitespace-nowrap text-good">{num(r.keepCamps)} · {rs(r.keepBudget)}</span>) },
    { key: 'cc', head: 'Cut', align: 'r', render: (r) => (
        <span className="whitespace-nowrap text-bad">{num(r.cutCamps)} · {rs(r.cutBudget)}</span>) },
    { key: 'ic', head: 'Never spent', align: 'r', render: (r) => (
        <span className="whitespace-nowrap text-muted">{num(r.idleCamps)} · {rs(r.idleBudget)}</span>) },
    { key: 'kp', head: 'Book kept', align: 'r', render: (r) => (
        <span className="tabular-nums">{pct(share(r.keepBudget, r.budget))}</span>) },
  ];

  const learnCols: Col<ReturnType<typeof learningBudget>[number]>[] = [
    { key: 'p', head: 'Website', align: 'l', render: (r) => (
        <span className={r.portal === 'all' ? 'font-medium' : ''}>
          {r.portal === 'all' ? 'All three' : (PORTAL_NAME[r.portal] ?? r.portal)}
        </span>) },
    { key: 'c', head: 'Launches', align: 'r', render: (r) => num(r.camps) },
    { key: 'a', head: 'Allocated', align: 'r', render: (r) => rs(r.allocated) },
    { key: 's', head: 'Spend', align: 'r', render: (r) => rs(r.spend) },
    { key: 'sp', head: 'Spend %', align: 'r', render: (r) => (
        <span className="text-muted">{pct(share(r.spend, r.allocated))}</span>) },
    { key: 'ro', head: 'ROAS', align: 'r', render: (r) => <Roas v={r.roas} /> },
    { key: 'ac', head: 'Still active', align: 'r', render: (r) => (
        <span className="whitespace-nowrap">{num(r.activeCamps)} · {rs(r.active)}</span>) },
    { key: 'cl', head: 'Switched off', align: 'r', render: (r) => (
        <span className="whitespace-nowrap text-muted">{num(r.closedCamps)} · {rs(r.closed)}</span>) },
    { key: 'cp', head: 'Off %', align: 'r', render: (r) => (
        <span className={share(r.closed, r.allocated) >= 70 ? 'text-warn' : 'text-muted'}>
          {pct(share(r.closed, r.allocated))}
        </span>) },
  ];

  const bucketCols: Col<typeof bucketTotal>[] = [
    { key: 'b', head: 'ROAS at close of day', align: 'l', render: (b) => (
        <span className="whitespace-nowrap">
          {b.color && (
            <span className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                  style={{ background: b.color }} />
          )}
          <span className="align-middle">{b.label}</span>
        </span>) },
    { key: 'c', head: 'Camps', align: 'r', render: (b) => num(b.camps) },
    { key: 'bu', head: 'Budget', align: 'r', render: (b) => rs(b.budget) },
    { key: 's', head: 'Spend', align: 'r', render: (b) => rs(b.spend) },
    { key: 'sh', head: 'Share of spend', align: 'r', render: (b) => (
        <span className="text-muted">{pct(share(b.spend, bucketTotal.spend))}</span>) },
    { key: 'rv', head: 'Revenue', align: 'r', render: (b) => rs(b.revenue) },
    { key: 'n', head: 'After ad cost', align: 'r', render: (b) => (
        <span className={b.revenue - b.spend < 0 ? 'text-bad' : 'text-good'}>
          {rs(b.revenue - b.spend)}
        </span>) },
    { key: 'cl', head: 'Closed', align: 'r', render: (b) => (
        <span className="text-muted">{num(b.closed)}</span>) },
    { key: 'r', head: 'ROAS', align: 'r', render: (b) => <Roas v={b.roas} /> },
  ];

  const dayCols: Col<(typeof byDay)[number]>[] = [
    { key: 'w', head: 'Day', align: 'l', render: (d) => (
        <span className={isWeekend(d.date) ? 'text-muted/70' : 'text-muted'}>{weekday(d.date)}</span>) },
    { key: 'd', head: 'Date', align: 'l', render: (d) => (
        <span className={d.date === day ? 'text-gold' : ''}>{dayLabel(d.date)}</span>) },
    { key: 'c', head: 'Camps', align: 'r', render: (d) => num(d.camps) },
    { key: 'a', head: 'Allocated', align: 'r', render: (d) => rs(d.allocated) },
    { key: 's', head: 'Spend', align: 'r', render: (d) => rs(d.spend) },
    { key: 'sp', head: 'Spend %', align: 'r', render: (d) => (
        <span className="text-muted">{pct(shareOf(d.spend, d.allocated))}</span>) },
    { key: 'rv', head: 'Revenue', align: 'r', render: (d) => rs(d.revenue) },
    { key: 'n', head: 'After ad cost', align: 'r', render: (d) => (
        <span className={d.revenue - d.spend < 0 ? 'text-bad' : 'text-good'}>
          {rs(d.revenue - d.spend)}
        </span>) },
    { key: 'cb', head: 'Closed', align: 'r', render: (d) => rs(d.closed) },
    { key: 'cp', head: 'Closed %', align: 'r', render: (d) => (
        <span className={shareOf(d.closed, d.allocated) >= 70 ? 'text-warn' : 'text-muted'}>
          {pct(shareOf(d.closed, d.allocated))}
        </span>) },
    { key: 'r', head: 'ROAS', align: 'r', render: (d) => <Roas v={roasOf(d.revenue, d.spend)} /> },
  ];

  const decisionCols: Col<Decision>[] = [
    { key: 'n', head: 'Name', align: 'l', render: (d) => (
        <span className="block max-w-[280px] truncate" title={d.name}>{d.name}</span>) },
    { key: 's', head: 'Spend', align: 'r', render: (d) => rs(d.spend) },
    { key: 'rv', head: 'Revenue', align: 'r', render: (d) => rs(d.revenue) },
    { key: 'r', head: 'ROAS', align: 'r', render: (d) => <Roas v={d.roas} /> },
    { key: 'm', head: 'Tomorrow', align: 'l', render: (d) => <MoveChip move={d.move} /> },
  ];

  const cutCols: Col<Cut>[] = [
    { key: 'd', head: 'Cut', align: 'l', render: (c) => <span className="text-muted">{c.dim}</span> },
    { key: 'k', head: 'Name', align: 'l', render: (c) => (
        <span className="block max-w-[260px] truncate" title={c.key}>{c.key}</span>) },
    { key: 's', head: 'Spend', align: 'r', render: (c) => rs(c.spend) },
    { key: 'rv', head: 'Revenue', align: 'r', render: (c) => rs(c.revenue) },
    { key: 'n', head: 'After ad cost', align: 'r', render: (c) => (
        <span className={c.net < 0 ? 'text-bad' : 'text-good'}>{rs(c.net)}</span>) },
    { key: 'r', head: 'ROAS', align: 'r', render: (c) => <Roas v={c.roas} /> },
  ];

  /* ── tables ───────────────────────────────────────────────────────────── */
  const blockCols: Col<Perf>[] = [
    { key: 'c', head: 'Code', align: 'l', render: (b) => (
        <span className="rounded bg-gold/15 px-1.5 py-0.5 font-medium text-gold">{codeOf(b.key)}</span>
      ) },
    { key: 'b', head: 'Complete audience settings', align: 'l', render: (b) => (
        <span className="block max-w-[520px] truncate" title={b.key}>{b.key}</span>
      ) },
    { key: 'a', head: 'Creatives', align: 'r', render: (b) => num(b.ads.size) },
    { key: 's', head: 'Spend', align: 'r', render: (b) => rs(b.spend) },
    { key: 'r', head: 'ROAS', align: 'r', render: (b) => <Roas v={perfRoas(b)} /> },
  ];

  const prodCols: Col<PRow>[] = [
    { key: 'p', head: 'Product', align: 'l', render: (p) => (
        <span className="block max-w-[200px] truncate" title={p.product}>{p.product}</span>
      ) },
    { key: 'bl', head: 'Sale blocks used', align: 'l', render: (p) => (
        <span className="flex flex-wrap gap-1">
          {[...p.perf.blocks].slice(0, 8).map((b) => (
            <span key={b} className="rounded bg-gold/15 px-1.5 text-[11px] text-gold" title={b}>
              {codeOf(b)}
            </span>
          ))}
        </span>
      ) },
    { key: 'nb', head: 'Blocks', align: 'r', render: (p) => num(p.perf.blocks.size) },
    { key: 'nc', head: 'Creatives', align: 'r', render: (p) => num(p.perf.ads.size) },
    { key: 'ct', head: 'Creative types', align: 'l', render: (p) => (
        <span className="text-muted">{[...p.perf.creatives].join(', ') || '–'}</span>
      ) },
    { key: 's', head: 'Spend', align: 'r', render: (p) => rs(p.perf.spend) },
    { key: 'r', head: 'ROAS', align: 'r', render: (p) => <Roas v={perfRoas(p.perf)} /> },
  ];

  const topCols: Col<PRow>[] = [
    { key: 'p', head: 'Product', align: 'l', render: (p) => (
        <span className="block max-w-[190px] truncate" title={p.product}>{p.product}</span>
      ) },
    { key: 'bb', head: 'Best sale block', align: 'l', render: (p) => p.bestBlock
        ? <span className="rounded bg-gold/15 px-1.5 py-0.5 text-gold" title={p.bestBlock.key}>{codeOf(p.bestBlock.key)}</span>
        : <span className="text-muted">–</span> },
    { key: 'bs', head: 'Spend', align: 'r', render: (p) => p.bestBlock ? rs(p.bestBlock.spend) : '–' },
    { key: 'br', head: 'ROAS', align: 'r', render: (p) => p.bestBlock ? <Roas v={perfRoas(p.bestBlock)} /> : <span className="text-muted">–</span> },
    { key: 'bc', head: 'Best creative type', align: 'l', render: (p) => p.bestCreative
        ? p.bestCreative.key : <span className="text-muted">–</span> },
    { key: 'cs', head: 'Spend', align: 'r', render: (p) => p.bestCreative ? rs(p.bestCreative.spend) : '–' },
    { key: 'cr', head: 'ROAS', align: 'r', render: (p) => p.bestCreative ? <Roas v={perfRoas(p.bestCreative)} /> : <span className="text-muted">–</span> },
  ];

  const comboCols: Col<Combo>[] = [
    { key: 'p', head: 'Product', align: 'l', render: (c) => (
        <span className="block max-w-[170px] truncate" title={c.product}>{c.product}</span>
      ) },
    { key: 'b', head: 'Block', align: 'l', render: (c) => (
        <span className="rounded bg-gold/15 px-1.5 py-0.5 text-gold" title={c.block}>{codeOf(c.block)}</span>
      ) },
    { key: 'ct', head: 'Creative type', align: 'l', render: (c) => c.creative },
    { key: 'id', head: 'Creative', align: 'l', render: (c) => (
        <span className="block max-w-[220px] truncate text-muted" title={`${c.adName} · ${c.ad}`}>
          {c.adName || c.ad}
        </span>
      ) },
    { key: 's', head: 'Spend', align: 'r', render: (c) => rs(c.spend) },
    { key: 'v', head: 'Revenue', align: 'r', render: (c) => rs(c.rev) },
    { key: 'r', head: 'ROAS', align: 'r', render: (c) => <Roas v={roasOf(c.rev, c.spend)} /> },
  ];

  const elimCols: Col<Elim>[] = [
    { key: 'k', head: 'What to eliminate', align: 'l', render: (e) => e.kind },
    { key: 'n', head: 'Code / type / product', align: 'l', render: (e) => (
        <span className="block max-w-[300px] truncate" title={e.key}>{e.key}</span>
      ) },
    { key: 'a', head: 'Attempts', align: 'r', render: (e) => num(e.attempts) },
    { key: 'w', head: 'Cleared 1.0', align: 'r', render: (e) => `${e.winners} (${pct(share(e.winners, e.attempts))})` },
    { key: 'ci', head: 'Best case', align: 'r', render: (e) => {
        const w = wilson(e.winners, e.attempts);
        return <span className="text-muted">{w.hi.toFixed(0)}%</span>;
      } },
    { key: 's', head: 'Spend', align: 'r', render: (e) => rs(e.spend) },
    { key: 'r', head: 'ROAS', align: 'r', render: (e) => <Roas v={roasOf(e.rev, e.spend)} /> },
  ];

  return (
    <Page
      title="Yesterday's Brief"
      subtitle={`${day}${day === today ? ' · today, still filling' : ''} · ${scope.label} · ad-level, built to the ADS PLANNER structure`}
      actions={controls}
    >
      <Card
        title={`Profit · ${day}`}
        note="the one figure the warehouse cannot work out — type it in"
      >
        <ProfitBoard day={day} sites={profitSites} />
      </Card>

      <Card title={`Yesterday final · ${day}`} note="sales from Shopify, spend from Meta, budgets from the hourly snapshots">
        <Table cols={finalCols} rows={finals} />
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
          Spend here reads the live Meta table, which Meta keeps restating for a day or two after
          it closes. The emailed PNG freezes its figure at 1 AM, so the two can differ by a few
          tenths of a percent — everything else on this row reconciles exactly.
        </p>
      </Card>

      <Card
        title="Decision for tomorrow"
        note={`push at ${PUSH_AT.toFixed(2)} and above · minus below ${MINUS_BELOW.toFixed(2)} · maintain in between`}
      >
        <Grid cols={3}>
          <Stat label="Push" value={num(moveCount('push'))}
                sub={`${rs(moveSpend('push'))} of spend behind them`} />
          <Stat label="Maintain" value={num(moveCount('maintain'))}
                sub={`${rs(moveSpend('maintain'))} holding`} />
          <Stat label="Minus" value={num(moveCount('minus'))}
                sub={`${rs(moveSpend('minus'))} to come down`} />
        </Grid>

        <p className="mb-2 mt-4 text-[11px] uppercase tracking-[0.12em] text-muted">By website</p>
        <Table cols={decisionCols} rows={portalDecisions} />

        <p className="mb-2 mt-5 text-[11px] uppercase tracking-[0.12em] text-muted">
          By product · Rs {MIN_DECIDE}+ of spend
        </p>
        <Table cols={decisionCols} rows={shownDecisions}
               empty={`No product spent Rs ${MIN_DECIDE} on ${day}.`} />
        {hiddenDecisions > 0 && (
          <p className="mt-2 text-[11px] text-muted">
            {num(hiddenDecisions)} smaller products are not listed — {rs(hiddenSpend)} of spend
            between them, every one of them below {rs(shownDecisions[DECIDE_ROWS - 1]?.spend ?? 0)}.
          </p>
        )}

        <Note>
          Website rows use <b className="text-text-strong">Shopify sales over Meta spend</b>, the
          same ratio as the report above. Product rows use{' '}
          <b className="text-text-strong">Meta revenue</b>, because the shop cannot attribute an
          order to the ads for one product and Meta can — so the two do not add up, and each is
          used where it is the honest measure. The protocol sets which way to move, not how far:
          say the step you want and it goes in this table as a rupee figure.
        </Note>
      </Card>

      <Card
        title="Clean-slate budget"
        note="every campaign measured against the target for its age — what survives a rebuild from scratch"
      >
        <Table cols={slateCols} rows={slate} footer={slateAll} />
        <Grid cols={3}>
          <Stat label="Would be kept" value={lakh(slateAll.keepBudget)}
                sub={`${num(slateAll.keepCamps)} campaigns at or above target · ${pct(share(slateAll.keepBudget, slateAll.budget))} of the book`} />
          <Stat label="Would be cut" value={lakh(slateAll.cutBudget)}
                sub={`${num(slateAll.cutCamps)} campaigns under target`} />
          <Stat label="Never spent" value={lakh(slateAll.idleBudget)}
                sub={`${num(slateAll.idleCamps)} campaigns took nothing — they proved nothing either way`} />
        </Grid>
        <Note>
          Targets are the ones the desk set:{' '}
          {AGE_TARGETS.map((b) => `${b.label} ${b.target.toFixed(2)}`).join(' · ')}. A campaign
          counts as kept when its return on {day} reached the target for its age, and the bands do
          not overlap — Day 1 is judged at 1.15, not at the 1.40 its second day will ask for.
          This is a rebuild on paper: it ignores what was actually closed, which the closing
          module reports separately.
        </Note>
      </Card>

      <Card
        title="Learning budget · day 1"
        note="what was committed to launches, and how much of it was still running at midnight"
      >
        <Table cols={learnCols} rows={learning} footer={learningAll}
               empty={`Nothing launched on ${day}.`} />
        <Note>
          Day 1 is the learning cohort: Meta has not settled delivery, the target is the lowest of
          any band at 1.15, and it is also the band the closing protocol polices hardest. Allocated
          against still-active is therefore the honest read on whether a launch was given its
          chance or withdrawn — {learningAll.allocated > 0
            ? `${pct(share(learningAll.closed, learningAll.allocated))} of yesterday's launch budget was switched off before midnight`
            : 'nothing was launched to judge'}.
        </Note>
      </Card>

      <Card
        title="Scale — the best of the day"
        note="top three on each cut · Rs 1,000+ of spend so a single order cannot top the list"
      >
        <Table cols={cutCols} rows={scaleRows} empty="Nothing cleared the spend floor." />
        <Note>
          <b className="text-text-strong">Profitability ranks rupees kept, not the ratio</b> — a
          2.5 on a small budget is a good sign; the row that pays the bills is usually a 1.6 on a
          large one, and both belong in the list for different reasons. The{' '}
          <b className="text-text-strong">Deal</b> cut only sees ads whose name carries an offer
          tag: {rs(untaggedSpend)} of {day}&rsquo;s spend
          ({pct(share(untaggedSpend, totalSpend))}) is on ads with none, so treat it as a read on
          the tagged campaigns rather than on the whole book.
        </Note>
      </Card>

      <Card
        title="Elimination — the worst of the day"
        note="same four cuts, bottom three · the 30-day elimination segment is further down"
      >
        <Table cols={cutCols} rows={cutRows} empty="Nothing cleared the spend floor." />
      </Card>

      <Card
        title={`ROAS buckets · ${day}`}
        note="where the day's money ended up, banded by what each campaign returned"
      >
        <Table cols={bucketCols} rows={buckets} footer={bucketTotal}
               empty={`Nothing spent on ${day}.`} />
        <Note>
          Every campaign that took money on {day}, placed in the band it finished the day in.
          The bands are the ones used everywhere else in this dashboard, so a row here and a row
          in the closing module mean the same thing. <b className="text-text-strong">Closed</b> is
          how many of that band were switched off before midnight — a band with a high count is
          one the protocol is already policing; a losing band with a low count is one nobody
          touched.
        </Note>
      </Card>

      <Card
        title="Day by day · last 14 days"
        note="the book, what it spent, what it returned and how much was switched off"
      >
        <Table cols={dayCols} rows={[...byDay].reverse()}
               empty="The closing rollup has nothing for this window." />
        <div className="mt-3">
          <a href="/command" className="text-[11px] text-muted underline decoration-edge decoration-dotted underline-offset-4 transition hover:text-gold">
            open a day into its ROAS bands and campaigns &rarr;
          </a>
        </div>
      </Card>

      <Card title={`Vs ${prevDay}`} note="day over day">
        <Table cols={vsCols} rows={finals} />
      </Card>

      <Card title={`What changed on ${day}`} note="new is defined by first spend, not by when something was created">
        <Grid cols={4}>
          <Stat
            label="New campaigns"
            value={num(changes.newCampaigns.length)}
            sub={changes.newCampaigns.length
              ? `${rs(newCampBudget)} of budget · spent ${rs(newCampSpend)} at ${newCampSpend > 0 ? (newCampRev / newCampSpend).toFixed(2) : '0.00'}`
              : 'nothing launched'}
          />
          <Stat
            label="New creatives"
            value={num(changes.newCreatives.length)}
            sub={`${num(freshCreatives.length)} in new campaigns · ${num(refreshCreatives.length)} added to existing`}
          />
          <Stat
            label="Budget moved"
            value={raised || cutAmt ? `${raised ? '+' : ''}${rs(raised - cutAmt)}` : 'none'}
            sub={raised || cutAmt
              ? `${num(raises.length)} raised, ${num(cuts.length)} cut`
              : 'no existing campaign had its budget edited'}
          />
          <Stat
            label="Reactivated"
            value={num(changes.reactivations.length)}
            sub={changes.reactivations.length ? `${rs(reactBudget)} of budget back on` : 'none came back'}
          />
        </Grid>

        {changes.newProducts.length > 0 && (
          <div className="mt-4">
            <Note kind="warn">
              <b className="text-warn">New product{changes.newProducts.length > 1 ? 's' : ''} on ads today:</b>{' '}
              {changes.newProducts.map((p) => (
                `${p.product} (${p.camps} camp${p.camps > 1 ? 's' : ''}, ${rs(p.spend)} at ${p.spend > 0 ? (p.revenue / p.spend).toFixed(2) : '0.00'} ROAS)`
              )).join(' · ')}
            </Note>
          </div>
        )}

        {(changes.newCampaigns.length > 0 || changes.newCreatives.length > 0) && (
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div>
              <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-muted">
                Sale blocks that got the new campaigns
              </div>
              {newBlocks.length ? (
                <BarList
                  fmt={num}
                  rows={newBlocks.slice(0, 8).map((x, i) => ({
                    label: x.key, value: x.count,
                    sub: pct((x.count / changes.newCampaigns.length) * 100),
                    color: SERIES[i % SERIES.length],
                  }))}
                />
              ) : <p className="text-[12px] text-muted">No new campaigns.</p>}
            </div>
            <div>
              <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-muted">
                Creative type of the new creatives
              </div>
              {newTypes.length ? (
                <BarList
                  fmt={num}
                  rows={newTypes.slice(0, 8).map((x, i) => ({
                    label: x.key, value: x.count,
                    sub: pct((x.count / changes.newCreatives.length) * 100),
                    color: SERIES[i % SERIES.length],
                  }))}
                />
              ) : <p className="text-[12px] text-muted">No new creatives.</p>}
            </div>
            <div>
              <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-muted">
                Sentiment of the new creatives
              </div>
              {newSentiments.length ? (
                <BarList
                  fmt={num}
                  rows={newSentiments.slice(0, 8).map((x) => ({
                    label: x.key, value: x.count,
                    sub: pct((x.count / changes.newCreatives.length) * 100),
                    color: x.key === 'unmarked' ? '#5a6472' : '#1baf7a',
                  }))}
                />
              ) : <p className="text-[12px] text-muted">No new creatives.</p>}
            </div>
          </div>
        )}

        {changes.reactivations.length > 0 && (
          <p className="mt-4 text-[11.5px] leading-relaxed text-muted">
            <b className="text-text-strong">Reactivated:</b>{' '}
            {changes.reactivations.slice(0, 5).map((r) =>
              `${r.product} — ${r.campaignName.slice(0, 34)} (${r.gapDays}d gap, ${rs(r.budget)})`
            ).join(' · ')}
          </p>
        )}

        <p className="mt-4 text-[11.5px] leading-relaxed text-muted">
          &ldquo;New&rdquo; means <b className="text-text-strong">first spend</b>, not creation
          time — a campaign built last week and switched on today started costing money today, and
          creation time would both count things only drafted and miss things revived. A creative
          landing in a campaign that already existed is a refresh, not a launch, and is counted
          separately.
        </p>
      </Card>

      <Grid cols={4}>
        <Stat label="Spend" value={lakh(totalSpend)} sub={`${num(new Set(spent.map((r) => r.adId)).size)} creatives live`} />
        <Stat label="Revenue" value={lakh(totalRev)} sub={`ROAS ${roasOf(totalRev, totalSpend).toFixed(2)}`} />
        <Stat label="Sale blocks used" value={num(blocksRanked.length)} sub={`across ${num(products.length)} products`} />
        <Stat label="Elimination candidates" value={num(elims.length)} sub={`${MIN_ATTEMPTS}+ attempts, best case under 30%`} />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${day}, ${num(spent.length)} ad-days`} />

      <Card title="1 · Sale block code name chart" note="codes are assigned by spend rank for this report; full settings shown beside">
        <Table cols={blockCols} rows={blocksRanked.slice(0, 20)} />
      </Card>

      <Card title="2 · Sale blocks used by product" note="each creative counted once per product">
        <Table cols={prodCols} rows={prows} />
      </Card>

      <Card title="3 & 4 · Top sale block and creative type by product" note="best by ROAS among those with at least Rs 300 of spend">
        <Table cols={topCols} rows={prows} />
      </Card>

      <Card title="6 · Best-performing combination by product" note="block × creative type × creative, ranked by ROAS">
        <Table cols={comboCols} rows={combos} empty="No combination reached the spend floor on this day." />
      </Card>

      <Card title="7 · Elimination segment" note={`30-day window · ${MIN_ATTEMPTS}+ completed attempts · best-case hit rate under 30%`}>
        <Table
          cols={elimCols}
          rows={elims}
          empty={`Nothing has failed ${MIN_ATTEMPTS}+ times with a best case under 30%. That is the intended result.`}
        />
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
          A candidate qualifies only when the <b className="text-text-strong">upper</b> bound of its
          95% interval is still under 30% — that is what separates a genuinely failing setting from
          one that has had an unlucky fortnight.
        </p>
      </Card>

      <Card title="8 · Daily summary">
        <Grid cols={4}>
          <Stat label="Products reported" value={num(products.length)} />
          <Stat label="Sale blocks used" value={num(blocksRanked.length)} />
          <Stat label="Creative types live" value={num(new Set(spent.flatMap(creativeTagsOf)).size)} />
          <Stat label="Creatives live" value={num(new Set(spent.map((r) => r.adId)).size)} />
        </Grid>
      </Card>

      <Note kind="warn">
        <b className="text-warn">Two parts of the template are not filled, deliberately.</b>{' '}
        <b className="text-warn">Cost per order</b> cannot be computed: no Meta table in this
        warehouse ingests a purchase count — campaign and ad dailies carry spend, revenue,
        impressions and clicks and nothing else — so orders would have to be estimated from revenue
        ÷ AOV, which looks precise and is a guess. Adding the purchase action to the insights pull
        would fix it. <b className="text-warn">Section 5&apos;s planning columns</b> — new planned
        concepts, next action, owner, launch date — are decisions your team makes, not facts in the
        data, so the brief reports what is currently running and leaves the planning to you.
      </Note>
    </Page>
  );
}
