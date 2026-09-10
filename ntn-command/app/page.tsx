import Link from 'next/link';
import { MODULES, SECTIONS } from '@/lib/modules';
import { closingOn, campDays, roasOf, share, LOSING, bandOf } from '@/lib/ads';
import { repeatRate, paymentsByDay, isCOD, istDates } from '@/lib/commerce';
import { istToday } from '@/lib/range';
import PageControls from '@/components/PageControls';
import { Page, Card, Grid, Stat, Note, lakh, pct, num, rs } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DOT: Record<string, string> = { live: 'bg-good', partial: 'bg-warn', planned: 'bg-edge' };

/** Each headline is wrapped so one dead module cannot blank the console. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

export default async function Console() {
  const { today, yesterday } = await istDates();
  const from7 = new Date(new Date(today).getTime() - 7 * 86400000).toISOString().slice(0, 10);

  const [snap, days, rep, pay] = await Promise.all([
    safe(() => closingOn(istToday())),
    safe(() => campDays(from7, today)),
    safe(() => repeatRate(from7, today)),
    safe(() => paymentsByDay(yesterday, yesterday)),
  ]);

  // Ads
  const alloc = snap?.rows.reduce((s, r) => s + r.budget, 0) ?? 0;
  const closed = snap?.rows.filter((r) => r.closed).reduce((s, r) => s + r.budget, 0) ?? 0;

  const yRows = (days ?? []).filter((r) => r.date === yesterday && r.spend > 0);
  const ySpend = yRows.reduce((s, r) => s + r.spend, 0);
  const yRev = yRows.reduce((s, r) => s + r.revenue, 0);
  const yLosing = yRows.filter((r) => LOSING.includes(bandOf(r.roas))).reduce((s, r) => s + r.spend, 0);

  // Commerce
  const yPay = pay ?? [];
  const payRev = yPay.reduce((s, r) => s + r.revenue, 0);
  const payOrders = yPay.reduce((s, r) => s + r.orders, 0);
  const codRev = yPay.filter((r) => isCOD(r.mode)).reduce((s, r) => s + r.revenue, 0);

  const yRep = (rep ?? []).filter((r) => r.date === yesterday);
  const repN = yRep.reduce((s, r) => s + r.repeatOrders, 0);
  const newN = yRep.reduce((s, r) => s + r.newOrders, 0);

  return (
    <Page
      title="NTN Command"
      subtitle={`Yesterday ${yesterday} · today's ads state at the ${snap?.cutIST ?? '—'} IST snapshot`}
      actions={<PageControls dates={false} />}
    >
      <Grid cols={4}>
        <Stat
          label="Shop · yesterday"
          value={payRev ? lakh(payRev) : '–'}
          sub={payOrders ? `${num(payOrders)} orders · AOV ${rs(payRev / payOrders)}` : 'no orders recorded'}
        />
        <Stat
          label="Ads · yesterday"
          value={ySpend ? roasOf(yRev, ySpend).toFixed(2) : '–'}
          sub={ySpend ? `${lakh(ySpend)} spent · ${pct(share(yLosing, ySpend))} below 1.0` : 'no spend recorded'}
        />
        <Stat
          label="Closed today"
          value={alloc ? pct(share(closed, alloc)) : '–'}
          sub={alloc ? `${lakh(closed)} of ${lakh(alloc)} switched off` : 'no snapshot yet'}
        />
        <Stat
          label="Returning · yesterday"
          value={repN + newN ? pct((repN / (repN + newN)) * 100) : '–'}
          sub={repN + newN ? `${num(repN)} of ${num(repN + newN)} orders` : 'not attributable'}
        />
      </Grid>

      {payRev > 0 && (
        <Note>
          COD took <b className="text-text-strong">{pct((codRev / payRev) * 100)}</b> of yesterday&apos;s
          value. Every figure on this console links to the module it came from — nothing here is
          computed twice.
        </Note>
      )}

      {SECTIONS.map((sec) => {
        const mods = MODULES.filter((m) => m.section === sec.key);
        if (!mods.length) return null;
        return (
          <Card key={sec.key} title={sec.label} note={sec.blurb}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {mods.map((m) => (
                <Link
                  key={m.slug}
                  href={`/${m.slug}`}
                  className="group rounded-lg border border-edge bg-panel/40 p-3.5 transition hover:border-gold/40 hover:bg-tint"
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[m.status]}`} />
                    <span className="text-[13px] font-medium text-text group-hover:text-gold">
                      {m.label}
                    </span>
                    {m.status !== 'live' && (
                      <span className="ml-auto text-[9.5px] uppercase tracking-wider text-muted">
                        {m.status}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{m.question}</p>
                  <p className="mt-1.5 truncate text-[10px] text-muted/60" title={m.source}>
                    {m.source}
                  </p>
                </Link>
              ))}
            </div>
          </Card>
        );
      })}

      <Note>
        Every module reads the warehouse directly — nothing on this site is an embedded copy of
        another dashboard. Where a number cannot be built honestly from the data that exists, the
        module says so on its own page rather than showing a plausible-looking chart.
      </Note>
    </Page>
  );
}
