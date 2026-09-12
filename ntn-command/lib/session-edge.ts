/**
 * Session verification for the Edge runtime.
 *
 * middleware.ts cannot import lib/auth.ts: that file reaches for node:crypto
 * and the pg driver, neither of which exists on the Edge. This is the minimum
 * needed to check a signature there — Web Crypto only, no database.
 */
export interface EdgeSession {
  u: string;
  r: 'admin' | 'viewer';
  m: string[];
  exp: number;
}

const fromB64url = (s: string) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
};

export async function verifySession(token: string | undefined, secret: string)
  : Promise<EdgeSession | null> {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // Constant-time compare: a length-equal loop, so a wrong signature does not
  // reveal how many leading characters were right.
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;

  try {
    const s = JSON.parse(fromB64url(body)) as EdgeSession;
    if (!s?.u || typeof s.exp !== 'number' || s.exp * 1000 < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

export const allows = (s: EdgeSession | null, slug: string) =>
  !!s && (s.r === 'admin' || s.m.includes('*') || s.m.includes(slug));
