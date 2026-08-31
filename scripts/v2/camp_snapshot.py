#!/usr/bin/env python3
"""
camp_snapshot.py — hourly snapshot collector for live campaign performance.

Fetches every ACTIVE Meta campaign (all accounts) and writes one row per
campaign per hour into `campaign_hourly_snapshots`. Idempotent: re-running
inside the same hour upserts (PRIMARY KEY = hour_slot+campaign_id).

All per-campaign metrics are Meta PIXEL-attributed (see camp_live.py).

Usage:
  META_ACCESS_TOKEN=... python3 scripts/v2/camp_snapshot.py --db state/camp_snapshots.db
  ...                      python3 scripts/v2/camp_snapshot.py --db ... --accounts act_x act_y   # subset
"""
import argparse
import os
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path

import re

from camp_live import ACCOUNT_ERRORS, fetch_active_campaigns

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def configured_accounts():
    """Ad account ids from config/accounts.env.

    Preferred over me/adaccounts discovery for two reasons. First, discovery is
    broken for this business: Meta returns HTTP 500 paginating the account list
    (75 accounts), and the first page alone silently truncates it. Second,
    discovery only ever listed accounts the token had a role on — which is how
    NBP Skin, ~Rs1L/day of spend, stayed invisible for weeks.

    The configured list is the same one check_account_access.py audits, so a
    blocked account is a loud failure rather than a silent omission.
    """
    out = []
    for name in ('config/accounts.env', '.env'):
        p = REPO_ROOT / name
        if not p.exists():
            continue
        for line in p.read_text(errors='ignore').splitlines():
            m = re.match(r'^\s*[A-Z][A-Z0-9_]*\s*=\s*(act_\d+)\s*$', line.strip())
            if m and m.group(1) not in out:
                out.append(m.group(1))
    return out

IST = timezone(timedelta(hours=5, minutes=30))

SCHEMA = """
CREATE TABLE IF NOT EXISTS campaign_hourly_snapshots (
  ts            TEXT,            -- exact run time, ISO IST
  hour_slot     TEXT,            -- 'YYYY-MM-DD HH:00' IST (dedup bucket)
  account_id    TEXT,
  account_name  TEXT,
  campaign_id   TEXT,
  campaign_name TEXT,
  objective     TEXT,
  status        TEXT,            -- Active / Paused (delivered today)
  created_time  TEXT,
  age_hours     REAL,
  daily_budget  REAL,
  spend         REAL,
  revenue       REAL,
  roas          REAL,
  orders        INTEGER,
  impressions   INTEGER,
  clicks        INTEGER,
  ctr           REAL,
  cpc           REAL,
  cpm           REAL,
  cpa           REAL,
  PRIMARY KEY (hour_slot, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_snap_camp ON campaign_hourly_snapshots(campaign_id, hour_slot);
CREATE INDEX IF NOT EXISTS idx_snap_hour ON campaign_hourly_snapshots(hour_slot);

CREATE TABLE IF NOT EXISTS camp_alert_log (
  campaign_id  TEXT,
  day          TEXT,     -- YYYY-MM-DD IST
  bucket       REAL,     -- ROAS bucket threshold alerted (lower = more severe)
  sent_ts      TEXT,
  roas         REAL,
  spend_pct    REAL,
  PRIMARY KEY (campaign_id, day, bucket)
);
"""

COLS = ['ts', 'hour_slot', 'account_id', 'account_name', 'campaign_id', 'campaign_name',
        'objective', 'status', 'created_time', 'age_hours', 'daily_budget', 'spend', 'revenue',
        'roas', 'orders', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'cpa']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default='state/camp_snapshots.db')
    ap.add_argument('--accounts', nargs='*', default=None)
    ap.add_argument('--force', action='store_true',
                    help='pull even if this hour was already captured')
    args = ap.parse_args()
    tok = os.environ['META_ACCESS_TOKEN']

    now = datetime.now(IST)
    ts = now.isoformat(timespec='seconds')
    # The :58 boundary this run measures (the previous one if we're before :58).
    if now.minute >= 58:
        boundary = now.replace(minute=58, second=0, microsecond=0)
    else:
        boundary = (now - timedelta(hours=1)).replace(minute=58, second=0, microsecond=0)
    # Stamp the slot of the BOUNDARY measured, not the wall clock. A run landing
    # at 10:00:05 measures the 09:58 boundary; stamping it "10:00" lost that
    # hour outright once the 10:58 run replaced the row (22 Aug: no 09:00 slot,
    # which then made the WA "last hour" span 2.5h). --force (mid-hour capture)
    # keeps wall-clock so it still gets its own fresh slot.
    hour_slot = (now if args.force else boundary).strftime('%Y-%m-%d %H:00')

    # ONE measurement per hour, taken at the first run at/after :00 — so each
    # hour row holds the COMPLETE previous hour, stamped right when it turns.
    # Without this gate the 0,20,40 cron (delayed by GitHub to :43-:52) would
    # INSERT OR REPLACE the clean :00 capture with mid-hour data, and the
    # dashboard's hourly rows drift to "as of 13:43". Mid-hour runs are no-ops.
    if not args.force and os.path.exists(args.db):
        try:
            prev = sqlite3.connect(args.db).execute(
                "SELECT MAX(ts) FROM campaign_hourly_snapshots").fetchone()[0]
        except sqlite3.OperationalError:
            prev = None   # fresh/empty db — proceed
        # ONE measurement per hour, anchored to the :58 boundary: the operator's
        # hourly report is "complete hour, calculated at :58, sent at :00", so
        # the capture that defines hour H is the first run at/after H:58 (the
        # Worker dispatches at :55 IST to land here). A run before :58 still
        # pulls if the PREVIOUS :58 boundary was never captured (backstop).
        mark = boundary
        if prev and datetime.fromisoformat(prev) >= mark:
            print(f"boundary {mark:%H:%M} already captured at {prev} — skipping "
                  f"(use --force to overwrite)")
            return

    accounts = args.accounts or configured_accounts() or None
    print(f"accounts: {len(accounts) if accounts else 0} from config"
          if accounts else "accounts: falling back to me/adaccounts discovery")
    rows = fetch_active_campaigns(tok, accounts, now=now)

    # A PARTIAL snapshot is worse than no snapshot. If some accounts errored
    # transiently, the hour would be written looking complete while missing
    # their spend — downstream everything (blended ROAS, budgets, the closing
    # report) would treat the deflated number as authoritative. That is exactly
    # how NBP Skin cost ~Rs1L/day undetected. Permission errors are excluded
    # from this check: they are permanent and already known, so blocking on them
    # would mean never writing a snapshot at all.
    transient = [e for e in ACCOUNT_ERRORS if 'NOT grant' not in e[2]]
    if transient:
        print(f"ABORTING WRITE: {len(transient)} account(s) failed transiently — "
              f"refusing to save a partial hour that would understate spend:")
        for aid, name, err in transient:
            print(f"  - {aid} ({name}): {err[:110]}")
        print("previous snapshot left in place; the next run retries")
        raise SystemExit(1)

    # Second guard: a SILENT empty. Meta sometimes answers a throttled account
    # with an empty result set instead of an error, so ACCOUNT_ERRORS stays
    # clean and the hour writes looking complete. 31 Aug: SM Fragrance 01 + SM
    # SKIN returned nothing, the slot stored 120 of 245 campaigns, and the
    # report showed SM budget/active/closed as Rs 0 while it had spent Rs 5.4L.
    # An account with rows last slot and none now is a failure, not a real zero.
    if os.path.exists(args.db):
        try:
            _c = sqlite3.connect(args.db)
            _prev_slot = _c.execute(
                "SELECT MAX(hour_slot) FROM campaign_hourly_snapshots").fetchone()[0]
            _prev = dict(_c.execute(
                "SELECT account_name, COUNT(*) FROM campaign_hourly_snapshots "
                "WHERE hour_slot=? GROUP BY account_name", (_prev_slot,)).fetchall()
            ) if _prev_slot else {}
            _c.close()
        except sqlite3.OperationalError:
            _prev, _prev_slot = {}, None
        _now = {}
        for r in rows:
            _now[r['account_name']] = _now.get(r['account_name'], 0) + 1
        vanished = [(a, n) for a, n in _prev.items() if n >= 3 and _now.get(a, 0) == 0]
        if vanished:
            print(f"ABORTING WRITE: account(s) returned 0 campaigns but had rows at "
                  f"{_prev_slot} — silent API failure:")
            for a, n in vanished:
                print(f"  - {a}: {n} campaigns last slot, 0 now")
            print("previous snapshot left in place; the next run retries")
            raise SystemExit(1)

    con = sqlite3.connect(args.db)
    con.executescript(SCHEMA)
    # add status column to a pre-existing table (idempotent migration)
    cols = {r[1] for r in con.execute("PRAGMA table_info(campaign_hourly_snapshots)")}
    if 'status' not in cols:
        con.execute("ALTER TABLE campaign_hourly_snapshots ADD COLUMN status TEXT")
    payload = [(ts, hour_slot, r['account_id'], r['account_name'], r['campaign_id'],
                r['campaign_name'], r['objective'], r['status'], r['created_time'], r['age_hours'],
                r['daily_budget'], r['spend'], r['revenue'], r['roas'], r['orders'],
                r['impressions'], r['clicks'], r['ctr'], r['cpc'], r['cpm'], r['cpa'])
               for r in rows]
    con.executemany(
        f"INSERT OR REPLACE INTO campaign_hourly_snapshots ({','.join(COLS)}) "
        f"VALUES ({','.join('?' * len(COLS))})", payload)
    # 365-day retention: drop anything older
    cutoff = (now - timedelta(days=365)).isoformat(timespec='seconds')
    pruned = con.execute("DELETE FROM campaign_hourly_snapshots WHERE ts < ?", (cutoff,)).rowcount
    con.execute("DELETE FROM camp_alert_log WHERE day < ?", ((now - timedelta(days=365)).strftime('%Y-%m-%d'),))
    con.commit()
    if pruned:
        print(f"pruned {pruned} rows older than 365 days")
    tot = con.execute("SELECT COUNT(*) FROM campaign_hourly_snapshots").fetchone()[0]
    hrs = con.execute("SELECT COUNT(DISTINCT hour_slot) FROM campaign_hourly_snapshots").fetchone()[0]
    con.close()
    delivering = sum(1 for r in rows if r['spend'] > 0)
    print(f"[{hour_slot}] wrote {len(rows)} active campaigns ({delivering} delivering) | "
          f"DB now {tot} rows across {hrs} hourly slots")
    if ACCOUNT_ERRORS:
        # Loud, because a skipped account silently understates every downstream
        # number — spend, blended ROAS, and the closing report's coverage.
        print(f"WARNING: {len(ACCOUNT_ERRORS)} ad account(s) could not be read; their "
              f"spend is MISSING from this snapshot:")
        for aid, name, err in ACCOUNT_ERRORS:
            print(f"  - {aid} ({name}): {err}")


if __name__ == '__main__':
    main()
