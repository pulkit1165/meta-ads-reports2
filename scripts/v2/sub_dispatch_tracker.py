#!/usr/bin/env python3
"""
sub_dispatch_tracker.py — monthly-dispatch schedule for prepaid subscription orders.

Subscription plans (Blue Light Saber pilot + future rollouts) are sold as
variants titled "N Months — Ships Monthly": the customer pays once, bottle 1
ships with the order, bottles 2..N must be dispatched every 30 days BY OPS.
This script is how ops knows.

Every run:
  1. Pull recent NBP orders, find line items whose variant title matches
     "Ships Monthly"; derive the dispatch schedule (order date + 30/60 days).
  2. Sync the '📦 Sub Dispatches' tab in the reports sheet — append NEW
     dispatch rows only; rows already present are never touched, so the
     Status column belongs to ops (mark DONE when shipped).
  3. Write roas-live/sub_dispatch.json with everything due today or overdue
     and not DONE — the Cloudflare worker WhatsApps that list every morning.

Runs inside camp-snapshots.yml (hourly); the WA push is once daily.
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
SHEET_ID = os.environ.get('REPORTS_SHEET_ID') or '1hJ3IS2VDtTAEyyJIV__jvts9CMQdYhyxKAfWKtrkUH4'
SA_FILE = os.environ.get('GOOGLE_SERVICE_ACCOUNT_FILE') or 'google-service-account.json'
TAB = '📦 Sub Dispatches'
HEADER = ['Key', 'Order', 'Ordered on', 'Customer', 'Phone', 'City', 'Product',
          'Plan', 'Dispatch #', 'Due date', 'Status']
LOOKBACK_HOURS = 26   # hourly runs; overlap is deduped by row key


def shopify_orders():
    url = os.environ['SHOPIFY_STORE_URL_NBP']
    tok = os.environ['SHOPIFY_ACCESS_TOKEN_NBP']
    since = (datetime.now(IST) - timedelta(hours=LOOKBACK_HOURS)).strftime('%Y-%m-%dT%H:%M:%S%z')
    since = since[:-2] + ':' + since[-2:]
    page = (f"https://{url}/admin/api/2024-07/orders.json?status=any&limit=250"
            f"&created_at_min={urllib.parse.quote(since)}"
            f"&fields=id,name,created_at,cancelled_at,customer,shipping_address,line_items")
    out = []
    while page:
        req = urllib.request.Request(page, headers={'X-Shopify-Access-Token': tok})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
            link = r.headers.get('Link', '')
        out.extend(data.get('orders', []))
        m = re.search(r'<([^>]+)>;\s*rel="next"', link)
        page = m.group(1) if m else None
    return out


def dispatch_rows():
    rows = []
    for o in shopify_orders():
        if o.get('cancelled_at'):
            continue
        for li in o.get('line_items', []):
            vt = li.get('variant_title') or ''
            m = re.match(r'\s*(\d+)\s*Months\s*—\s*Ships Monthly', vt)
            if not m:
                continue
            months = int(m.group(1))
            created = datetime.strptime(o['created_at'][:10], '%Y-%m-%d').date()
            cust = o.get('customer') or {}
            addr = o.get('shipping_address') or {}
            name = ((cust.get('first_name') or '') + ' ' + (cust.get('last_name') or '')).strip()
            phone = addr.get('phone') or cust.get('phone') or ''
            qty = li.get('quantity') or 1
            for i in range(2, months + 1):          # dispatch 1 = the order itself
                due = created + timedelta(days=30 * (i - 1))
                rows.append({
                    'key': f"{o['name']}-{li['id']}-d{i}",
                    'order': o['name'], 'ordered': str(created),
                    'customer': name or '—', 'phone': str(phone),
                    'city': addr.get('city') or '—',
                    'product': (li.get('title') or '')[:40],
                    'plan': vt + (f' × {qty}' if qty > 1 else ''),
                    'dispatch': f'{i} of {months}',
                    'due': str(due),
                })
    return rows


def sync_sheet(rows):
    import gspread
    from google.oauth2.service_account import Credentials
    creds = Credentials.from_service_account_file(
        SA_FILE, scopes=['https://www.googleapis.com/auth/spreadsheets'])
    sh = gspread.authorize(creds).open_by_key(SHEET_ID)
    try:
        ws = sh.worksheet(TAB)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title=TAB, rows=2000, cols=len(HEADER))
        ws.append_row(HEADER)
    existing = ws.get_all_values()
    known = {r[0] for r in existing[1:] if r}
    status = {r[0]: (r[10] if len(r) > 10 else '') for r in existing[1:] if r}
    new = [[r['key'], r['order'], r['ordered'], r['customer'], r['phone'], r['city'],
            r['product'], r['plan'], r['dispatch'], r['due'], 'PENDING']
           for r in rows if r['key'] not in known]
    if new:
        ws.append_rows(new, value_input_option='USER_ENTERED')
    print(f'  sheet: {len(new)} new dispatch row(s), {len(known)} already tracked')
    # The sheet is the source of truth for the due list: it holds ALL history
    # (this run only fetched the last day of orders) and ops' DONE marks.
    pending = []
    for r in existing[1:]:
        if len(r) >= 11 and r[9] and 'DONE' not in (r[10] or '').upper():
            pending.append({'key': r[0], 'order': r[1], 'customer': r[3], 'phone': r[4],
                            'city': r[5], 'product': r[6], 'plan': r[7],
                            'dispatch': r[8], 'due': r[9]})
    for r in new:
        pending.append({'key': r[0], 'order': r[1], 'customer': r[3], 'phone': r[4],
                        'city': r[5], 'product': r[6], 'plan': r[7],
                        'dispatch': r[8], 'due': r[9]})
    return pending


def main():
    rows = dispatch_rows()
    print(f'sub-dispatch: {len(rows)} scheduled dispatches in new orders (last {LOOKBACK_HOURS}h)')
    try:
        pending = sync_sheet(rows)
    except Exception as e:
        print(f'  sheet sync failed ({e}) — due list limited to this run: {e}')
        pending = rows
    today = datetime.now(IST).date()
    due = []
    for r in pending:
        try:
            if datetime.strptime(r['due'], '%Y-%m-%d').date() <= today:
                due.append(r)
        except ValueError:
            continue
    out = {
        'generated_at': datetime.now(IST).isoformat(timespec='seconds'),
        'due_count': len(due),
        'due': sorted(due, key=lambda r: r['due'])[:30],
        'tracked_pending': len(pending),
    }
    dest = Path(sys.argv[1] if len(sys.argv) > 1 else 'roas-live/sub_dispatch.json')
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=1))
    print(f"wrote {dest} — {len(due)} due/overdue")


if __name__ == '__main__':
    main()
