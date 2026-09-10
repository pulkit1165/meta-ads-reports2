import type { Metadata } from 'next';
import Nav from '@/components/Nav';
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-screen bg-ink text-text antialiased">
        <div className="flex min-h-screen">
          <Nav />
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
