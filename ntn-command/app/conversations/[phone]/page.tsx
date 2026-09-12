import { getTranscript, BotUnreachable, ist, STATUS_LABEL } from '@/lib/conversations';
import { Page, Card, Grid, Stat, Note, Crumb, num } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ConversationPage({
  params,
}: { params: Promise<{ phone: string }> }) {
  const { phone } = await params;

  let t;
  try {
    t = await getTranscript(phone);
  } catch (e) {
    return (
      <Page title={phone} subtitle="conversation">
        <Note kind="warn">
          Could not reach the bot: {e instanceof BotUnreachable ? e.message : String(e)}
        </Note>
      </Page>
    );
  }

  const u = (t.user || {}) as Record<string, string | number | null>;
  const paid = t.entitlements.filter((e) =>
    ['shopify-webhook', 'order-command', 'manual'].includes(e.source));
  const paidTotal = paid.reduce((s, e) => s + e.questions_total, 0);
  const paidUsed = paid.reduce((s, e) => s + e.questions_used, 0);
  const byQuestion = new Map(t.questions.map((q) => [q.question.trim(), q]));

  return (
    <Page
      title={(u.name as string) || phone}
      subtitle={`${phone}${u.language ? ` · ${u.language}` : ''}`}
      actions={<Crumb href="/conversations">All conversations</Crumb>}
    >
      <Grid cols={4}>
        <Stat label="Questions" value={paidTotal ? `${paidUsed}/${paidTotal}` : '—'}
              sub={paid.length ? paid.map((e) => e.order_name).join(', ') : 'never paid'} />
        <Stat label="Asked" value={num(t.questions.length)} />
        <Stat label="Messages" value={num(t.messages.length)} />
        <Stat label="State" value={(u.state as string) || '—'}
              sub={u.report_sent_at ? 'report sent' : 'no report yet'} />
      </Grid>

      <Card title="Birth details" note="What every reading for this customer is calculated from.">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
          {[['Name', u.name], ['Date of birth', u.dob],
            ['Birth time', u.birth_time], ['Place', u.place]].map(([k, v]) => (
            <div key={String(k)}>
              <dt className="text-[10.5px] uppercase tracking-[0.14em] text-muted">{k}</dt>
              <dd className="mt-0.5">{(v as string) || <span className="text-muted">—</span>}</dd>
            </div>
          ))}
        </dl>
        {!u.dob && (
          <div className="mt-3">
            <Note kind="warn">Onboarding never finished — no chart exists for this customer.</Note>
          </div>
        )}
      </Card>

      {t.entitlements.length > 0 && (
        <Card title="Purchases and grants">
          <ul className="space-y-1.5 text-[12.5px]">
            {t.entitlements.map((e, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{e.order_name}</span>
                <span className="text-muted">{e.sku}</span>
                <span className={['shopify-webhook', 'order-command', 'manual'].includes(e.source)
                  ? 'rounded bg-good/15 px-1.5 text-[10.5px] text-good'
                  : 'rounded bg-edge/40 px-1.5 text-[10.5px] text-muted'}>{e.source}</span>
                <span className="tabular-nums text-muted">
                  {e.questions_used}/{e.questions_total} used
                </span>
                <span className="text-muted">{ist(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Transcript" note="Every message, oldest first. Answers show their guard verdict.">
        <div className="space-y-2">
          {t.messages.map((m, i) => {
            const q = m.direction === 'in' ? byQuestion.get(m.body.trim()) : undefined;
            const inbound = m.direction === 'in';
            return (
              <div key={i} className={`flex ${inbound ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[78%] rounded-xl px-3 py-2 text-[12.5px] leading-relaxed ${
                  inbound ? 'bg-panel/70' : 'bg-gold/10'}`}>
                  <div className="whitespace-pre-wrap break-words">{m.body}</div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
                    <span>{ist(m.ts)}</span>
                    {q && (
                      <span className={q.guard_status === 'clean' ? 'text-good' : 'text-warn'}>
                        billed · {q.topic} · {q.guard_status}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {!t.messages.length && (
            <p className="py-6 text-center text-[12px] text-muted">No messages recorded.</p>
          )}
        </div>
      </Card>
    </Page>
  );
}
