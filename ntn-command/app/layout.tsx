import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Nav from '@/components/Nav';
import { verifySession } from '@/lib/session-edge';
import { SESSION_COOKIE } from '@/lib/auth-constants';
import './globals.css';

export const metadata: Metadata = {
  title: 'NTN Command',
  description: 'Ads, catalogue, commerce and customers for Studd Muffyn, SM Life and Nuskhe By Paras',
};

/**
 * Applied before first paint so the page never flashes the wrong palette.
 * Kept tiny and dependency-free: it runs before React, and a throw here would
 * leave the document unstyled, hence the try/catch around storage access
 * (private windows throw on read).
 */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('ntn-theme');
if(t!=='light'&&t!=='cream'&&t!=='dark')t='dark';
document.documentElement.setAttribute('data-theme',t);}catch(e){
document.documentElement.setAttribute('data-theme','dark');}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value, process.env.AUTH_SECRET ?? '');
  const allowed = session ? (session.r === 'admin' ? ['*'] : session.m) : undefined;
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-screen bg-ink text-text antialiased">
        <div className="flex min-h-screen">
          <Nav allowed={allowed} />
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
