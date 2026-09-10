import { Pool, type QueryResultRow } from 'pg';

/**
 * One pool per server process, reused across requests.
 *
 * Next dev reloads modules on every edit, so the pool is parked on globalThis;
 * without that each save leaks a pool and the box runs out of connections
 * within an afternoon. In production the module is evaluated once and the
 * global is simply where it lives.
 *
 * Reads PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE — the names the pg
 * driver already defaults to, so .env.local and the Vercel project settings use
 * one vocabulary.
 */
const globalForPg = globalThis as unknown as { ntnPool?: Pool };

export const pool =
  globalForPg.ntnPool ??
  new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    // Serverless invocations are short and numerous; a small ceiling keeps the
    // shared box (Prithvi's pipelines use it too) from being starved.
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 12_000,
    // The box's Postgres is built without TLS support, so this connection is
    // plaintext over the public internet. That is a real exposure, not a
    // preference: the password crosses the wire on every connect and 5432 on
    // 3.108.101.235 currently answers to any host. Documented rather than
    // hidden — see SECURITY.md for the two ways out (a token-gated read API on
    // the box's existing HTTPS vhost, or a TLS-terminating managed mirror).
    ssl: false,
  });

if (!globalForPg.ntnPool) globalForPg.ntnPool = pool;

export async function q<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

/** Single row, or null when the query matched nothing. */
export async function q1<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/**
 * The reporting day is IST everywhere in this business, while the database
 * session is UTC. Every date filter must go through these rather than
 * CURRENT_DATE — mixing the two is what made overnight campaigns invisible for
 * five and a half hours and carried yesterday's spend into midnight snapshots.
 */
export const IST_TODAY = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;
export const IST_NOW = `(NOW() AT TIME ZONE 'Asia/Kolkata')`;

/** Number coercion for pg's numeric-as-string. */
export function n(v: unknown): number {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(x) ? x : 0;
}
