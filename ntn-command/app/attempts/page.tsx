import Link from 'next/link';
import {
  attempts, rollup, GRAINS, diedBad, diedGood, closeRate, wasteRate,
  type AttemptRow, type Grain,
} from '@/lib/attempts';
import { BAND_KEYS, type BandKey } from '@/lib/ads';
import { resolveRange, resolveScope, type SearchParams } from '@/lib/range';
import { rank, money, pctOf, type Finding } from '@/lib/insights';
import { ROAS_BANDS, ShareBar } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, rs, pct, num, lakh, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BAND = Object.fromEntries(ROAS_BANDS.map((b) => [b.key, b])) as
  Record<BandKey, { key: string; label: string; color: string }>;

const SORTS = [
  { key: 'roas', label: 'Worst return first' },
  { key: 'waste', label: 'Most wasted first' },
  { key: 'attempts', label: 'Most tried first' },
  { key: 'spend', label: 'Most spend first' },
] as const;
type SortKey = (typeof SORTS)[number]['key'];

/**
 * The ROAS every closed attempt died at, as one bar.
 *
 * Survivors are the last segment rather than being left out, so the bar spans
 * every attempt and its width means the same thing on every row: this is what
 * happened to everything we tried.
 */
function Deaths({ r }: { r: AttemptRow }) {
  const parts: { key: string; n: number; color: string }[] = BAND_KEYS
    .map((k) => ({ key: k as string, n: r.bands[k], color: BAND[k].color }))
    .filter((p) => p.n > 0);
  if (r.survived > 0) {
    parts.push({ key: 'live', n: r.survived, color: 'var(--edge)' });
  }
  const total = r.attempts || 1;
  return (
    <span className="flex h-[13px] w-[190px] overflow-hidden rounded-sm bg-tint" title={
      BAND_KEYS.filter((k) => r.bands[k] > 0)
        .map((k) => `${r.bands[k]} closed at ${BAND[k].label}`)
        .concat(r.survived ? [`${r.survived} survived`] : [])
        .join('  ·  ')
    }>
      {parts.map((p) => (
        <span
          key={p.key}
          style={{ width: `${(p.n / total) * 100}%`, background: p.color }}
          className="h-full"
        />
      ))}
    </span>
  );
}

export default async function AttemptsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 15);
  const scope = resolveScope(sp);

  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const grain = (GRAINS.find((g) => g.key === one(sp.grain))?.key ?? 'pbc') as Grain;
  const sort = (SORTS.find((s) => s.key === one(sp.sort))?.key ?? 'roas') as SortKey;
  const minRaw = Number(one(sp.min));
  const min = Number.isFinite(minRaw) && minRaw >= 1 && minRaw <= 200 ? Math.floor(minRaw) : 5;

  const fine = await attempts(range.from, range.to, scope.codes);
  const rows = rollup(fine, grain);

  const controls = <PageControls range={range} scope={scope} />;

  if (!fine.length) {
    return (
      <Page title="Attempts" subtitle={range.label} actions={controls}>
        <Note kind="warn">
          No campaign-days in this window. Attempts are read from the{' '}
          <span className="text-warn">camp_day_state</span> rollup joined to the daily campaign
          table, so an empty result means one of those has not been built for these dates.
        </Note>
      </Page>
    );
  }

  /* ── totals ───────────────────────────────────────────────────────────── */
  const T: AttemptRow = rollup(fine, 'p').reduce((a, r) => {
    a.attempts += r.attempts; a.closed += r.closed; a.survived += r.survived;
    a.spend += r.spend; a.revenue += r.revenue; a.budgetClosed += r.budgetClosed;
    a.camps += r.camps;
    for (const b of BAND_KEYS) a.bands[b] += r.bands[b];
    return a;
  }, {
    product: 'TOTAL', saleBlock: '', creativeType: '', portals: [], camps: 0,
    attempts: 0, closed: 0, survived: 0,
    bands: Object.fromEntries(BAND_KEYS.map((k) => [k, 0])) as Record<BandKey, number>,
    budgetClosed: 0, spend: 0, revenue: 0, roas: 0,
  });
  T.roas = T.spend > 0 ? T.revenue / T.spend : 0;

  const eligible = rows.filter((r) => r.attempts >= min);
  const sorted = [...eligible].sort((a, b) =>
    sort === 'attempts' ? b.attempts - a.attempts
      : sort === 'waste' ? wasteRate(b) - wasteRate(a)
        : sort === 'spend' ? b.spend - a.spend
          : a.roas - b.roas);

  const mostTried = [...rows].sort((a, b) => b.attempts - a.attempts).slice(0, 10);

  /* ── findings ─────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const deadZero = T.bands.zero;

  findings.push({
    severity: 'neutral',
    headline: `${num(T.attempts)} attempts over ${range.span} days, ${pct(pctOf(T.closed, T.attempts))} of them closed`,
    detail: `An attempt is one campaign-day that went live. ${num(diedBad(T))} of them ended dead under 0.75 ROAS — ${pct(pctOf(diedBad(T), T.attempts))} of everything tried — and ${num(deadZero)} returned nothing at all.`,
  });

  const graveyards = eligible
    .filter((r) => r.attempts >= Math.max(min, 8) && wasteRate(r) >= 60)
    .sort((a, b) => b.attempts - a.attempts);
  if (graveyards.length) {
    const g = graveyards[0];
    findings.push({
      severity: 'critical',
      headline: `${graveyards.length} shape${graveyards.length > 1 ? 's keep' : ' keeps'} being retried after mostly failing`,
      detail: `Worst repeated: ${label(g, grain)} — tried ${num(g.attempts)} times, ${num(diedBad(g))} of those died under 0.75 and ${num(g.bands.zero)} at zero, burning ${money(g.spend)} at ${g.roas.toFixed(2)}.`,
      action: 'Each retry pays the same tuition. These are the combinations to stop relaunching rather than to close faster.',
    });
  }

  const neverWorks = eligible
    .filter((r) => r.attempts >= Math.max(min, 6) && diedGood(r) === 0 && r.closed >= r.attempts * 0.8)
    .sort((a, b) => b.spend - a.spend);
  if (neverWorks.length) {
    findings.push({
      severity: 'watch',
      headline: `${neverWorks.length} shape${neverWorks.length > 1 ? 's have' : ' has'} never closed above break-even`,
      detail: neverWorks.slice(0, 3).map((r) => `${label(r, grain)} (${num(r.attempts)} tries, ${money(r.spend)})`).join('; ') + '.',
      action: 'Not one attempt has been switched off while earning 1.0 or better. Whatever is being tuned, it is not the thing that is wrong.',
    });
  }

  const survivors = eligible
    .filter((r) => r.attempts >= Math.max(min, 6) && r.roas >= 1.4 && closeRate(r) <= 40)
    .sort((a, b) => b.spend - a.spend);
  if (survivors.length) {
    findings.push({
      severity: 'neutral',
      headline: `${survivors.length} shape${survivors.length > 1 ? 's survive' : ' survives'} far more often than the book average`,
      detail: survivors.slice(0, 3).map((r) => `${label(r, grain)} — ${pct(closeRate(r))} closed against ${pct(pctOf(T.closed, T.attempts))} overall, at ${r.roas.toFixed(2)}`).join('; ') + '.',
      action: 'These are the shapes worth more launches, not the ones that merely survived once.',
    });
  }

  const unmapped = rows.filter((r) => r.product === 'unmapped' || r.product === '—')
    .reduce((s, r) => s + r.attempts, 0);
  if (grain !== 'b' && grain !== 'c' && unmapped > T.attempts * 0.08) {
    findings.push({
      severity: 'watch',
      headline: `${pct(pctOf(unmapped, T.attempts))} of attempts have no product mapped`,
      detail: `${num(unmapped)} campaign-days sit under "unmapped" because no row exists for that campaign in camp_product_resolved. They are counted in every total but cannot be read product-wise.`,
      action: 'Worth a classifier pass — until then these attempts are invisible to any product-level decision.',
    });
  }

  /* ── table ────────────────────────────────────────────────────────────── */
  const showP = grain !== 'b' && grain !== 'c';
  const showB = grain === 'pbc' || grain === 'pb' || grain === 'b';
  const showC = grain === 'pbc' || grain === 'c';

  const cols: Col<AttemptRow>[] = [];
  if (showP) cols.push({ key: 'p', head: 'Product', align: 'l', render: (r) => (
      <span className="block max-w-[190px] truncate text-text-strong" title={r.product}>{r.product}</span>
    ) });
  if (showB) cols.push({ key: 'b', head: 'Sales block', align: 'l', render: (r) => (
      <span className="block max-w-[230px] truncate text-muted" title={r.saleBlock}>{r.saleBlock}</span>
    ) });
  if (showC) cols.push({ key: 'c', head: 'Creative', align: 'l', render: (r) => (
      <span className="block max-w-[150px] truncate text-muted" title={r.creativeType}>{r.creativeType}</span>
    ) });
  cols.push(
    { key: 'a', head: 'Attempts', align: 'r', render: (r) => (
        <span className="text-text-strong">{num(r.attempts)}</span>
      ) },
    { key: 'x', head: 'Closed', align: 'r', render: (r) => num(r.closed) },
    { key: 'cr', head: 'Closed %', align: 'r', render: (r) => (
        <span className={closeRate(r) >= 80 ? 'text-warn' : ''}>{pct(closeRate(r))}</span>
      ) },
    { key: 'd', head: 'ROAS it died at', align: 'l', render: (r) => <Deaths r={r} /> },
    { key: 'z', head: 'At zero', align: 'r', render: (r) => (
        r.bands.zero ? <span className="text-bad">{num(r.bands.zero)}</span> : <span className="text-muted">–</span>
      ) },
    { key: 'w', head: 'Under 0.75', align: 'r', render: (r) => (
        <span className={wasteRate(r) >= 50 ? 'text-warn' : ''}>{num(diedBad(r))}</span>
      ) },
    { key: 'g', head: 'At 1.0+', align: 'r', render: (r) => (
        diedGood(r) ? <span className="text-good">{num(diedGood(r))}</span> : <span className="text-muted">–</span>
      ) },
    { key: 's', head: 'Survived', align: 'r', render: (r) => num(r.survived) },
    { key: 'sp', head: 'Spend', align: 'r', render: (r) => rs(r.spend) },
    { key: 'r', head: 'ROAS', align: 'r', render: (r) => <Roas v={r.roas} /> },
  );

  const href = (over: Record<string, string>) => {
    const qs = new URLSearchParams();
    if (range.custom) { qs.set('from', range.from); qs.set('to', range.to); }
    else qs.set('days', String(range.days));
    if (scope.key !== 'all') qs.set('site', scope.key);
    qs.set('grain', grain); qs.set('sort', sort); qs.set('min', String(min));
    for (const [k, v] of Object.entries(over)) qs.set(k, v);
    return `/attempts?${qs.toString()}`;
  };
  const chip = (on: boolean, to: string, text: string) => (
    <Link
      key={text}
      href={to}
      className={`rounded-lg border px-3 py-1.5 text-[12px] transition ${
        on ? 'border-gold/50 bg-gold/10 text-gold' : 'border-edge text-muted hover:text-text'
      }`}
    >
      {text}
    </Link>
  );

  return (
    <Page
      title="Attempts"
      subtitle={`${range.from} → ${range.to} · ${num(T.attempts)} campaign-days · ${scope.label}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat
          label="Attempts"
          value={num(T.attempts)}
          sub={`${num(T.camps)} campaigns over ${range.span} days`}
        />
        <Stat
          label="Closed"
          value={num(T.closed)}
          sub={`${pct(pctOf(T.closed, T.attempts))} of everything tried`}
        />
        <Stat
          label="Died under 0.75"
          value={num(diedBad(T))}
          sub={`${num(T.bands.zero)} of them returned nothing at all`}
        />
        <Stat
          label="Return on it all"
          value={T.roas.toFixed(2)}
          sub={`${lakh(T.spend)} spent · ${lakh(T.budgetClosed)} of budget closed`}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${T.attempts} attempts, ${range.span} days`} />

      <Card
        title="Every attempt, by the ROAS it ended at"
        note="closed attempts banded lowest to highest, then the ones that survived the day"
      >
        <ShareBar
          fmt={(v) => `${num(v)} attempts`}
          parts={ROAS_BANDS.map((b) => ({
            label: b.label, color: b.color, value: T.bands[b.key as BandKey],
          })).concat([{ label: 'survived', color: 'var(--edge)', value: T.survived }])
            .filter((p) => p.value > 0)}
        />
      </Card>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-muted">Group by</span>
          {GRAINS.map((g) => chip(g.key === grain, href({ grain: g.key }), g.label))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-muted">Order</span>
          {SORTS.map((s) => chip(s.key === sort, href({ sort: s.key }), s.label))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-muted">At least</span>
          {[1, 3, 5, 10, 20].map((m) => chip(m === min, href({ min: String(m) }), `${m} attempt${m > 1 ? 's' : ''}`))}
        </div>
      </div>

      <Card
        title={`${GRAINS.find((g) => g.key === grain)!.label}`}
        note={`${num(sorted.length)} of ${num(rows.length)} combinations with at least ${min} attempt${min > 1 ? 's' : ''} · ${SORTS.find((s) => s.key === sort)!.label.toLowerCase()}`}
      >
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[10.5px] text-muted">
          {ROAS_BANDS.map((b) => (
            <span key={b.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: b.color }} />
              {b.label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-edge" />
            survived
          </span>
        </div>
        <Table cols={cols} rows={sorted} footer={{ ...T, product: 'TOTAL', saleBlock: '', creativeType: '' }} />
      </Card>

      <Card
        title="The shapes tried most often"
        note="regardless of how they did — the ten combinations the book keeps reaching for"
      >
        <Table cols={cols} rows={mostTried} />
      </Card>

      <Note>
        <b className="text-text-strong">An attempt is one campaign-day that went live.</b> The same
        campaign running five days is five attempts, because each day it was funded again and could
        have been switched off instead; counting distinct campaigns would call a fortnight of burn
        &ldquo;two tries&rdquo;. Budget parked on a campaign that never went active that day is not
        an attempt at anything and is excluded.
        {' '}The ROAS an attempt <b className="text-text-strong">died at</b> is that campaign-day&apos;s
        own return, which includes delivery that landed after the pause.
        {' '}Creative type is kept whole rather than split into tags — <span className="text-text">Paras | Motion</span>{' '}
        is one shape someone chose, not two — so every column here sums honestly.
        {' '}The window is {range.span} complete days ending {range.to}; today is excluded because its
        attempts have not finished yet.
      </Note>
    </Page>
  );
}

function label(r: AttemptRow, g: Grain) {
  const bits = [
    g !== 'b' && g !== 'c' ? r.product : null,
    g === 'pbc' || g === 'pb' || g === 'b' ? r.saleBlock.slice(0, 40) : null,
    g === 'pbc' || g === 'c' ? r.creativeType : null,
  ].filter(Boolean);
  return bits.join(' · ');
}
