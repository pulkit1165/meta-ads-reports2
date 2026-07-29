#!/usr/bin/env python3
"""Build roas-live/summary.json — the small data file the WhatsApp reporting
bot (Cloudflare Worker) reads. Runs wherever build_roas_page.py runs, from the
same DBs, so it ships with every page deploy.

Contents: today live per portal, yesterday finals, yesterday top products,
today's campaign closes (SM), stamped with build time.
"""
import argparse, json, sqlite3, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from portal_hourly import build_rows, summarise  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
PORTALS = ('SM', 'SML', 'NBP')


def today_live(ntn_db, snap_db, day):
    """Same numbers as the dashboard's "Today by website" table.

    Was: realized-or-not orders / meta_ads_daily — meta_ads_daily misses
    accounts the v2 ingest skips and the order query counted pending revenue,
    so the WhatsApp digest disagreed with the page. Both now come from
    portal_hourly (snapshots spend + realized-sales filter) so the two can
    never drift apart again.
    """
    tot = summarise(build_rows(snap_db, ntn_db, day))
    return {p: {'sales': round(tot[p]['rev']), 'orders': tot[p]['orders'],
                'spend': round(tot[p]['spend']),
                'roas': round(tot[p]['rev'] / tot[p]['spend'], 2) if tot[p]['spend'] else None}
            for p in PORTALS}


def top_products(ntn_db, day, n=10):
    con = sqlite3.connect(ntn_db)
    rows = con.execute(
        "SELECT oi.product_title, SUM(oi.quantity) q FROM shopify_order_items oi "
        "JOIN shopify_orders o ON o.order_id=oi.order_id "
        "WHERE substr(o.created_at,1,10)=? AND o.cancelled_at IS NULL "
        "GROUP BY oi.product_title ORDER BY q DESC LIMIT ?", (day, n)).fetchall()
    con.close()
    return [{'title': t[:60], 'qty': int(q)} for t, q in rows]


def closes_today(snap_db, day):
    """SM campaigns that flipped Active->Paused today: count, early count, sunk."""
    con = sqlite3.connect(snap_db)
    rows = con.execute(
        "SELECT campaign_id, hour_slot, spend, roas, status FROM campaign_hourly_snapshots "
        "WHERE substr(hour_slot,1,10)=? ORDER BY campaign_id, hour_slot", (day,)).fetchall()
    con.close()
    by = {}
    for cid, hs, sp, ro, st in rows:
        by.setdefault(cid, []).append((hs, sp or 0, ro or 0, st))
    total = early = 0
    sunk = 0.0
    for cid, snaps in by.items():
        prev = None
        for hs, sp, ro, st in snaps:
            if prev and prev[3] == 'Active' and st == 'Paused':
                total += 1
                hr = int(hs[11:13])
                if hr <= 9:
                    early += 1
                sunk += sp
                break
            prev = (hs, sp, ro, st)
    return {'closes': total, 'early': early, 'sunk': round(sunk)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ntn-db', required=True)
    ap.add_argument('--snap-db', required=True)
    ap.add_argument('--finals', required=True)
    ap.add_argument('--out', default='roas-live/summary.json')
    args = ap.parse_args()

    now = datetime.now(IST)
    today = now.strftime('%Y-%m-%d')
    yday = (now - timedelta(days=1)).strftime('%Y-%m-%d')

    try:
        finals = json.load(open(args.finals)).get(yday, {})
    except Exception:
        finals = {}
    yfin = {}
    for p, v in finals.items():
        yfin[p] = {'sales': round(v.get('sales', 0)), 'spend': round(v.get('spend', 0)),
                   'orders': v.get('orders', 0),
                   'roas': round(v['sales'] / v['spend'], 2) if v.get('spend') else None}

    out = {
        'built_at': now.isoformat(timespec='seconds'),
        'today': today,
        'live': today_live(args.ntn_db, args.snap_db, today),
        'yesterday': {'date': yday, 'portals': yfin},
        'top_products_yday': top_products(args.ntn_db, yday),
        'closes_today_sm': closes_today(args.snap_db, today),
    }
    json.dump(out, open(args.out, 'w'), indent=1)
    print(f"wrote {args.out} — live blended "
          f"{sum(v['sales'] for v in out['live'].values())}/"
          f"{sum(v['spend'] for v in out['live'].values())}")


if __name__ == '__main__':
    main()
