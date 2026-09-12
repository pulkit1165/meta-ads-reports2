import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import {
  listUsers, upsertUser, deleteUser, countAdmins, SESSION_COOKIE, type DashUser,
} from '@/lib/auth';
import { verifySession } from '@/lib/session-edge';
import { MODULES, SECTIONS } from '@/lib/modules';
import PageControls from '@/components/PageControls';
import { Page, Card, Grid, Stat, Table, Note, num, type Col } from '@/components/ui';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ── actions ────────────────────────────────────────────────────────────── */

async function currentSession() {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value, process.env.AUTH_SECRET ?? '');
}

async function requireAdmin() {
  const s = await currentSession();
  if (!s || s.r !== 'admin') throw new Error('Only an admin may change access.');
  return s;
}

async function saveUser(formData: FormData) {
  'use server';
  await requireAdmin();

  const username = String(formData.get('username') ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new Error('Username must be 3-32 characters: letters, digits, dot, dash or underscore.');
  }
  const password = String(formData.get('password') ?? '');
  const role = String(formData.get('role') ?? 'viewer') === 'admin' ? 'admin' : 'viewer';
  const active = formData.get('active') === 'on';
  const all = formData.get('allModules') === 'on';
  const modules = all ? ['*'] : formData.getAll('modules').map(String);

  const existing = (await listUsers()).find((u) => u.username === username);
  if (!existing && password.length < 8) {
    throw new Error('A new account needs a password of at least 8 characters.');
  }
  if (password && password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  // Never let the last admin lock everyone out — including by demoting or
  // deactivating themselves, which is the easy mistake to make here.
  if (existing?.role === 'admin' && (role !== 'admin' || !active)) {
    if ((await countAdmins(username)) === 0) {
      throw new Error('This is the only active admin. Promote someone else first.');
    }
  }

  await upsertUser({
    username,
    displayName: String(formData.get('displayName') ?? '').trim() || undefined,
    password: password || undefined,
    role, modules, active,
  });
  revalidatePath('/access');
}

async function removeUser(formData: FormData) {
  'use server';
  const me = await requireAdmin();
  const username = String(formData.get('username') ?? '');
  if (username === me.u) throw new Error('You cannot delete the account you are signed in with.');
  if ((await countAdmins(username)) === 0) {
    throw new Error('That is the only active admin. Promote someone else first.');
  }
  await deleteUser(username);
  revalidatePath('/access');
}

/* ── page ───────────────────────────────────────────────────────────────── */

export default async function AccessPage() {
  const session = await currentSession();
  const isAdmin = session?.r === 'admin';

  if (!isAdmin) {
    return (
      <Page title="Access" subtitle="Admins only" actions={<PageControls dates={false} />}>
        <Note kind="warn">
          You are signed in as <b className="text-warn">{session?.u ?? 'unknown'}</b>, which is a
          viewer account. Only an admin can see or change who has access.
        </Note>
      </Page>
    );
  }

  let users: DashUser[] = [];
  let loadError = '';
  try {
    users = await listUsers();
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  const admins = users.filter((u) => u.role === 'admin' && u.active).length;
  const inactive = users.filter((u) => !u.active).length;

  const cols: Col<DashUser>[] = [
    { key: 'u', head: 'Username', align: 'l', render: (u) => (
        <span className={u.active ? '' : 'text-muted line-through'}>{u.username}</span>
      ) },
    { key: 'n', head: 'Name', align: 'l', render: (u) => (
        <span className="text-muted">{u.displayName ?? '—'}</span>
      ) },
    { key: 'r', head: 'Role', align: 'l', render: (u) => (
        <span className={u.role === 'admin' ? 'text-gold' : 'text-muted'}>{u.role}</span>
      ) },
    { key: 'm', head: 'Modules', align: 'l', render: (u) => (
        u.modules.includes('*')
          ? <span className="text-good">all modules</span>
          : u.modules.length === 0
            ? <span className="text-bad">none</span>
            : <span className="block max-w-[360px] truncate" title={u.modules.join(', ')}>
                {u.modules.length} · {u.modules.join(', ')}
              </span>
      ) },
    { key: 'a', head: 'Active', align: 'l', render: (u) => (
        <span className={u.active ? 'text-good' : 'text-bad'}>{u.active ? 'yes' : 'no'}</span>
      ) },
    { key: 'l', head: 'Last sign-in', align: 'r', render: (u) => (
        <span className="text-muted">{u.lastLogin ? u.lastLogin.slice(0, 16).replace('T', ' ') : 'never'}</span>
      ) },
    { key: 'd', head: '', align: 'r', render: (u) => (
        <form action={removeUser}>
          <input type="hidden" name="username" value={u.username} />
          <button type="submit" className="text-[11px] text-bad hover:underline">delete</button>
        </form>
      ) },
  ];

  const field = 'w-full rounded-lg border border-edge bg-transparent px-3 py-2 text-[13px] text-text outline-none focus:border-gold/60';
  const lbl = 'mb-1 block text-[10.5px] uppercase tracking-wider text-muted';

  return (
    <Page
      title="Access"
      subtitle={`${users.length} accounts · signed in as ${session?.u}`}
      actions={<PageControls dates={false} />}
    >
      <Grid cols={4}>
        <Stat label="Accounts" value={num(users.length)} sub={`${admins} admin, ${users.length - admins} viewer`} />
        <Stat label="Active" value={num(users.length - inactive)} sub={inactive ? `${inactive} deactivated` : 'all enabled'} />
        <Stat label="Modules" value={num(MODULES.length)} sub="assignable individually" />
        <Stat label="Session length" value="12h" sub="a permission change applies at next sign-in" />
      </Grid>

      {loadError && <Note kind="warn">Could not read the user list: {loadError}</Note>}

      <Card title="Accounts">
        <Table cols={cols} rows={users} empty="No accounts yet — create the first one below." />
      </Card>

      <Card title="Add or update an account" note="an existing username updates that account; leave the password blank to keep it">
        <form action={saveUser} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label>
              <span className={lbl}>Username</span>
              <input name="username" required className={field} placeholder="e.g. navdeep" />
            </label>
            <label>
              <span className={lbl}>Display name</span>
              <input name="displayName" className={field} placeholder="optional" />
            </label>
            <label>
              <span className={lbl}>Password</span>
              <input name="password" type="password" className={field} placeholder="8+ chars" />
            </label>
            <label>
              <span className={lbl}>Role</span>
              <select name="role" defaultValue="viewer" className={field}>
                <option value="viewer" className="bg-panel">viewer</option>
                <option value="admin" className="bg-panel">admin — can manage access</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-5">
            <label className="flex items-center gap-2 text-[12px] text-text">
              <input type="checkbox" name="active" defaultChecked className="accent-[var(--gold)]" />
              Active
            </label>
            <label className="flex items-center gap-2 text-[12px] text-text">
              <input type="checkbox" name="allModules" className="accent-[var(--gold)]" />
              Give every module (including ones added later)
            </label>
          </div>

          <div className="rounded-lg border border-edge p-3">
            <div className={lbl}>Modules this account may open</div>
            <div className="space-y-3">
              {SECTIONS.map((sec) => {
                const mods = MODULES.filter((m) => m.section === sec.key);
                if (!mods.length) return null;
                return (
                  <div key={sec.key}>
                    <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted/70">
                      {sec.label}
                    </div>
                    <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                      {mods.map((m) => (
                        <label key={m.slug} className="flex items-center gap-1.5 text-[12px] text-text">
                          <input type="checkbox" name="modules" value={m.slug} className="accent-[var(--gold)]" />
                          {m.label}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted/70">Admin</div>
                <label className="flex items-center gap-1.5 text-[12px] text-text">
                  <input type="checkbox" name="modules" value="access" className="accent-[var(--gold)]" />
                  Access (manage accounts)
                </label>
              </div>
            </div>
          </div>

          <button
            type="submit"
            className="rounded-lg bg-gold/15 px-4 py-2 text-[13px] font-medium text-gold transition hover:bg-gold/25"
          >
            Save account
          </button>
        </form>
      </Card>

      <Note>
        Passwords are stored as a scrypt hash over a per-user random salt — never in plain text, so
        a leaked table cannot be reversed and two people with the same password still differ.
        Signing in issues a cookie carrying the username, role and module list, signed with{' '}
        <span className="text-text">AUTH_SECRET</span>; the gate runs at the edge and never queries
        the database, which is what keeps it fast.
        {' '}<b className="text-text-strong">A permission change takes effect at the user&apos;s next
        sign-in</b>, within 12 hours, because the current cookie already carries the old list. To
        revoke immediately, untick Active — an inactive account cannot obtain a new session, and
        you can also tell the person to sign out.
        {' '}The last active admin cannot be demoted, deactivated or deleted.
      </Note>
    </Page>
  );
}
