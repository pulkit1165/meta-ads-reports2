export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const err = one(sp.e);
  const next = one(sp.next) || '/';

  return (
    <div className="grid min-h-screen place-items-center px-5">
      <form
        method="POST"
        action={`/api/login?next=${encodeURIComponent(next)}`}
        className="w-full max-w-[340px] rounded-xl border border-edge bg-panel/50 p-6"
      >
        <div className="mb-5">
          <div className="font-display text-xl leading-tight text-gold">NTN</div>
          <div className="text-[10.5px] uppercase tracking-[0.18em] text-muted">Command</div>
        </div>

        {err && (
          <p className="mb-4 rounded-lg border border-bad/40 bg-bad/[0.08] px-3 py-2 text-[12px] text-bad">
            {err}
          </p>
        )}

        <label className="mb-3 block">
          <span className="mb-1 block text-[10.5px] uppercase tracking-wider text-muted">Username</span>
          <input
            name="username" autoComplete="username" autoFocus required
            className="w-full rounded-lg border border-edge bg-transparent px-3 py-2 text-[13px] text-text outline-none focus:border-gold/60"
          />
        </label>

        <label className="mb-5 block">
          <span className="mb-1 block text-[10.5px] uppercase tracking-wider text-muted">Password</span>
          <input
            name="password" type="password" autoComplete="current-password" required
            className="w-full rounded-lg border border-edge bg-transparent px-3 py-2 text-[13px] text-text outline-none focus:border-gold/60"
          />
        </label>

        <button
          type="submit"
          className="w-full rounded-lg bg-gold/15 px-3 py-2 text-[13px] font-medium text-gold transition hover:bg-gold/25"
        >
          Sign in
        </button>

        <p className="mt-4 text-[11px] leading-relaxed text-muted">
          Sessions last 12 hours. Access is per module — you will only see what your
          account has been given.
        </p>
      </form>
    </div>
  );
}
