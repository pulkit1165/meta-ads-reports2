import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { verifySession } from '@/lib/session-edge';
import { SESSION_COOKIE } from '@/lib/auth-constants';
import { profitFor, saveProfit } from '@/lib/plan';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const who = async () => {
  const jar = await cookies();
  const s = await verifySession(jar.get(SESSION_COOKIE)?.value, process.env.AUTH_SECRET ?? '');
  return s?.u ?? null;
};

export async function GET(req: Request) {
  const date = new URL(req.url).searchParams.get('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date=YYYY-MM-DD required' }, { status: 400 });
  }
  return NextResponse.json({ entries: await profitFor(date) });
}

export async function POST(req: Request) {
  const user = await who();
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await req.json().catch(() => null) as
    | { date?: string; portal?: string; profit?: unknown; note?: unknown } | null;
  const date = String(body?.date ?? '');
  const portal = String(body?.portal ?? 'ALL').toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date=YYYY-MM-DD required' }, { status: 400 });
  }
  if (!['ALL', 'SM', 'NBP', 'SML'].includes(portal)) {
    return NextResponse.json({ error: 'unknown portal' }, { status: 400 });
  }

  // An empty box means "no figure yet", which is not the same as zero profit —
  // a zero would read as a day that broke exactly even.
  const raw = body?.profit;
  const blank = raw === '' || raw === null || raw === undefined;
  const profit = blank ? null : Number(String(raw).replace(/[^0-9.-]/g, ''));
  if (profit !== null && !Number.isFinite(profit)) {
    return NextResponse.json({ error: 'profit must be a number' }, { status: 400 });
  }

  await saveProfit(date, portal, profit, String(body?.note ?? '').slice(0, 300), user);
  return NextResponse.json({ ok: true, entries: await profitFor(date) });
}
