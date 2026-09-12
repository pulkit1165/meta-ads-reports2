import { NextResponse, type NextRequest } from 'next/server';
import { verifySession, allows } from '@/lib/session-edge';
import { SESSION_COOKIE } from '@/lib/auth-constants';

/**
 * Gate every page on a signed session, and every module on that session's
 * permissions.
 *
 * This runs on the Edge, so it can verify a signature but cannot read the
 * database — the session cookie carries the allowed module list with it. The
 * trade is that a permission change only takes effect when the session is
 * re-issued, which is why sessions last 12 hours rather than weeks.
 *
 * It replaces a single shared HTTP Basic credential that was hardcoded in this
 * file, and therefore in git history.
 */
export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
};

/** Paths reachable without a session. */
const PUBLIC = new Set(['/login', '/api/login', '/api/logout']);

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.has(pathname)) return NextResponse.next();

  const secret = process.env.AUTH_SECRET ?? '';
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret);

  if (!session) {
    const url = new URL('/login', req.url);
    url.searchParams.set('next', pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  // The first path segment is the module slug; '/' is the console, which every
  // signed-in user may see (it only shows tiles they can open).
  const slug = pathname.split('/').filter(Boolean)[0] ?? '';
  if (!slug || slug === 'api') return NextResponse.next();

  if (!allows(session, slug)) {
    const url = new URL('/', req.url);
    url.searchParams.set('denied', slug);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
