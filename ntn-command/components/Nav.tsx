'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/',       label: 'Orders',    hint: 'live, all stores' },
  { href: '/roas',   label: 'ROAS',      hint: 'ad spend & return' },
  { href: '/profit', label: 'Profit',    hint: 'Antariksh' },
  { href: '/rfm',    label: 'Retention', hint: 'RFM cohorts' },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="w-[188px] shrink-0 border-r border-edge bg-panel/60 p-4 hidden sm:block">
      <div className="mb-6 px-1">
        <div className="font-display text-lg leading-tight text-gold">NTN</div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted">Command</div>
      </div>
      <ul className="space-y-1">
        {LINKS.map((l) => {
          const on = path === l.href;
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                className={`block rounded-lg px-3 py-2 transition ${
                  on ? 'bg-gold/15 text-gold' : 'text-[#c3ccd7] hover:bg-white/5'
                }`}
              >
                <div className="text-[13px] font-medium">{l.label}</div>
                <div className="text-[10.5px] text-muted">{l.hint}</div>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
