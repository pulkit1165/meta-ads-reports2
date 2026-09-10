import {
  adDays, adDatesAvailable, accumulate, emptyPerf, perfRoas, blockCodes,
  type AdRow, type Perf,
} from '@/lib/brief';
import { roasOf, share, PORTAL_NAME } from '@/lib/ads';
import { resolveScope, istToday, type SearchParams } from '@/lib/range';
import { rank, wilson, enough, money, pctOf, type Finding } from '@/lib/insights';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Attempts before an elimination decision is defensible, per the template. */
const MIN_ATTEMPTS = 15;

export default async function BriefPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const scope = resolveScope(sp);

  // The brief is about one day. Default to the newest day the ad-level table
  // actually holds rather than assuming yesterday exists — the ad ingest runs
  // on its own schedule and can lag the campaign one.
  const available = await adDatesAvailable(120);
  const asked = Array.isArray(sp?.day) ? sp.day[0] : sp?.day;
  const day = asked && available.includes(asked) ? asked : available[0];

  const controls = <PageControls scope={scope} dates={false} />;

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
  const [today, history] = await Promise.all([
    adDays(day, day, scope.codes),
    adDays(fromISO, day, scope.codes),
  ]);

  if (!today.length) {
    return (
      <Page title="Yesterday's Brief" subtitle={`${day} · ${scope.label}`} actions={controls}>
        <Note kind="warn">No ad rows for {day} on {scope.label}.</Note>
      </Page>
    );
  }

  const spent = today.filter((r) => r.spend > 0);
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
      subtitle={`${day} · ${scope.label} · ad-level, built to the ADS PLANNER structure`}
      actions={controls}
    >
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
