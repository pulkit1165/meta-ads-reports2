import {
  continuousBook, ROAS_BANDS, bandOf, sum, wtdRoas, MIN_AGE, type ContinuousRow,
} from '@/lib/continuous';
import { PORTAL_NAME } from '@/lib/ads';
import { resolveScope, type SearchParams } from '@/lib/range';
import { rank, money, pctOf, type Finding } from '@/lib/insights';
import { BarList } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BAND_COLOR: Record<string, string> = {
  b18: '#1baf7a', b14: '#5aa9a3', b115: '#eda100', b10: '#eb6834', b0: '#b3402f',
};

export default async function ContinuousPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const scope = resolveScope(sp);
  const rawMax = Array.isArray(sp?.maxRoas) ? sp.maxRoas[0] : sp?.maxRoas;
  const maxRoas = rawMax && Number.isFinite(Number(rawMax)) && Number(rawMax) > 0
    ? Number(rawMax) : null;

  const controls = (
    <PageControls scope={scope} dates={false} maxRoas={rawMax ?? ''} />
  );

  const all = await continuousBook(scope.codes);
  if (!all.length) {
    return (
      <Page title="7 Days+ Continuous" subtitle={scope.label} actions={controls}>
        <Note kind="warn">
          No campaign is at least {MIN_AGE} days old, still active, and spending every day.
        </Note>
      </Page>
    );
  }

  // The filter narrows the LIST, never the summary — the point is to see the
  // weak end against the book it sits in, not to redefine the book.
  const shown = maxRoas != null ? all.filter((r) => r.roas7 < maxRoas) : all;
  const book = sum(all);
  const portals = [...new Set(all.map((r) => r.portal))].sort();

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const weak = all.filter((r) => r.roas7 < 1.4);
  const weakAgg = sum(weak);
  if (weak.length) {
    findings.push({
      severity: weakAgg.budget > book.budget * 0.25 ? 'watch' : 'neutral',
      headline: `${weak.length} of ${all.length} continuous campaigns sit under 1.4×`,
      detail: `They hold ${money(weakAgg.budget)} of daily budget — ${pct(pctOf(weakAgg.budget, book.budget))} of the continuous book — and returned ${wtdRoas(weakAgg).toFixed(2)} over 7 days against the book's ${wtdRoas(book).toFixed(2)}.`,
      action: 'These are mature, stable campaigns: the learning excuse is gone, so this is what they are worth.',
    });
  }
  const losing = all.filter((r) => r.roas7 < 1.0);
  if (losing.length) {
    const la = sum(losing);
    findings.push({
      severity: 'critical',
      headline: `${losing.length} continuous campaigns are below break-even`,
      detail: `${money(la.spend7)} of 7-day spend returned ${money(la.revenue7)} at ${wtdRoas(la).toFixed(2)}, on ${money(la.budget)} of live daily budget.`,
      action: 'A campaign that has run every day for over a week and still cannot clear 1.0 is not going to.',
    });
  } else {
    findings.push({
      severity: 'good',
      headline: 'Nothing in the continuous book is below break-even',
      detail: `All ${all.length} campaigns clearing ${MIN_AGE}+ days and spending daily returned at or above 1.0 over the last 7 days.`,
    });
  }
  const best = all[0];
  if (best) {
    findings.push({
      severity: 'neutral',
      headline: `Best continuous performer is at ${best.roas7.toFixed(2)}×`,
      detail: `${best.campaignName.slice(0, 56)} — ${money(best.spend7)} over 7 days on ${money(best.budget)} of daily budget, running ${best.age} days.`,
    });
  }

  /* ── tables ───────────────────────────────────────────────────────────── */
  type PRow = { portal: string };
  const portalCols: Col<PRow>[] = [
    { key: 'p', head: 'Portal', align: 'l', render: (r) =>
        r.portal === 'TOTAL' ? <span className="font-medium">TOTAL</span> : (PORTAL_NAME[r.portal] ?? r.portal) },
    { key: 'c', head: '# Camps', align: 'r', render: (r) => num(agg(r.portal).camps) },
    { key: 'b', head: 'Budget', align: 'r', render: (r) => rs(agg(r.portal).budget) },
    { key: 's', head: '7d Spend', align: 'r', render: (r) => rs(agg(r.portal).spend7) },
    { key: 'v', head: '7d Rev', align: 'r', render: (r) => rs(agg(r.portal).revenue7) },
    { key: 'r', head: '7d ROAS', align: 'r', render: (r) => <Roas v={wtdRoas(agg(r.portal))} /> },
  ];
  function agg(p: string) {
    return p === 'TOTAL' ? book : sum(all.filter((r) => r.portal === p));
  }
  const prows: PRow[] = [...portals.map((p) => ({ portal: p })), { portal: 'TOTAL' }];

  type BRow = { key: string; label: string };
  const bandCols: Col<BRow>[] = [
    { key: 'b', head: 'Band', align: 'l', render: (b) => (
        <span className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-sm" style={{ background: BAND_COLOR[b.key] }} />
          {b.label}
        </span>
      ) },
    { key: 'c', head: '# Camps', align: 'r', render: (b) => num(bandAgg(b.key).camps) },
    { key: 'bu', head: 'Budget', align: 'r', render: (b) => rs(bandAgg(b.key).budget) },
    { key: 's', head: '7d Spend', align: 'r', render: (b) => rs(bandAgg(b.key).spend7) },
    { key: 'w', head: 'Wtd ROAS', align: 'r', render: (b) => {
        const a = bandAgg(b.key);
        return a.spend7 > 0 ? <Roas v={wtdRoas(a)} /> : <span className="text-muted">—</span>;
      } },
  ];
  function bandAgg(key: string) {
    return sum(all.filter((r) => bandOf(r.roas7).key === key));
  }
  const brows: BRow[] = ROAS_BANDS.map((b) => ({ key: b.key, label: b.label }));

  const campCols: Col<ContinuousRow>[] = [
    { key: 'n', head: '#', align: 'l', render: (c) => (
        <span className="text-muted">{shown.indexOf(c) + 1}</span>
      ) },
    { key: 'a', head: 'Age', align: 'r', render: (c) => `${num(c.age)}d` },
    { key: 'b', head: 'Bud', align: 'r', render: (c) => rs(c.budget) },
    { key: 's', head: '7d Spend', align: 'r', render: (c) => rs(c.spend7) },
    { key: 'v', head: '7d Rev', align: 'r', render: (c) => rs(c.revenue7) },
    { key: 'r', head: '7d ROAS', align: 'r', render: (c) => <Roas v={c.roas7} /> },
    { key: 't', head: 'Today', align: 'r', render: (c) =>
        c.spendToday > 0
          ? <Roas v={c.revenueToday / c.spendToday} />
          : <span className="text-muted">–</span> },
    { key: 'id', head: 'Camp ID', align: 'l', render: (c) => (
        <span className="text-[11px] text-muted">{c.campaignId}</span>
      ) },
    { key: 'c', head: 'Campaign', align: 'l', render: (c) => (
        <span className="block max-w-[320px] truncate" title={c.campaignName}>{c.campaignName}</span>
      ) },
  ];

  return (
    <Page
      title="7 Days+ Continuous"
      subtitle={`${scope.label} · age ≥ ${MIN_AGE} days, still active, spending every day${maxRoas != null ? ` · showing only under ${maxRoas.toFixed(2)}×` : ''}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Continuous campaigns" value={num(book.camps)} sub={`${rs(book.budget)} of daily budget`} />
        <Stat label="7d spend" value={lakh(book.spend7)} sub={`${lakh(book.revenue7)} returned`} />
        <Stat label="7d ROAS" value={wtdRoas(book).toFixed(2)} sub="revenue ÷ spend, not a mean of ratios" />
        <Stat
          label={maxRoas != null ? `Under ${maxRoas.toFixed(2)}×` : 'Under 1.4×'}
          value={num(maxRoas != null ? shown.length : weak.length)}
          sub={maxRoas != null
            ? `${rs(sum(shown).budget)} of budget in the filtered set`
            : `${rs(weakAgg.budget)} of budget below 1.4`}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${num(book.camps)} continuous campaigns · ${scope.label}`} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="Portal summary" note="the whole continuous book, unaffected by the ROAS filter">
          <Table cols={portalCols} rows={prows} />
        </Card>
        <Card title="ROAS band breakdown" note="weighted ROAS per band">
          <Table cols={bandCols} rows={brows} />
          <div className="mt-4">
            <BarList
              fmt={rs}
              rows={ROAS_BANDS.map((b) => ({
                label: b.label,
                value: bandAgg(b.key).budget,
                sub: `${bandAgg(b.key).camps} camps`,
                color: BAND_COLOR[b.key],
              })).filter((x) => x.value > 0)}
            />
          </div>
        </Card>
      </div>

      {portals.map((p) => {
        const rows = shown.filter((r) => r.portal === p);
        return (
          <Card
            key={p}
            title={`${PORTAL_NAME[p] ?? p} · ${rows.length} camps`}
            note={maxRoas != null
              ? `under ${maxRoas.toFixed(2)}× · ${sum(all.filter((r) => r.portal === p)).camps} in the full book`
              : 'ranked by 7-day ROAS'}
          >
            <Table
              cols={campCols}
              rows={rows}
              empty={maxRoas != null
                ? `Nothing on this portal is under ${maxRoas.toFixed(2)}× — which is the good outcome.`
                : 'No continuous campaigns.'}
            />
          </Card>
        );
      })}

      <Note>
        <b className="text-text-strong">Continuous</b> means three things at once: at least{' '}
        {MIN_AGE} days since the campaign first spent, still ACTIVE now, and spend on every one of
        the last seven days. Age alone returns several hundred campaigns, most of them long dead;
        the point of this view is the stable book, and a campaign that skipped days has a 7-day
        ROAS averaged over a different number of days than its neighbours.
        {' '}The <b className="text-text-strong">ROAS filter narrows the campaign lists only</b> —
        the portal summary and band breakdown always describe the whole book, because the weak end
        is only meaningful against the thing it sits inside. Weighted ROAS is total revenue over
        total spend, never an average of per-campaign ratios.
      </Note>
    </Page>
  );
}
