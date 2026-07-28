#!/usr/bin/env python3
"""Build roas-live/summary.json — the small data file the WhatsApp reporting
bot (Cloudflare Worker) reads. Runs wherever build_roas_page.py runs, from the
same DBs, so it ships with every page deploy.

Contents: today live per portal, yesterday finals, yesterday top products,
today's campaign closes (SM), stamped with build time.
"""
import argparse, json, sqlite3
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
PORTALS = ('SM', 'SML', 'NBP')


def today_live(ntn_db, day):
    con = sqlite3.connect(ntn_db)
    out = {}
    for p in PORTALS:
        sales, orders = con.execute(
            "SELECT COALESCE(SUM(total_price),0), COUNT(*) FROM shopify_orders "
            "WHERE portal=? AND substr(created_at,1,10)=? AND cancelled_at IS NULL",
            (p, day)).fetchone()
        spend, = con.execute(
            "SELECT COALESCE(SUM(spend),0) FROM meta_ads_daily WHERE portal=? AND date=?",
            (p, day)).fetchone()
        out[p] = {'sales': round(sales), 'orders': orders, 'spend': round(spend),
                  'roas': round(sales / spend, 2) if spend else None}
    con.close()
    return out


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
        'live': today_live(args.ntn_db, today),
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
