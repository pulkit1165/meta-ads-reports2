import { campDays, productMap, roasOf, share, PORTAL_NAME, PORTALS } from '@/lib/ads';
import { resolveRange, resolveScope, type SearchParams } from '@/lib/range';
import { rank, money, pctOf, type Finding } from '@/lib/insights';
import { BarList, ShareBar, SERIES } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The intended split between the proven core and everything being tested. */
const CORE_TARGET = 70;

type Cell = { product: string; portal: string; spend: number; rev: number; camps: number };
type Prod = { key: string; spend: number; rev: number; camps: number; portals: number };

export default async function AllocationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 60);
  const scope = resolveScope(sp);
  const controls = <PageControls range={range} scope={scope} />;
  const [all, pmap] = await Promise.all([campDays(range.from, range.to, scope.codes), productMap()]);
  const spent = all.filter((r) => r.spend > 0);

  if (!spent.length) {
    return (
      <Page title="Allocation" subtitle={range.label} actions={controls}>
        <Note kind="warn">No campaign-days with spend between {range.from} and {range.to}.</Note>
      </Page>
    );
  }

  const grid = new Map<string, Cell>();
  const prods = new Map<string, Prod>();
  const campsOf = new Map<string, Set<string>>();

  for (const r of spent) {
    const product = pmap.get(r.campaignId) ?? 'unmapped';
    const gk = `${product}||${r.portal}`;
    const g = grid.get(gk) ?? { product, portal: r.portal, spend: 0, rev: 0, camps: 0 };
    g.spend += r.spend; g.rev += r.revenue;
    grid.set(gk, g);

    const p = prods.get(product) ?? { key: product, spend: 0, rev: 0, camps: 0, portals: 0 };
    p.spend += r.spend; p.rev += r.revenue;
    prods.set(product, p);

    const s = campsOf.get(product) ?? new Set<string>();
    s.add(r.campaignId);
    campsOf.set(product, s);
  }
  for (const [k, p] of prods) {
    p.camps = campsOf.get(k)?.size ?? 0;
    p.portals = new Set([...grid.values()].filter((g) => g.product === k).map((g) => g.portal)).size;
  }

  const products = [...prods.values()].sort((a, b) => b.spend - a.spend);
  const totalSpend = spent.reduce((s, r) => s + r.spend, 0);
  const totalRev = spent.reduce((s, r) => s + r.revenue, 0);

  // The 70/30 read: how much sits on the products that actually return, versus
  // everything else. "Core" is defined by performance, not by a hand-kept list,
  // so it moves when the products move.
  const core = products.filter((p) => p.key !== 'unmapped' && roasOf(p.rev, p.spend) >= 1);
  const coreSpend = core.reduce((s, p) => s + p.spend, 0);
  const corePct = pctOf(coreSpend, totalSpend);
  const testSpend = totalSpend - coreSpend;

  const portalsPresent = [...new Set(spent.map((r) => r.portal))];

  /* ── findings ───────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];

  findings.push({
    severity: corePct >= CORE_TARGET - 8 ? 'good' : corePct >= 50 ? 'watch' : 'critical',
    headline: `${corePct.toFixed(0)}% of spend sits on products that clear 1.0`,
    detail: `${money(coreSpend)} across ${core.length} products returns at or above break-even; the remaining ${money(testSpend)} does not. Against a ${CORE_TARGET}/${100 - CORE_TARGET} intent, this is ${corePct >= CORE_TARGET ? 'on target' : `${(CORE_TARGET - corePct).toFixed(0)} points short`}.`,
    action: corePct < CORE_TARGET - 8
      ? 'Too much of the book is on products that are not returning. That is a shift in allocation, not a campaign-level fix.'
      : undefined,
  });

  const spread = products.filter((p) => p.key !== 'unmapped' && p.portals > 1);
  if (spread.length) {
    const s = spread[0];
    const cells = [...grid.values()].filter((g) => g.product === s.key);
    const bestCell = [...cells].sort((a, b) => roasOf(b.rev, b.spend) - roasOf(a.rev, a.spend))[0];
    const worstCell = [...cells].sort((a, b) => roasOf(a.rev, a.spend) - roasOf(b.rev, b.spend))[0];
    if (bestCell && worstCell && bestCell.portal !== worstCell.portal) {
      findings.push({
        severity: 'neutral',
        headline: `${s.key} performs differently by website`,
        detail: `${roasOf(bestCell.rev, bestCell.spend).toFixed(2)} on ${PORTAL_NAME[bestCell.portal] ?? bestCell.portal} (${money(bestCell.spend)}) against ${roasOf(worstCell.rev, worstCell.spend).toFixed(2)} on ${PORTAL_NAME[worstCell.portal] ?? worstCell.portal} (${money(worstCell.spend)}).`,
        action: 'Same product, same creative pool — the gap is the storefront, not the ad.',
      });
    }
  }

  const top3 = products.filter((p) => p.key !== 'unmapped').slice(0, 3);
  const top3Pct = pctOf(top3.reduce((s, p) => s + p.spend, 0), totalSpend);
  if (top3Pct >= 60) {
    findings.push({
      severity: 'watch',
      headline: `Three products carry ${top3Pct.toFixed(0)}% of the spend`,
      detail: top3.map((p) => `${p.key} ${pctOf(p.spend, totalSpend).toFixed(0)}%`).join(', ') + '. A stock or listing problem on any one of them is immediately a revenue problem.',
    });
  }

  const unmapped = prods.get('unmapped');
  if (unmapped && unmapped.spend > totalSpend * 0.15) {
    findings.push({
      severity: 'watch',
      headline: `${pctOf(unmapped.spend, totalSpend).toFixed(0)}% of spend has no product mapped`,
      detail: `${money(unmapped.spend)} cannot be attributed, so every allocation figure here is a floor rather than a total.`,
      action: 'The classifier pipeline fills meta_camp_product_map. Until it catches up, treat these splits as indicative.',
    });
  }

  const cols: Col<Prod>[] = [
    { key: 'k', head: 'Product', align: 'l', render: (p) => (
        <span className={`block max-w-[260px] truncate ${p.key === 'unmapped' ? 'text-muted' : ''}`} title={p.key}>
          {p.key}
        </span>
      ) },
    { key: 'c', head: 'Campaigns', align: 'r', render: (p) => num(p.camps) },
    { key: 'w', head: 'Websites', align: 'r', render: (p) => num(p.portals) },
    { key: 's', head: 'Spend', align: 'r', render: (p) => rs(p.spend) },
    { key: 'sh', head: '% of spend', align: 'r', render: (p) => pct(share(p.spend, totalSpend), 1) },
    { key: 'r', head: 'ROAS', align: 'r', render: (p) => <Roas v={roasOf(p.rev, p.spend)} /> },
    ...portalsPresent.map((portal) => ({
      key: `p_${portal}`,
      head: PORTAL_NAME[portal] ?? portal,
      align: 'r' as const,
      render: (p: Prod) => {
        const g = grid.get(`${p.key}||${portal}`);
        return g && g.spend > 0
          ? <span title={`${rs(g.spend)} at ${roasOf(g.rev, g.spend).toFixed(2)}`}>{pct(share(g.spend, p.spend))}</span>
          : <span className="text-muted">–</span>;
      },
    })),
  ];

  return (
    <Page
      title="Allocation"
      subtitle={`${range.label} · product × website · ${scope.label}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Products carrying spend" value={num(products.filter((p) => p.key !== 'unmapped').length)} sub={lakh(totalSpend)} />
        <Stat
          label="On products that return"
          value={pct(corePct)}
          sub={`${lakh(coreSpend)} · target ${CORE_TARGET}%`}
          delta={corePct - CORE_TARGET}
          unit="pp"
        />
        <Stat label="On everything else" value={pct(100 - corePct)} sub={lakh(testSpend)} />
        <Stat label="Blended ROAS" value={roasOf(totalRev, totalSpend).toFixed(3)} sub={`${lakh(totalRev)} revenue`} />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${range.label}, ${num(products.length)} products`} />

      <Card title={`The ${CORE_TARGET}/${100 - CORE_TARGET} split`} note="core = products returning at or above 1.0 over this window">
        <ShareBar
          fmt={rs}
          parts={[
            { label: `Returning products · ${core.length}`, value: coreSpend, color: '#1baf7a' },
            { label: 'Everything else', value: testSpend, color: '#eb6834' },
          ]}
        />
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
          Core is defined by what actually returns in this window rather than a hand-kept list, so
          it moves as the products move. Change the date range and the split changes with it.
        </p>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="Spend by product" note={`top ${Math.min(12, products.length)}`}>
          <BarList
            fmt={rs}
            rows={products.slice(0, 12).map((p, i) => ({
              label: p.key,
              value: p.spend,
              sub: pct(share(p.spend, totalSpend), 1),
              color: p.key === 'unmapped' ? '#5a6472' : SERIES[i % SERIES.length],
            }))}
          />
        </Card>
        <Card title="Spend by website" note="across all products">
          <BarList
            fmt={rs}
            rows={portalsPresent.map((portal, i) => {
              const s = spent.filter((r) => r.portal === portal);
              const sp2 = s.reduce((a, r) => a + r.spend, 0);
              const rv = s.reduce((a, r) => a + r.revenue, 0);
              return {
                label: PORTAL_NAME[portal] ?? portal,
                value: sp2,
                sub: roasOf(rv, sp2).toFixed(2),
                color: SERIES[i % SERIES.length],
              };
            }).sort((a, b) => b.value - a.value)}
          />
        </Card>
      </div>

      <Card title="Product × website" note="each website column is that product's share of spend on that site">
        <Table cols={cols} rows={products} />
      </Card>

      <Note>
        The website columns show how each product&apos;s own budget divides across the three
        storefronts, so each row reads across to 100%. Products come from{' '}
        <span className="text-text">meta_camp_product_map</span>; unmapped campaigns are kept
        visible rather than dropped so the totals reconcile with the other ads modules.
      </Note>
    </Page>
  );
}
