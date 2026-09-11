import { campDays, creativeTags, sentimentsOf, roasOf, share, PORTAL_NAME, PORTALS, LOSING, bandOf } from '@/lib/ads';
import { adDays, adDatesAvailable } from '@/lib/brief';
import {
  creativesOn, pushedOn, countBy, sentimentKeys, typeKeys,
  roas as cRoas, isRunning, isUnknown,
} from '@/lib/creative';
import CreativeCard from '@/components/CreativeCard';
import { resolveRange, resolveScope, istToday, type SearchParams } from '@/lib/range';
import { rank, wilson, enough, money, pctOf, concentration, type Finding } from '@/lib/insights';
import { BarList, ShareBar, Donut, SERIES } from '@/components/charts';
import PageControls from '@/components/PageControls';
import {
  Page, Card, Grid, Stat, Table, Roas, Note, Analysis, lakh, rs, pct, num, type Col,
} from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Cr = {
  key: string; days: number; spend: number; rev: number;
  winners: number; losing: number;
};

export default async function CreativePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, 60);
  const scope = resolveScope(sp);
  // Sentiment lives in the ad NAME, so it needs the ad-level table; creative
  // type is a campaign attribute and stays on the campaign one.
  // The gallery is about one day; the rest of the page is about the window.
  const availableDays = await adDatesAvailable(30);
  const istNow = istToday();
  const askedDay = Array.isArray(sp?.day) ? sp.day[0] : sp?.day;
  const settled = availableDays.filter((d) => d < istNow);
  const day = askedDay && availableDays.includes(askedDay)
    ? askedDay
    : (settled[0] ?? availableDays[0] ?? range.to);

  const controls = (
    <PageControls
      range={range} scope={scope}
      days={availableDays.slice(0, 10)} day={day} today={istNow}
    />
  );

  const [campRows, adRows, creatives] = await Promise.all([
    campDays(range.from, range.to, scope.codes),
    adDays(range.from, range.to, scope.codes),
    creativesOn(day, scope.codes),
  ]);
  const all = campRows.filter((r) => r.spend > 0);

  if (!all.length) {
    return (
      <Page title="Creative Success" subtitle={range.label} actions={controls}>
        <Note kind="warn">No campaign-days with spend between {range.from} and {range.to}.</Note>
      </Page>
    );
  }

  // A campaign tagged "Paras | Motion" counts toward both tags: the question is
  // which styles show up in winners, not which exact combination string does.
  const m = new Map<string, Cr>();
  for (const r of all) {
    for (const tag of creativeTags(r.creativeType)) {
      const c = m.get(tag) ?? { key: tag, days: 0, spend: 0, rev: 0, winners: 0, losing: 0 };
      c.days += 1;
      c.spend += r.spend;
      c.rev += r.revenue;
      if (r.roas >= 1) c.winners += 1;
      if (LOSING.includes(bandOf(r.roas))) c.losing += r.spend;
      m.set(tag, c);
    }
  }
  const rows = [...m.values()].sort((a, b) => b.spend - a.spend);

  const totalSpend = all.reduce((s, r) => s + r.spend, 0);
  const totalRev = all.reduce((s, r) => s + r.revenue, 0);
  const overallHit = pctOf(all.filter((r) => r.roas >= 1).length, all.length);

  /* ── sentiment, from the ad name ──────────────────────────────────────── */
  type Sent = { key: string; attempts: number; spend: number; rev: number; winners: number; ads: Set<string> };
  const sentMap = new Map<string, Sent>();
  const adsSpent = adRows.filter((r) => r.spend > 0);
  for (const r of adsSpent) {
    for (const k of sentimentsOf(r.adName)) {
      const x = sentMap.get(k) ?? { key: k, attempts: 0, spend: 0, rev: 0, winners: 0, ads: new Set<string>() };
      x.attempts += 1;
      x.spend += r.spend;
      x.rev += r.revenue;
      x.ads.add(r.adId);
      if (r.spend > 0 && r.revenue / r.spend >= 1) x.winners += 1;
      sentMap.set(k, x);
    }
  }
  const sents = [...sentMap.values()].sort((a, b) => b.spend - a.spend);
  const adSpendTotal = adsSpent.reduce((s2, r) => s2 + r.spend, 0);
  const marked = sents.filter((x) => x.key !== 'unmarked');
  const markedSpend = marked.reduce((s2, x) => s2 + x.spend, 0);
  const unmarked = sentMap.get('unmarked');
  const bookHit = pctOf(adsSpent.filter((r) => r.revenue / r.spend >= 1).length, adsSpent.length);


  /* ── the day's creative gallery ───────────────────────────────────────── */
  const ranToday = creatives.filter((c) => c.d1.spend > 0);
  const runningNow = creatives.filter((c) => isRunning(c.status));
  // An ad we have never fetched is not the same as a closed one. Counting the
  // two together turned "closed" into "everything we have not looked up".
  const unknownStatus = creatives.filter(isUnknown);
  const closedNow = creatives.filter((c) => !isRunning(c.status) && !isUnknown(c));
  const pushed = pushedOn(creatives, day);

  // Best performers: judged on the 7-day window, not the single day, and only
  // where enough money went through to mean something. A creative that spent
  // Rs 200 and returned Rs 900 is not the best thing in the account.
  const BEST_MIN_SPEND = 3000;
  const bestCreatives = [...creatives]
    .filter((c) => c.d7.spend >= BEST_MIN_SPEND)
    .sort((a, b) => cRoas(b.d7.revenue, b.d7.spend) - cRoas(a.d7.revenue, a.d7.spend))
    .slice(0, 12);

  // Active allocation: spend on the day, by creative type, for ads still running.
  const activeAlloc = new Map<string, number>();
  for (const c of runningNow) {
    for (const t of typeKeys(c)) {
      activeAlloc.set(t, (activeAlloc.get(t) ?? 0) + c.d1.spend);
    }
  }
  const allocParts = [...activeAlloc.entries()]
    .filter(([, v]) => v > 0)
    .map(([label, value], i) => ({ label, value, color: SERIES[i % SERIES.length] }));

  const pushedByType = countBy(pushed, typeKeys);
  const pushedBySent = countBy(pushed, sentimentKeys);
  const dayCreativeSpend = ranToday.reduce((a, c) => a + c.d1.spend, 0);

  /* ── findings ───────────────────────────────────────────────────────────── */
  const findings: Finding[] = [];
  const solid = rows.filter((c) => enough(c.days, 25));

  const best = [...solid].sort((a, b) => roasOf(b.rev, b.spend) - roasOf(a.rev, a.spend))[0];
  const worst = [...solid].sort((a, b) => roasOf(a.rev, a.spend) - roasOf(b.rev, b.spend))[0];

  if (best && worst && best.key !== worst.key) {
    const bw = wilson(best.winners, best.days);
    const ww = wilson(worst.winners, worst.days);
    const separated = bw.lo > ww.hi;
    findings.push({
      severity: separated ? 'good' : 'neutral',
      headline: separated
        ? `${best.key} genuinely beats ${worst.key}`
        : `${best.key} leads ${worst.key}, but not conclusively`,
      detail: `${best.key} clears 1.0 on ${bw.rate.toFixed(0)}% of ${best.days} campaign-days (CI ${bw.lo.toFixed(0)}–${bw.hi.toFixed(0)}%) at ${roasOf(best.rev, best.spend).toFixed(2)} ROAS; ${worst.key} on ${ww.rate.toFixed(0)}% of ${worst.days} (CI ${ww.lo.toFixed(0)}–${ww.hi.toFixed(0)}%) at ${roasOf(worst.rev, worst.spend).toFixed(2)}.`,
      action: separated
        ? `The intervals do not overlap, so this is a real difference. Weight new launches toward ${best.key}.`
        : 'The confidence intervals overlap, so the gap could be noise. Not yet a reason to shift budget.',
    });
  }

  const burners = solid
    .filter((c) => roasOf(c.rev, c.spend) < 0.9 && c.spend >= totalSpend * 0.08)
    .sort((a, b) => b.spend - a.spend);
  for (const c of burners.slice(0, 2)) {
    findings.push({
      severity: 'critical',
      headline: `${c.key} carries ${pctOf(c.spend, totalSpend).toFixed(0)}% of spend and does not return`,
      detail: `${money(c.spend)} at ${roasOf(c.rev, c.spend).toFixed(2)} ROAS, with ${pctOf(c.losing, c.spend).toFixed(0)}% of its spend under break-even.`,
      action: 'A creative style this large and this weak sets the blended number by itself.',
    });
  }

  const conc = concentration(rows, (c) => c.spend);
  if (conc.top && conc.topShare >= 45) {
    findings.push({
      severity: 'watch',
      headline: `${conc.topShare.toFixed(0)}% of spend runs on one creative style`,
      detail: `${conc.top.key} at ${roasOf(conc.top.rev, conc.top.spend).toFixed(2)} ROAS. Concentration this high means creative fatigue hits the whole book at once rather than one segment.`,
    });
  }

  const thin = rows.filter((c) => !enough(c.days, 25));
  if (thin.length) {
    findings.push({
      severity: 'neutral',
      headline: `${thin.length} style${thin.length > 1 ? 's have' : ' has'} too little volume to judge`,
      detail: `${thin.slice(0, 3).map((c) => `${c.key} (${c.days} campaign-days)`).join('; ')}. Rates on samples this small move on a single day.`,
    });
  }

  const rankedSent = marked
    .filter((x) => enough(x.attempts, 25))
    .sort((a, b) => wilson(b.winners, b.attempts).lo - wilson(a.winners, a.attempts).lo);

  if (rankedSent.length) {
    const best = rankedSent[0];
    const w = wilson(best.winners, best.attempts);
    findings.push({
      severity: w.lo > bookHit ? 'good' : 'neutral',
      headline: `${best.key} is the strongest sentiment`,
      detail: `${w.rate.toFixed(0)}% of its ${best.attempts} attempts cleared 1.0 (CI ${w.lo.toFixed(0)}–${w.hi.toFixed(0)}%) on ${money(best.spend)} at ${roasOf(best.rev, best.spend).toFixed(2)} ROAS. Every ad in the window clears ${bookHit.toFixed(0)}%.`,
      action: w.lo > bookHit
        ? 'Its worst case beats the book, so this angle is worth briefing more of.'
        : undefined,
    });
    const worst = rankedSent[rankedSent.length - 1];
    const ww = wilson(worst.winners, worst.attempts);
    if (worst.key !== best.key && ww.hi < bookHit) {
      findings.push({
        severity: 'critical',
        headline: `${worst.key} underperforms the book consistently`,
        detail: `${ww.rate.toFixed(0)}% of ${worst.attempts} attempts cleared 1.0 (CI ${ww.lo.toFixed(0)}–${ww.hi.toFixed(0)}%) at ${roasOf(worst.rev, worst.spend).toFixed(2)} ROAS — even its best case is under the ${bookHit.toFixed(0)}% book rate.`,
        action: 'Stop briefing this angle until something about the execution changes.',
      });
    }
  }

  if (unmarked && adSpendTotal > 0 && unmarked.spend / adSpendTotal > 0.5) {
    findings.push({
      severity: 'watch',
      headline: `${pctOf(unmarked.spend, adSpendTotal).toFixed(0)}% of ad spend carries no sentiment marker`,
      detail: `${money(unmarked.spend)} across ${unmarked.attempts} ad-days has no _testimonial, _achievement or similar token in its name, so it cannot be attributed to an angle at all.`,
      action: 'The sentiment read below is only as good as the naming. Marked ads are a minority of the book.',
    });
  }

  const sentCols: Col<Sent>[] = [
    { key: 'k', head: 'Sentiment', align: 'l', render: (x) => (
        <span className={x.key === 'unmarked' ? 'text-muted' : ''}>{x.key}</span>
      ) },
    { key: 'ads', head: 'Creatives', align: 'r', render: (x) => num(x.ads.size) },
    { key: 'a', head: 'Attempts', align: 'r', render: (x) => num(x.attempts) },
    { key: 's', head: 'Spend', align: 'r', render: (x) => rs(x.spend) },
    { key: 'sh', head: '% of ad spend', align: 'r', render: (x) => pct(share(x.spend, adSpendTotal), 1) },
    { key: 'r', head: 'ROAS', align: 'r', render: (x) => <Roas v={roasOf(x.rev, x.spend)} /> },
    { key: 'w', head: 'Clear 1.0', align: 'r', render: (x) => pct(share(x.winners, x.attempts)) },
    { key: 'ci', head: '95% CI', align: 'r', render: (x) => {
        const w = wilson(x.winners, x.attempts);
        return enough(x.attempts, 25)
          ? <span className="text-muted">{w.lo.toFixed(0)}–{w.hi.toFixed(0)}%</span>
          : <span className="text-muted">too few</span>;
      } },
  ];

  const cols: Col<Cr>[] = [
    { key: 'k', head: 'Creative style', align: 'l', render: (c) => c.key },
    { key: 'd', head: 'Camp-days', align: 'r', render: (c) => num(c.days) },
    { key: 's', head: 'Spend', align: 'r', render: (c) => rs(c.spend) },
    { key: 'sh', head: '% of spend', align: 'r', render: (c) => pct(share(c.spend, totalSpend), 1) },
    { key: 'r', head: 'ROAS', align: 'r', render: (c) => <Roas v={roasOf(c.rev, c.spend)} /> },
    { key: 'w', head: 'Clear 1.0', align: 'r', render: (c) => pct(share(c.winners, c.days)) },
    { key: 'ci', head: '95% CI', align: 'r', render: (c) => {
        const w = wilson(c.winners, c.days);
        return enough(c.days, 25)
          ? <span className="text-muted">{w.lo.toFixed(0)}–{w.hi.toFixed(0)}%</span>
          : <span className="text-muted">too few</span>;
      } },
    { key: 'l', head: 'Below 1.0', align: 'r', render: (c) => (
        <span className={share(c.losing, c.spend) >= 50 ? 'text-bad' : ''}>
          {pct(share(c.losing, c.spend))}
        </span>
      ) },
  ];

  return (
    <Page
      title="Creative Success"
      subtitle={`${range.label} · ${scope.label}`}
      actions={controls}
    >
      <Grid cols={4}>
        <Stat label="Styles in use" value={num(rows.length)} sub={`over ${num(all.length)} campaign-days`} />
        <Stat label="Blended ROAS" value={roasOf(totalRev, totalSpend).toFixed(3)} sub={lakh(totalSpend)} />
        <Stat label="Overall hit rate" value={pct(overallHit)} sub="campaign-days clearing 1.0" />
        <Stat
          label="Best style with volume"
          value={best ? roasOf(best.rev, best.spend).toFixed(2) : '–'}
          sub={best ? `${best.key} · ${num(best.days)} campaign-days` : 'none with enough volume'}
        />
      </Grid>

      <Analysis findings={rank(findings)} basis={`${range.label}, ${num(all.length)} campaign-days`} />

      <Card title="Spend by creative style" note="a campaign using two styles counts toward both">
        <ShareBar
          fmt={rs}
          parts={rows.map((c, i) => ({ label: c.key, value: c.spend, color: SERIES[i % SERIES.length] }))}
        />
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="Return by style" note="revenue ÷ spend">
          <BarList
            fmt={(v) => v.toFixed(2)}
            rows={rows.map((c) => ({
              label: c.key,
              value: roasOf(c.rev, c.spend),
              sub: lakh(c.spend),
              color: roasOf(c.rev, c.spend) >= 1.3 ? '#1baf7a'
                : roasOf(c.rev, c.spend) >= 1 ? '#eda100' : '#eb6834',
            }))}
          />
        </Card>
        <Card title="Hit rate by style" note="share of campaign-days clearing 1.0">
          <BarList
            fmt={(v) => pct(v)} max={100}
            rows={rows.map((c) => ({
              label: c.key,
              value: share(c.winners, c.days),
              sub: `${c.winners}/${c.days}`,
              color: enough(c.days, 25) ? '#2a78d6' : '#5aa9a3',
            }))}
          />
        </Card>
      </div>

      <Grid cols={4}>
        <Stat
          label={`Creatives live on ${day}`}
          value={num(ranToday.length)}
          sub={`${rs(dayCreativeSpend)} spent · ${num(runningNow.length)} still running now`}
        />
        <Stat
          label="Pushed that day"
          value={num(pushed.length)}
          sub={pushed.length ? `${num(pushedByType.length)} creative types · ${num(pushedBySent.length)} sentiments` : 'no new creatives created'}
        />
        <Stat
          label="Still running"
          value={num(runningNow.length)}
          sub={`of ${num(creatives.length)} seen in the last 90 days`}
        />
        <Stat
          label="Closed"
          value={num(closedNow.length)}
          sub={unknownStatus.length
            ? `paused or campaign-paused · ${num(unknownStatus.length)} not yet looked up`
            : 'paused, or their campaign is'}
        />
      </Grid>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="Active creative type allocation" note={`spend on ${day} by ads still running`}>
          <Donut
            parts={allocParts}
            fmt={rs}
            total={rs(allocParts.reduce((a, p) => a + p.value, 0))}
            caption="live spend"
          />
        </Card>
        <Card
          title={`Pushed on ${day}`}
          note={pushed.length ? `${num(pushed.length)} new creatives` : 'nothing new that day'}
        >
          {pushed.length ? (
            <div className="space-y-4">
              <div>
                <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-muted">By creative type</div>
                <BarList
                  fmt={num}
                  rows={pushedByType.map((x, i) => ({
                    label: x.key, value: x.count,
                    sub: pct((x.count / pushed.length) * 100, 0),
                    color: SERIES[i % SERIES.length],
                  }))}
                />
              </div>
              <div>
                <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-muted">By sentiment</div>
                <BarList
                  fmt={num}
                  rows={pushedBySent.map((x) => ({
                    label: x.key, value: x.count,
                    sub: pct((x.count / pushed.length) * 100, 0),
                    color: x.key === 'unmarked' ? '#5a6472' : '#1baf7a',
                  }))}
                />
              </div>
            </div>
          ) : (
            <p className="py-8 text-center text-[12px] text-muted">
              No creative was created on {day}. Ads running that day were pushed earlier.
            </p>
          )}
        </Card>
      </div>

      <Card
        title="Best performing creatives"
        note={`ranked on 7-day ROAS, minimum ${rs(BEST_MIN_SPEND)} of spend in that window`}
      >
        {bestCreatives.length ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {bestCreatives.map((c) => <CreativeCard key={c.adId} c={c} day={day} />)}
          </div>
        ) : (
          <p className="py-6 text-center text-[12px] text-muted">
            Nothing cleared {rs(BEST_MIN_SPEND)} of spend in the 7 days to {day}.
          </p>
        )}
      </Card>

      <Card
        title={`Every creative running on ${day}`}
        note={`${num(ranToday.length)} with spend · thumbnail opens the post · each shows the day, 3-day, 7-day and lifetime figures`}
      >
        {ranToday.length ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {ranToday.slice(0, 60).map((c) => <CreativeCard key={c.adId} c={c} day={day} />)}
          </div>
        ) : (
          <p className="py-6 text-center text-[12px] text-muted">No creative spent on {day}.</p>
        )}
        {ranToday.length > 60 && (
          <p className="mt-3 text-center text-[11px] text-muted">
            Showing the 60 largest by spend, of {num(ranToday.length)}.
          </p>
        )}
      </Card>

      <Card
        title="Sentiment, from the ad name"
        note={`${pct(share(markedSpend, adSpendTotal), 1)} of ad spend carries a marker`}
      >
        {marked.length ? (
          <>
            <BarList
              fmt={(v) => pct(v)} max={100}
              rows={marked.map((x) => ({
                label: x.key,
                value: share(x.winners, x.attempts),
                sub: `${x.winners}/${x.attempts} · ${lakh(x.spend)} · ${roasOf(x.rev, x.spend).toFixed(2)}`,
                color: enough(x.attempts, 25)
                  ? (share(x.winners, x.attempts) >= bookHit ? '#1baf7a' : '#eb6834')
                  : '#5aa9a3',
              }))}
            />
            <div className="mt-4">
              <Table cols={sentCols} rows={sents} />
            </div>
          </>
        ) : (
          <p className="py-4 text-center text-[12px] text-muted">
            No ad in this window carries a sentiment marker in its name.
          </p>
        )}
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
          Markers are read from the ad name at upload — <span className="text-text">_testimonial</span>,{' '}
          <span className="text-text">_achievement</span> and the rest — because this warehouse has
          no stored sentiment column. An ad naming two angles counts toward both, so the
          percentages do not sum to 100. Bars are green only where the angle beats the{' '}
          {bookHit.toFixed(0)}% book hit rate on enough attempts to mean it.
        </p>
      </Card>

      <Card title="Every creative style" note="95% interval shown where there is enough volume to mean anything">
        <Table cols={cols} rows={rows} />
      </Card>

      <Note>
        <span className="text-text">creative_type</span> arrives as pipe-joined combinations, so
        &ldquo;Paras | Motion&rdquo; is counted under both Paras and Motion. Percentages therefore
        sum above 100% — deliberately, because the question is which styles appear in winners
        rather than which exact combination string does. Sentiment is classified by a separate
        workflow and is not on this table yet.
      </Note>
    </Page>
  );
}
