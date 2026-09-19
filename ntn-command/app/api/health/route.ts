import { NextResponse } from 'next/server';
import { Client } from 'pg';
import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Where a slow page is actually spending its time.
 *
 * A page that takes 25s on Vercel and 4s from a laptop is not a slow query —
 * it is the path to the database. This separates the three costs that get
 * confused with each other: opening a fresh TCP connection and authenticating,
 * one round trip on an already-open connection, and a real query's work.
 */
const ms = async (fn: () => Promise<unknown>) => {
  const t = Date.now();
  try { await fn(); return Date.now() - t; } catch (e) {
    return `failed after ${Date.now() - t}ms: ${(e as Error).message}`;
  }
};

export async function GET(req: Request) {
  const out: Record<string, unknown> = {
    region: process.env.VERCEL_REGION ?? 'local',
    host: process.env.PGHOST,
  };

  // a connection nobody has opened yet: TCP + auth, no pool in the way
  const fresh = new Client({
    host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER, password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE, ssl: false,
    connectionTimeoutMillis: 20_000,
  });
  out.connect = await ms(() => fresh.connect());
  out.firstRoundTrip = await ms(() => fresh.query('SELECT 1'));
  const trips: (number | string)[] = [];
  for (let i = 0; i < 3; i++) trips.push(await ms(() => fresh.query('SELECT 1')));
  out.roundTrips = trips;
  out.smallQuery = await ms(() => fresh.query(
    `SELECT COUNT(*) FROM meta_campaign_snapshot
      WHERE snapshot_at > NOW() - INTERVAL '1 hour'`));
  out.ordersQuery = await ms(() => fresh.query(
    `SELECT store, COUNT(*) FROM shopify_orders
      WHERE store = ANY($1) AND created_at >= $2 GROUP BY 1`,
    [['SM', 'NBP', 'SML'], new Date(Date.now() - 864e5).toISOString().slice(0, 10)]));
  await fresh.end().catch(() => {});

  // and the pool the app actually uses, warm or cold as it finds it
  out.pool = await ms(() => pool.query('SELECT 1'));
  out.poolAgain = await ms(() => pool.query('SELECT 1'));
  out.poolParallel = await ms(() => Promise.all(
    [1, 2, 3, 4, 5, 6].map(() => pool.query('SELECT pg_sleep(0)'))));

  // ?full=1 — how long each library call the pages make actually takes here,
  // which is the only way to tell a slow query from a slow path to the box.
  if (new URL(req.url).searchParams.get('full')) {
    const { todayRead } = await import('@/lib/today');
    const { ydayFinal } = await import('@/lib/yday');
    const { campDays, productMap } = await import('@/lib/ads');
    const { dailyClosing } = await import('@/lib/closingdaily');
    const { closingDrill } = await import('@/lib/closingdrill');
    const { adDays } = await import('@/lib/brief');
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const yday = new Date(Date.now() + 5.5 * 3600e3 - 864e5).toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() + 5.5 * 3600e3 - 7 * 864e5).toISOString().slice(0, 10);
    out.todayRead = await ms(() => todayRead());
    out.ydayFinal = await ms(() => ydayFinal(yday));
    out.productMap = await ms(() => productMap());
    out.campDays = await ms(() => campDays(weekAgo, today));
    out.dailyClosing = await ms(() => dailyClosing(weekAgo, today));
    out.closingDrill = await ms(() => closingDrill(weekAgo, today));
    out.adDays = await ms(() => adDays(yday, yday));
  }

  return NextResponse.json(out);
}
