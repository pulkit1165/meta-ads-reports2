#!/usr/bin/env python3
"""
Copy the auto-pause bot's own record of what it closed into Postgres.

The bot writes one JSON file per IST day to prithvi/state/auto_paused_<date>.json
listing every campaign it switched off, with the rule that fired, the budget, the
spend at that moment and the ROAS it was cut at. Nothing else in the warehouse
knows this: meta_campaign_snapshot can tell you a campaign went from ACTIVE to
PAUSED between two ten-minute reads, but not who did it or why.

That distinction is the whole point of the table. A close the bot claims is a
close the ladder made; a status flip with no matching claim was made by a person
in Ads Manager. Without this file the two are indistinguishable.

Idempotent: re-reading a day replaces that day's rows, so running it every ten
minutes simply keeps the current day current.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

STATE_DIR = Path(os.environ.get("PAUSE_STATE_DIR", "/home/ec2-user/prithvi/state"))
PG = dict(
    host=os.environ.get("PGHOST", "localhost"),
    port=int(os.environ.get("PGPORT", 5432)),
    dbname=os.environ.get("PGDATABASE", "prithvi_master"),
    user=os.environ.get("PGUSER", "prithvi"),
    password=os.environ.get("PGPASSWORD", "Prithvi@2026"),
)
IST = timezone(timedelta(hours=5, minutes=30))

DDL = """
CREATE TABLE IF NOT EXISTS bot_pause_event (
  campaign_id   text        NOT NULL,
  paused_at     timestamptz NOT NULL,
  d             date        NOT NULL,
  portal        text,
  account       text,
  campaign_name text,
  rule          text,
  day_no        int,
  gate_rs       numeric,
  budget        numeric,
  spend         numeric,
  pct           numeric,
  roas          numeric,
  dry_run       boolean DEFAULT false,
  PRIMARY KEY (campaign_id, paused_at)
);
CREATE INDEX IF NOT EXISTS bot_pause_event_d_idx ON bot_pause_event (d);
"""


def parse_rule(rule):
    """'d0_gate3000_roas0.47' -> (day_no, gate_rs).

    d0 is the campaign's first day, which everything else in this warehouse
    calls day 1, so the number is shifted to match rather than leaking the
    bot's own zero-based counting into the reports.
    """
    day_no = gate = None
    for part in (rule or "").split("_"):
        if part.startswith("d") and part[1:].isdigit():
            day_no = int(part[1:]) + 1
        elif part.startswith("gate"):
            try:
                gate = float(part[4:])
            except ValueError:
                pass
    return day_no, gate


def rows_for(day):
    f = STATE_DIR / f"auto_paused_{day}.json"
    if not f.exists():
        return None
    doc = json.loads(f.read_text())
    out = []
    for e in doc.get("paused", []):
        ts = e.get("paused_at")
        if not ts:
            continue
        at = datetime.fromisoformat(ts)
        if at.tzinfo is None:
            at = at.replace(tzinfo=IST)
        day_no, gate = parse_rule(e.get("rule"))
        out.append((
            str(e.get("campaign_id")), at, at.astimezone(IST).date(),
            e.get("portal"), e.get("account"), e.get("name"), e.get("rule"),
            day_no, gate, e.get("budget"), e.get("spend"), e.get("pct"),
            e.get("roas"), bool(e.get("dry_run")),
        ))
    return out


def main():
    back = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    today = datetime.now(IST).date()
    days = [(today - timedelta(days=i)).isoformat() for i in range(back)]

    conn = psycopg2.connect(**PG)
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute(DDL)

    total = 0
    for day in days:
        rows = rows_for(day)
        if rows is None:
            print(f"  {day}  no state file")
            continue
        # Replace the day wholesale. The bot rewrites the file on every run, so
        # it is the authority for that day; merging would keep rows it dropped.
        cur.execute("DELETE FROM bot_pause_event WHERE d = %s", (day,))
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO bot_pause_event
               (campaign_id, paused_at, d, portal, account, campaign_name, rule,
                day_no, gate_rs, budget, spend, pct, roas, dry_run)
               VALUES %s ON CONFLICT DO NOTHING""",
            rows,
        )
        total += len(rows)
        print(f"  {day}  {len(rows)} pauses")

    conn.commit()
    cur.close()
    conn.close()
    print(f"sync_bot_pauses: {total} rows across {len(days)} days")


if __name__ == "__main__":
    main()
