import { q, n } from './db';

/**
 * Authentication and per-module access.
 *
 * Two halves that must not be confused:
 *
 *  - This file runs in the Node runtime (route handlers, server components).
 *    It talks to Postgres and does scrypt hashing, neither of which exists on
 *    the Edge.
 *  - middleware.ts runs on the Edge and only VERIFIES an already-signed cookie
 *    using Web Crypto. It never touches the database, because it cannot.
 *
 * The session cookie is a signed claim, not an identifier: it carries the
 * username, role and allowed module list, so the Edge can authorise a request
 * without a round trip. That means a permission change does not take effect
 * until the session is re-issued, which is why sessions are short.
 */
export { SESSION_COOKIE, SESSION_HOURS } from './auth-constants';
import { SESSION_HOURS as _H } from './auth-constants';
void _H;

export interface Session {
  u: string;          // username
  r: 'admin' | 'viewer';
  m: string[];        // module slugs, or ['*']
  exp: number;        // unix seconds
}

export interface DashUser {
  username: string;
  displayName: string | null;
  role: 'admin' | 'viewer';
  modules: string[];
  active: boolean;
  createdAt: string;
  lastLogin: string | null;
}

function secret(): string {
  // Falling back to a constant would mean every deployment shares a signing
  // key, so an absent secret is a hard failure rather than a silent weakness.
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error('AUTH_SECRET missing or too short — refusing to sign sessions');
  }
  return s;
}

/* ── password hashing (Node only) ───────────────────────────────────────── */

export async function hashPassword(password: string, saltHex?: string) {
  const { randomBytes, scrypt } = await import('node:crypto');
  const salt = saltHex ?? randomBytes(16).toString('hex');
  const hash: string = await new Promise((res, rej) =>
    scrypt(password, salt, 64, (e, key) => (e ? rej(e) : res(key.toString('hex')))),
  );
  return { salt, hash };
}

export async function verifyPassword(password: string, salt: string, expected: string) {
  const { timingSafeEqual } = await import('node:crypto');
  const { hash } = await hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and the length itself is not a secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ── session signing ────────────────────────────────────────────────────── */

const b64url = (b: Uint8Array) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function signSession(s: Session): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const body = b64url(new TextEncoder().encode(JSON.stringify(s)));
  const sig = createHmac('sha256', secret()).update(body).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${body}.${sig}`;
}

/* ── users ──────────────────────────────────────────────────────────────── */

const toUser = (r: Record<string, unknown>): DashUser => ({
  username: String(r.username),
  displayName: r.display_name ? String(r.display_name) : null,
  role: String(r.role) === 'admin' ? 'admin' : 'viewer',
  modules: (r.modules as string[]) ?? [],
  active: Boolean(r.active),
  createdAt: String(r.created_at),
  lastLogin: r.last_login ? String(r.last_login) : null,
});

export async function listUsers(): Promise<DashUser[]> {
  const rows = await q(
    `SELECT username, display_name, role, modules, active,
            created_at::text, last_login::text
       FROM dash_user ORDER BY role, username`,
  );
  return rows.map(toUser);
}

export async function authenticate(username: string, password: string): Promise<DashUser | null> {
  const rows = await q(
    `SELECT username, display_name, role, modules, active, pw_salt, pw_hash,
            created_at::text, last_login::text
       FROM dash_user WHERE lower(username) = lower($1) AND active`,
    [username],
  );
  const r = rows[0];
  if (!r) return null;
  const ok = await verifyPassword(password, String(r.pw_salt), String(r.pw_hash));
  if (!ok) return null;
  await q(`UPDATE dash_user SET last_login = now() WHERE username = $1`, [String(r.username)]);
  return toUser(r);
}

export async function upsertUser(opts: {
  username: string;
  displayName?: string;
  password?: string;
  role: 'admin' | 'viewer';
  modules: string[];
  active: boolean;
}): Promise<void> {
  const { username, displayName, password, role, modules, active } = opts;
  if (password) {
    const { salt, hash } = await hashPassword(password);
    await q(
      `INSERT INTO dash_user (username, display_name, pw_salt, pw_hash, role, modules, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (username) DO UPDATE SET
         display_name = EXCLUDED.display_name, pw_salt = EXCLUDED.pw_salt,
         pw_hash = EXCLUDED.pw_hash, role = EXCLUDED.role,
         modules = EXCLUDED.modules, active = EXCLUDED.active`,
      [username, displayName ?? null, salt, hash, role, modules, active],
    );
  } else {
    // No password given means "edit the other fields" — never blank the hash.
    await q(
      `UPDATE dash_user SET display_name = $2, role = $3, modules = $4, active = $5
        WHERE username = $1`,
      [username, displayName ?? null, role, modules, active],
    );
  }
}

export async function deleteUser(username: string): Promise<void> {
  await q(`DELETE FROM dash_user WHERE username = $1`, [username]);
}

export async function countAdmins(excluding?: string): Promise<number> {
  const rows = await q<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM dash_user
      WHERE role = 'admin' AND active AND ($1::text IS NULL OR username <> $1)`,
    [excluding ?? null],
  );
  return n(rows[0]?.c);
}

/** Does this session allow that module slug? */
export const canSee = (s: Session | null, slug: string) =>
  !!s && (s.r === 'admin' || s.m.includes('*') || s.m.includes(slug));
