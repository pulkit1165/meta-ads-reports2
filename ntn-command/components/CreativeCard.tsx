import { type CreativeRow, roas, isRunning, watchUrl } from '@/lib/creative';
import { Roas, rs, pct } from './ui';

/**
 * One creative: thumbnail, where it stands now, and how it did over three
 * windows at once.
 *
 * The thumbnail links to the post so it can actually be watched. Where Meta
 * gives us no story or video id there is nothing to link to, so the tile stays
 * a plain image rather than a dead link that looks clickable.
 */
export default function CreativeCard({ c, day }: { c: CreativeRow; day: string }) {
  const href = watchUrl(c);
  const running = isRunning(c.status);
  const win = [
    { label: day.slice(5), v: c.d1 },
    { label: '3d', v: c.d3 },
    { label: '7d', v: c.d7 },
  ];

  const thumb = (
    <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-tint">
      {c.thumbnail ? (
        // Meta's CDN is not in next.config images, and these are signed URLs
        // that rotate — a plain img avoids the optimizer refusing the host.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={c.thumbnail}
          alt={c.adName}
          loading="lazy"
          className="h-full w-full object-cover transition group-hover:scale-[1.03]"
        />
      ) : (
        <div className="grid h-full place-items-center text-[10px] text-muted">no thumbnail</div>
      )}
      <span
        className={`absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider ${
          running ? 'bg-good/85 text-white' : 'bg-bad/80 text-white'
        }`}
      >
        {running ? 'running' : 'closed'}
      </span>
      {href && (
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[9.5px] text-white">
          ▶ watch
        </span>
      )}
    </div>
  );

  return (
    <div className="group rounded-xl border border-edge bg-panel/50 p-2.5">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" title="Open the post on Facebook">
          {thumb}
        </a>
      ) : (
        thumb
      )}

      <div className="mt-2 truncate text-[11.5px] text-text-strong" title={c.adName}>
        {c.adName}
      </div>
      <div className="truncate text-[10px] text-muted" title={`${c.product} · ${c.saleBlock}`}>
        {c.product} · {c.creativeType}
      </div>
      <div
        className="mt-1 flex items-baseline justify-between text-[10px]"
        title={
          c.sharedWith > 1
            ? `Campaign budget ${rs(c.budget)}, shared with ${c.sharedWith - 1} other creative${c.sharedWith > 2 ? 's' : ''}`
            : `Campaign budget ${rs(c.budget)}`
        }
      >
        <span className="text-muted">
          bud {c.budget > 0 ? rs(c.budget) : '–'}
          {c.sharedWith > 1 && <span className="ml-1 text-muted/70">/{c.sharedWith}</span>}
        </span>
        {c.budget > 0 && (
          <span className={c.d1.spend / c.budget >= 0.85 ? 'text-warn' : 'text-muted'}>
            {pct((c.d1.spend / c.budget) * 100)}
          </span>
        )}
      </div>

      <table className="mt-2 w-full text-[10.5px]">
        <tbody>
          {win.map((w) => (
            <tr key={w.label}>
              <td className="text-muted">{w.label}</td>
              <td className="text-right tabular-nums text-muted">{rs(w.v.spend)}</td>
              <td className="pl-1.5 text-right">
                {w.v.spend > 0
                  ? <Roas v={roas(w.v.revenue, w.v.spend)} />
                  : <span className="text-muted">–</span>}
              </td>
            </tr>
          ))}
          <tr className="border-t border-edge/60">
            <td className="pt-1 text-muted" title={`${c.life.days} days with spend`}>life</td>
            <td className="pt-1 text-right tabular-nums text-muted">{rs(c.life.spend)}</td>
            <td className="pt-1 pl-1.5 text-right">
              {c.life.spend > 0
                ? <Roas v={roas(c.life.revenue, c.life.spend)} />
                : <span className="text-muted">–</span>}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
