#!/usr/bin/env python3
"""
build_yday_report.py — portal-wise "yesterday final" WhatsApp report feed.

For yesterday (IST), per portal (SM / SML / NBP) + ALL:
  * sales / orders / spend / ROAS   — from frozen daily_finals.json (Ads-Manager-
    exact spend, full-day Shopify sales; never intra-day approximations)
  * budget allocated                — sum of daily_budget of campaigns that were
    Active at any hourly snapshot yesterday (last-seen budget per campaign)
  * budget closed                   — of that, campaigns already Paused at the
    22:00 IST snapshot ("closed during the day")
  * live after 10 PM                — budget still Active at the 22:00 snapshot
  * vs day-before                   — % change in spend, orders, sales; ROAS delta

Writes --out (default roas-live/yday_report.json). The cron worker formats and
sends it at ~9 AM IST; /test-yday sends on demand.
"""
import argparse
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from portal_hourly import PORTALS, portal_of  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))


def budget_split(snap_db: str, day: str) -> dict:
    """{portal: {'alloc': .., 'closed': .., 'live_10pm': ..}} from hourly snapshots.

    A campaign counts as allocated if it was Active at any snapshot of `day`.
    Its closed/live split comes from its status at the 22:00 slot, falling back
    to its last snapshot of the day (campaign vanished = treat as closed).
    """
    out = {p: {'alloc': 0.0, 'closed': 0.0, 'live_10pm': 0.0} for p in PORTALS}
    con = sqlite3.connect(f'file:{snap_db}?mode=ro', uri=True)
    try:
        rows = con.execute(
            "SELECT campaign_id, account_name, hour_slot, status, COALESCE(daily_budget,0) "
            "FROM campaign_hourly_snapshots WHERE hour_slot LIKE ? || ' %' "
            "ORDER BY campaign_id, hour_slot", (day,)).fetchall()
    finally:
        con.close()
    camps = {}
    for cid, acct, slot, status, budget in rows:
        c = camps.setdefault(cid, {'portal': portal_of(acct), 'ever_active': False,
                                   'budget': 0.0, 'at10': None, 'last': None})
        if status == 'Active':
            c['ever_active'] = True
        if budget:
            c['budget'] = budget
        c['last'] = status
        if slot.endswith(' 22:00'):
            c['at10'] = status
    for c in camps.values():
        p = c['portal']
        if not p or not c['ever_active'] or not c['budget']:
            continue
        out[p]['alloc'] += c['budget']
        if (c['at10'] or c['last']) == 'Active':
            out[p]['live_10pm'] += c['budget']
        else:
            out[p]['closed'] += c['budget']
    return out


def finals_day(finals: dict, day: str) -> dict:
    """{portal: {'sales':., 'orders':., 'spend':., 'roas':.}} for a frozen day."""
    e = finals.get(day, {})
    out = {}
    for p, v in e.items():
        sp = float(v.get('spend') or 0)
        out[p] = {'sales': float(v.get('sales') or 0), 'orders': int(v.get('orders') or 0),
                  'spend': sp, 'roas': round(float(v.get('sales') or 0) / sp, 2) if sp else None}
    return out


def pct(new, old):
    return round((new - old) / old * 100, 1) if old else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--snap-db', default='state/camp_snapshots.db')
    ap.add_argument('--finals', default='state/daily_finals.json')
    ap.add_argument('--out', default='roas-live/yday_report.json')
    ap.add_argument('--day', default=None, help='override "yesterday" (YYYY-MM-DD)')
    args = ap.parse_args()

    now = datetime.now(IST)
    yday = args.day or (now - timedelta(days=1)).strftime('%Y-%m-%d')
    prev = (datetime.strptime(yday, '%Y-%m-%d') - timedelta(days=1)).strftime('%Y-%m-%d')

    finals = json.load(open(args.finals))
    fy, fp = finals_day(finals, yday), finals_day(finals, prev)
    if not fy:
        print(f'yday_report: {yday} not frozen yet — skipping')
        return
    budgets = budget_split(args.snap_db, yday)

    rows = []
    tot = {'sales': 0.0, 'orders': 0, 'spend': 0.0, 'alloc': 0.0, 'closed': 0.0, 'live_10pm': 0.0}
    ptot = {'sales': 0.0, 'orders': 0, 'spend': 0.0}
    for p in PORTALS:
        y = fy.get(p)
        if not y:
            continue
        b = budgets.get(p, {'alloc': 0, 'closed': 0, 'live_10pm': 0})
        pv = fp.get(p, {})
        rows.append({
            'portal': p,
            'sales': round(y['sales']), 'orders': y['orders'],
            'spend': round(y['spend']), 'roas': y['roas'],
            'budget_alloc': round(b['alloc']), 'budget_closed': round(b['closed']),
            'live_10pm': round(b['live_10pm']),
            'vs_prev': {
                'sales_pct': pct(y['sales'], pv.get('sales') or 0),
                'orders_pct': pct(y['orders'], pv.get('orders') or 0),
                'spend_pct': pct(y['spend'], pv.get('spend') or 0),
                'roas_delta': (round(y['roas'] - pv['roas'], 2)
                               if y['roas'] is not None and pv.get('roas') is not None else None),
            },
        })
        for k in ('sales', 'orders', 'spend'):
            tot[k] += y[k]
        for k in ('alloc', 'closed', 'live_10pm'):
            tot[k] += b[k]
        for k in ('sales', 'orders', 'spend'):
            ptot[k] += pv.get(k) or 0
    all_roas = round(tot['sales'] / tot['spend'], 2) if tot['spend'] else None
    prev_roas = round(ptot['sales'] / ptot['spend'], 2) if ptot['spend'] else None
    out = {
        'day': yday, 'prev_day': prev,
        'built_at': now.isoformat(timespec='seconds'),
        'rows': rows,
        'all': {'sales': round(tot['sales']), 'orders': int(tot['orders']),
                'spend': round(tot['spend']), 'roas': all_roas,
                'budget_alloc': round(tot['alloc']), 'budget_closed': round(tot['closed']),
                'live_10pm': round(tot['live_10pm']),
                'vs_prev': {'sales_pct': pct(tot['sales'], ptot['sales']),
                            'orders_pct': pct(tot['orders'], ptot['orders']),
                            'spend_pct': pct(tot['spend'], ptot['spend']),
                            'roas_delta': (round(all_roas - prev_roas, 2)
                                           if all_roas is not None and prev_roas is not None else None)}},
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=1))
    print(f"wrote {args.out} — {yday} ALL Rs{out['all']['sales']:,}/Rs{out['all']['spend']:,} "
          f"R{out['all']['roas']} alloc Rs{out['all']['budget_alloc']:,} "
          f"closed Rs{out['all']['budget_closed']:,} live@10pm Rs{out['all']['live_10pm']:,}")


if __name__ == '__main__':
    main()
