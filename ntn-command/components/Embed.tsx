'use client';
import { useState } from 'react';

// The ROAS, Antariksh and RFM dashboards are live, working deployments. They
// are mounted here rather than rewritten — a port would be weeks of work and
// pure regression risk for no new capability.
export default function Embed({
  title, src, note,
}: { title: string; src: string; note?: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-edge px-5 py-3">
        <div>
          <h1 className="font-display text-lg">{title}</h1>
          {note && <p className="text-[11px] text-muted">{note}</p>}
        </div>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-edge px-3 py-1.5 text-[12px] text-muted hover:text-gold"
        >
          Open full ↗
        </a>
      </header>
      <div className="relative flex-1">
        {!loaded && (
          <div className="absolute inset-0 grid place-items-center text-[12px] text-muted">
            Loading {title}…
          </div>
        )}
        <iframe
          src={src}
          title={title}
          onLoad={() => setLoaded(true)}
          className="h-full w-full border-0 bg-white"
        />
      </div>
    </div>
  );
}
