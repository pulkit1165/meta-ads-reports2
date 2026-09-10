'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MODULES, SECTIONS } from '@/lib/modules';

const DOT: Record<string, string> = {
  live: 'bg-good',
  partial: 'bg-warn',
  planned: 'bg-edge',
};

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="hidden w-[212px] shrink-0 overflow-y-auto border-r border-edge bg-panel/40 p-4 sm:block">
      <Link href="/" className="mb-6 block px-1">
        <div className="font-display text-lg leading-tight text-gold">NTN</div>
        <div className="text-[10.5px] uppercase tracking-[0.18em] text-muted">Command</div>
      </Link>

      {SECTIONS.map((sec) => {
        const mods = MODULES.filter((m) => m.section === sec.key);
        if (!mods.length) return null;
        return (
          <div key={sec.key} className="mb-5">
            <div className="mb-1.5 px-3 text-[9.5px] uppercase tracking-[0.16em] text-muted/70">
              {sec.label}
            </div>
            <ul className="space-y-0.5">
              {mods.map((m) => {
                const href = `/${m.slug}`;
                const on = path === href;
                return (
                  <li key={m.slug}>
                    <Link
                      href={href}
                      className={`flex items-center gap-2 rounded-lg px-3 py-1.5 transition ${
                        on ? 'bg-gold/15 text-gold' : 'text-text hover:bg-hover'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[m.status]}`} />
                      <span className="min-w-0">
                        <span className="block truncate text-[12.5px] font-medium">{m.label}</span>
                        <span className="block truncate text-[10px] text-muted">{m.hint}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      <div className="mt-6 border-t border-edge px-3 pt-3 text-[10px] leading-relaxed text-muted/70">
        <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-good align-middle" /> live
        <span className="ml-2 mr-1 inline-block h-1.5 w-1.5 rounded-full bg-warn align-middle" /> partial
        <span className="ml-2 mr-1 inline-block h-1.5 w-1.5 rounded-full bg-edge align-middle" /> planned
      </div>
    </nav>
  );
}
