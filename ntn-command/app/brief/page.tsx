import {
  adDays, adDatesAvailable, accumulate, emptyPerf, perfRoas, blockCodes,
  type AdRow, type Perf,
} from '@/lib/brief';
import { ydayFinal, totalRow, chg, type YdayRow } from '@/lib/yday';
import { roasOf, share, PORTAL_NAME } from '@/lib/ads';
import { resolveScope, istToday, type SearchParams } from '@/lib/range';
import { rank, wilson, enough, money, pctOf, type Finding } from '@/lib/insights';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, Delta, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
  const [dayRows, history, finalRows, prevRows] = await Promise.all([
    adDays(day, day, scope.codes),
    adDays(fromISO, day, scope.codes),
    ydayFinal(day, scope.codes),
    ydayFinal(prevDay, scope.codes),
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
      <Card title={`Yesterday final · ${day}`} note="sales from Shopify, spend from Meta, budgets from the hourly snapshots">
        <Table cols={finalCols} rows={finals} />
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
          Spend here reads the live Meta table, which Meta keeps restating for a day or two after
          it closes. The emailed PNG freezes its figure at 1 AM, so the two can differ by a few
          tenths of a percent — everything else on this row reconciles exactly.
        </p>
      </Card>

      <Card title={`Vs ${prevDay}`} note="day over day">
        <Table cols={vsCols} rows={finals} />
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
