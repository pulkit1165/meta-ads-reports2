export default function Stat({
  label, value, sub, tone = 'plain',
}: { label: string; value: string; sub?: string; tone?: 'plain' | 'gold' | 'good' }) {
  const colour = tone === 'gold' ? 'text-gold' : tone === 'good' ? 'text-good' : 'text-[#e6ebf1]';
  return (
    <div className="rounded-xl border border-edge bg-panel px-4 py-3">
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className={`mt-1 font-display text-2xl ${colour}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
