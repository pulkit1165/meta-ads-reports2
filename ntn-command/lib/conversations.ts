/**
 * WhatsApp conversations from the astro bot.
 *
 * The bot keeps its data in SQLite on the EC2 box, not in the Postgres this app reads for
 * everything else. Rather than mirror the file or widen the database's exposure, the box
 * serves one token-gated read-only endpoint over the vhost that already terminates TLS, and
 * this module is the only thing that talks to it.
 */
export type ConvStatus = 'onboarding' | 'active' | 'waiting' | 'spent' | 'dormant';

export interface Conversation {
  phone: string;
  name: string | null;
  language: string | null;
  state: string | null;
  status: ConvStatus;
  bought: number;
  orders: string[];
  skus: string[];
  quota_total: number; quota_used: number; quota_left: number;
  paid_total: number; paid_used: number; paid_left: number;
  free_grants: number;
  questions: number;
  guard_clean: number; guard_repaired: number; guard_fallback: number;
  msgs_in: number; msgs_out: number;
  first_seen: number | null; last_inbound: number | null; last_question: number | null;
  report_sent_at: number | null;
  dob: string | null; birth_time: string | null; place: string | null;
}

export interface Transcript {
  phone: string;
  user: Record<string, unknown> | null;
  messages: { direction: 'in' | 'out'; body: string; ts: number }[];
  questions: { question: string; answer: string; topic: string; guard_status: string; asked_at: number }[];
  entitlements: { order_name: string; sku: string; source: string; questions_total: number; questions_used: number; created_at: number }[];
}

const BASE = process.env.ASTRO_ADMIN_URL || 'https://astro.jaddibooty.in';
const TOKEN = process.env.ASTRO_ADMIN_TOKEN || '';

export class BotUnreachable extends Error {}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  if (!TOKEN) throw new BotUnreachable('ASTRO_ADMIN_TOKEN is not set');
  const qs = new URLSearchParams({ ...params, token: TOKEN });
  const r = await fetch(`${BASE}${path}?${qs}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => {
    throw new BotUnreachable(String(e?.message || e));
  });
  if (!r.ok) throw new BotUnreachable(`bot returned ${r.status}`);
  return r.json() as Promise<T>;
}

export const listConversations = () =>
  get<{ generated_at: number; count: number; conversations: Conversation[] }>('/admin/conversations');

export const getTranscript = (phone: string) =>
  get<Transcript>('/admin/conversation', { phone });

/** IST, because every other module in this app reads in IST. */
export function ist(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function ago(ts: number | null): string {
  if (!ts) return '—';
  const h = (Date.now() / 1000 - ts) / 3600;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export const STATUS_LABEL: Record<ConvStatus, string> = {
  onboarding: 'Onboarding',
  active: 'Active',
  waiting: 'Paid, unused',
  spent: 'Used up',
  dormant: 'Dormant',
};

export const STATUS_TONE: Record<ConvStatus, string> = {
  onboarding: 'bg-edge/40 text-muted',
  active: 'bg-good/15 text-good',
  waiting: 'bg-warn/15 text-warn',
  spent: 'bg-gold/15 text-gold',
  dormant: 'bg-edge/30 text-muted',
};
