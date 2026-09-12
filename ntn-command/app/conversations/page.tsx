import Link from 'next/link';
import {
  listConversations, BotUnreachable, ist, ago,
  STATUS_LABEL, STATUS_TONE, type Conversation, type ConvStatus,
} from '@/lib/conversations';
import { Page, Card, Grid, Stat, Table, Note, num, type Col } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ORDER: ConvStatus[] = ['active', 'waiting', 'spent', 'onboarding', 'dormant'];

export default async function ConversationsPage({
  searchParams,
}: { searchParams: Promise<{ status?: string; bought?: string }> }) {
  const sp = await searchParams;

  let data;
  try {
    data = await listConversations();
  } catch (e) {
    const why = e instanceof BotUnreachable ? e.message : String(e);
    return (
      <Page title="WhatsApp Conversations" subtitle="astro bot">
        <Note kind="warn">
          Could not reach the bot: {why}. The feed comes from{' '}
          <code>astro.jaddibooty.in/admin/conversations</code>; check the box is up and that{' '}
          <code>ASTRO_ADMIN_TOKEN</code> is set on this project.
        </Note>
      </Page>
    );
  }

  const all = data.conversations;
  const filtered = all.filter((c) => {
    if (sp.status && c.status !== sp.status) return false;
    if (sp.bought === '1' && !c.bought) return false;
    if (sp.bought === '0' && c.bought) return false;
    return true;
  });

  const buyers = all.filter((c) => c.bought);
  const unused = buyers.reduce((s, c) => s + c.paid_left, 0);
  const answered = all.reduce((s, c) => s + c.questions, 0);
  const repaired = all.reduce((s, c) => s + c.guard_repaired + c.guard_fallback, 0);
  const counts = Object.fromEntries(
    ORDER.map((s) => [s, all.filter((c) => c.status === s).length]),
  ) as Record<ConvStatus, number>;

  const chip = (label: string, href: string, on: boolean) => (
    <Link
      key={href}
      href={href}
      className={`rounded-lg px-2.5 py-1 text-[11.5px] transition ${
        on ? 'bg-gold/15 text-gold' : 'bg-panel/60 text-muted hover:bg-hover'
      }`}
    >
      {label}
    </Link>
  );

  const q = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    Object.entries(o).forEach(([k, v]) => v && p.set(k, v));
    const s = p.toString();
    return `/conversations${s ? `?${s}` : ''}`;
  };

  const cols: Col<Conversation>[] = [
    {
      key: 'who', head: 'Customer', align: 'l',
      render: (c) => (
        <Link href={`/conversations/${c.phone}`} className="hover:text-gold">
          <span className="block font-medium">{c.name || 'unnamed'}</span>
          <span className="block text-[11px] text-muted">
            {c.phone}{c.language ? ` · ${c.language}` : ''}
          </span>
        </Link>
      ),
    },
    {
      key: 'status', head: 'Status', align: 'l',
      render: (c) => (
        <span className={`rounded px-1.5 py-0.5 text-[10.5px] ${STATUS_TONE[c.status]}`}>
          {STATUS_LABEL[c.status]}
        </span>
      ),
    },
    {
      key: 'bought', head: 'Bought', align: 'l',
      render: (c) => c.bought
        ? <span className="text-[11.5px]">{c.orders.slice(0, 2).join(', ')}
            {c.orders.length > 2 ? ` +${c.orders.length - 2}` : ''}</span>
        : <span className="text-muted">—</span>,
    },
    {
      key: 'quota', head: 'Questions', align: 'r',
      render: (c) => c.paid_total
        ? <span>{c.paid_used}<span className="text-muted">/{c.paid_total}</span></span>
        : <span className="text-muted">—</span>,
    },
    { key: 'asked', head: 'Asked', align: 'r', render: (c) => num(c.questions) },
    {
      key: 'guard', head: 'Guard', align: 'r',
      render: (c) => c.questions
        ? <span className={c.guard_repaired + c.guard_fallback ? 'text-warn' : 'text-good'}>
            {c.guard_clean}c{c.guard_repaired ? ` ${c.guard_repaired}r` : ''}
            {c.guard_fallback ? ` ${c.guard_fallback}f` : ''}
          </span>
        : <span className="text-muted">—</span>,
    },
    { key: 'msgs', head: 'Msgs', align: 'r', render: (c) => num(c.msgs_in + c.msgs_out) },
    {
      key: 'pdf', head: 'Report', align: 'l',
      render: (c) => c.report_sent_at
        ? <span className="text-good">sent</span>
        : <span className="text-muted">—</span>,
    },
    {
      key: 'last', head: 'Last reply', align: 'r',
      render: (c) => <span title={ist(c.last_inbound)}>{ago(c.last_inbound)}</span>,
    },
  ];

  const sorted = [...filtered].sort(
    (a, b) => (b.last_inbound ?? 0) - (a.last_inbound ?? 0),
  );

  return (
    <Page
      title="WhatsApp Conversations"
      subtitle={`${all.length} customers · astro bot · live from the box`}
    >
      <Grid cols={4}>
        <Stat label="Conversations" value={num(all.length)} sub={`${counts.active} active now`} />
        <Stat label="Bought a pack" value={num(buyers.length)}
              sub={`${num(all.length - buyers.length)} never paid`} />
        <Stat label="Paid, unused" value={num(unused)}
              sub="questions already paid for and not asked" />
        <Stat label="Questions answered" value={num(answered)}
              sub={repaired ? `${repaired} needed the guard` : 'all clean'} />
      </Grid>

      <Card title="Filter">
        <div className="flex flex-wrap gap-1.5">
          {chip('All', q({ bought: sp.bought }), !sp.status)}
          {ORDER.map((s) =>
            chip(`${STATUS_LABEL[s]} (${counts[s]})`, q({ status: s, bought: sp.bought }),
                 sp.status === s))}
          <span className="mx-1 w-px bg-edge" />
          {chip('Buyers', q({ status: sp.status, bought: '1' }), sp.bought === '1')}
          {chip('Never paid', q({ status: sp.status, bought: '0' }), sp.bought === '0')}
        </div>
      </Card>

      <Card title={`Conversations (${sorted.length})`}
            note="Click a customer to read the full transcript.">
        <Table cols={cols} rows={sorted} empty="No conversation matches this filter." />
      </Card>

      <Note>
        <b>Paid, unused</b> is the actionable one: those customers paid and still have questions
        sitting there, so a nudge costs nothing and they have already bought. <b>Used up</b> are
        the upsell list. Free-test grants from the paywall-off period are excluded from every
        paid figure, so “Questions” only ever counts what someone actually bought.
      </Note>
    </Page>
  );
}
