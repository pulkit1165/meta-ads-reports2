#!/usr/bin/env python3
"""Overlay TODAY's Shopify orders (pulled live from all 3 stores) onto an
ntn.db copy, so the hourly WhatsApp table has sales complete through the :58
measurement moment instead of lagging behind the last full ingest.

Env: SHOPIFY_ACCESS_TOKEN(+_NBP,_SML), SHOPIFY_STORE_URL(+_NBP,_SML)
"""
import argparse, json, os, sqlite3, urllib.request
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))


def pull(store_url, token, day):
    url = (f'https://{store_url}/admin/api/2024-10/orders.json?status=any&limit=250'
           f'&created_at_min={day}T00:00:00%2B05:30'
           '&fields=id,name,created_at,cancelled_at,financial_status,total_price,subtotal_price,currency')
    out = []
    while url:
        r = urllib.request.Request(url, headers={'X-Shopify-Access-Token': token})
        with urllib.request.urlopen(r, timeout=60) as x:
            link = x.headers.get('Link', '')
            out += json.load(x)['orders']
        url = None
        for part in link.split(','):
            if 'rel="next"' in part:
                url = part[part.find('<') + 1:part.find('>')]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ntn-db', required=True)
    args = ap.parse_args()
    day = datetime.now(IST).strftime('%Y-%m-%d')
    stores = [
        ('SM', os.environ['SHOPIFY_STORE_URL'], os.environ['SHOPIFY_ACCESS_TOKEN']),
        ('NBP', os.environ['SHOPIFY_STORE_URL_NBP'], os.environ['SHOPIFY_ACCESS_TOKEN_NBP']),
        ('SML', os.environ['SHOPIFY_STORE_URL_SML'], os.environ['SHOPIFY_ACCESS_TOKEN_SML']),
    ]
    con = sqlite3.connect(args.ntn_db)
    n = 0
    for portal, dom, tok in stores:
        try:
            orders = pull(dom, tok, day)
        except Exception as e:
            print(f'{portal}: pull failed ({e}) — keeping ingest data for it')
            continue
        for o in orders:
            con.execute(
                'INSERT OR REPLACE INTO shopify_orders '
                '(order_id,portal,order_number,created_at,cancelled_at,financial_status,'
                ' total_price,subtotal_price,currency) VALUES (?,?,?,?,?,?,?,?,?)',
                (str(o['id']), portal, o.get('name'), o.get('created_at'),
                 o.get('cancelled_at'), o.get('financial_status'),
                 float(o.get('total_price') or 0), float(o.get('subtotal_price') or 0),
                 o.get('currency')))
            n += 1
    con.commit()
    print(f'overlaid {n} live orders for {day}')


if __name__ == '__main__':
    main()
