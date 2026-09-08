// HTTP Basic Auth gate, matching the Antariksh dashboard so the team has one
// set of credentials across every NTN dashboard.
// Shared login: ntnteam / Muffyn2026 (override via DASH_USER / DASH_PASSWORD).
import { NextResponse, type NextRequest } from 'next/server';

export const config = { matcher: '/((?!_next/static|_next/image|favicon.ico).*)' };

export function middleware(request: NextRequest) {
  const USER = process.env.DASH_USER || 'ntnteam';
  const PASS = process.env.DASH_PASSWORD || 'Muffyn2026';
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6));
      const i = decoded.indexOf(':');
      if (decoded.slice(0, i) === USER && decoded.slice(i + 1) === PASS) {
        return NextResponse.next();
      }
    } catch {
      /* fall through to 401 */
    }
  }
  return new Response('NTN Command — password required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="NTN Command", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
