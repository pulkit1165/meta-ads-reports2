import { NextResponse } from 'next/server';
import { authenticate, signSession, SESSION_COOKIE, SESSION_HOURS } from '@/lib/auth';

// scrypt and pg both need Node; this route must never run on the Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let username = '';
  let password = '';
  try {
    const form = await req.formData();
    username = String(form.get('username') ?? '').trim();
    password = String(form.get('password') ?? '');
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }

  const next = new URL(req.url).searchParams.get('next') || '/';
  const fail = (msg: string) =>
    NextResponse.redirect(
      new URL(`/login?e=${encodeURIComponent(msg)}&next=${encodeURIComponent(next)}`, req.url),
      { status: 303 },
    );

  if (!username || !password) return fail('Enter a username and password.');

  let user;
  try {
    user = await authenticate(username, password);
  } catch (e) {
    // A database outage must not read as "wrong password" — the operator would
    // change their password chasing a problem that is not theirs.
    console.error('login: auth backend failed', e);
    return fail('Sign-in is unavailable right now. The database did not respond.');
  }
  if (!user) return fail('That username and password do not match.');

  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  const token = await signSession({ u: user.username, r: user.role, m: user.modules, exp });

  const res = NextResponse.redirect(new URL(next, req.url), { status: 303 });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_HOURS * 3600,
  });
  return res;
}
