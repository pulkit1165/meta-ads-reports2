#!/usr/bin/env python3
"""
Create Shopify orders for Fastrr (Shiprocket) checkouts that were paid but
never reached Shopify.

The app uses Shiprocket's *custom platform* checkout. That pipeline collects
payment but does NOT create the order in Shopify — the seller is expected to
do it from the order webhook. This script is that missing half, run as a
poller so it also works without Shiprocket registering a webhook URL.

Safe by default: prints what it would do. Use --apply to actually create.

  python3 fastrr_reconcile.py                 # dry run, last 2 days
  python3 fastrr_reconcile.py --days 45       # dry run, full backfill window
  python3 fastrr_reconcile.py --apply --limit 1
  python3 fastrr_reconcile.py --apply --days 45
"""
import argparse, base64, hashlib, hmac, json, os, re, sys, time, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, 'fastrr_synced.json')

FASTRR_BASE = 'https://checkout-api.shiprocket.com'
API_KEY = os.environ.get('FASTRR_API_KEY', '')
API_SECRET = os.environ.get('FASTRR_API_SECRET', '')

def load_env_fallback():
    """Local convenience: read creds from the workspace .env if not in env."""
    global API_KEY, API_SECRET
    p = os.path.expanduser('~/.openclaw/workspace/.env')
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k, v)
    API_KEY = API_KEY or os.environ.get('FASTRR_API_KEY', '')
    API_SECRET = API_SECRET or os.environ.get('FASTRR_API_SECRET', '')

def shop_cfg():
    store = os.environ['SHOPIFY_STORE_URL'].replace('https://', '').strip('/')
    return store, os.environ['SHOPIFY_ACCESS_TOKEN'], os.environ.get('SHOPIFY_API_VERSION', '2024-10')

def fastrr(path, body):
    raw = json.dumps(body)
    sig = base64.b64encode(hmac.new(API_SECRET.encode(), raw.encode(), hashlib.sha256).digest()).decode()
    req = urllib.request.Request(FASTRR_BASE + path, data=raw.encode(), method='POST',
        headers={'Content-Type': 'application/json', 'X-Api-Key': API_KEY, 'X-Api-HMAC-SHA256': sig})
    for attempt in range(4):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=40).read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(2 * (attempt + 1)); continue
            return {'error': e.code, 'body': e.read().decode()[:300]}
    return {'error': 'retries exhausted'}

def shopify(method, path, payload=None):
    store, tok, ver = shop_cfg()
    req = urllib.request.Request(f'https://{store}/admin/api/{ver}/{path}',
        data=json.dumps(payload).encode() if payload else None, method=method,
        headers={'X-Shopify-Access-Token': tok, 'Content-Type': 'application/json'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read()), r.headers
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                time.sleep(2 * (attempt + 1)); continue
            raise RuntimeError(f'{e.code} {method} {path}: {e.read().decode()[:400]}')

def oid_time(oid):
    return datetime.fromtimestamp(int(oid[:8], 16), tz=timezone.utc)

def load_state():
    if os.path.exists(STATE):
        try: return json.load(open(STATE))
        except Exception: pass
    return {'synced': {}}

def save_state(st):
    json.dump(st, open(STATE, 'w'), indent=1)

def existing_index():
    """One GraphQL pass over orders we've previously recovered, so the
    backfill is idempotent without re-scanning the whole store per order."""
    store, tok, ver = shop_cfg()
    out, cursor = {}, None
    for _ in range(40):
        after = f', after: "{cursor}"' if cursor else ''
        q = ('{ orders(first: 250, query: "tag:fastrr-recovered"%s) '
             '{ pageInfo { hasNextPage endCursor } edges { node { name '
             'customAttributes { key value } } } } }') % after
        req = urllib.request.Request(f'https://{store}/admin/api/{ver}/graphql.json',
            data=json.dumps({'query': q}).encode(), method='POST',
            headers={'X-Shopify-Access-Token': tok, 'Content-Type': 'application/json'})
        try:
            d = json.loads(urllib.request.urlopen(req, timeout=60).read())
        except urllib.error.HTTPError as e:
            print('  (tag index unavailable:', e.code, '— relying on state file)'); return out
        orders = (((d.get('data') or {}).get('orders')) or {})
        for e in orders.get('edges', []):
            n = e['node']
            for a in (n.get('customAttributes') or []):
                if a.get('key') == 'fastrr_order_id' and a.get('value'):
                    out[a['value']] = n['name']
        pi = orders.get('pageInfo') or {}
        if not pi.get('hasNextPage'): break
        cursor = pi.get('endCursor')
    return out

def addr(a):
    """Shopify rejects an address without a last name, and many Fastrr
    customers only supply a first name — so split or substitute one."""
    if not a: return None
    first = (a.get('first_name') or '').strip() or 'Customer'
    last = (a.get('last_name') or '').strip()
    if not last:
        parts = first.split()
        if len(parts) > 1:
            first, last = parts[0], ' '.join(parts[1:])
        else:
            last = '.'
    return {
        'first_name': first,
        'last_name': last,
        'address1': a.get('line1') or '',
        'address2': ' '.join(x for x in [a.get('line2'), a.get('landmark')] if x),
        'city': a.get('city') or '',
        'province': a.get('state') or '',
        'zip': str(a.get('pincode') or ''),
        'country_code': a.get('country_code') or 'IN',
        'phone': a.get('phone') or '',
    }

def build_order(r):
    items = (r.get('cart_data') or {}).get('items') or []
    line_items = []
    for it in items:
        li = {'variant_id': int(it['variant_id']), 'quantity': int(it.get('quantity') or 1)}
        if it.get('price') is not None:
            li['price'] = str(it['price'])
        line_items.append(li)

    ptype = (r.get('payment_type') or '').upper()
    prepaid = (ptype == 'PREPAID')
    partial = ('PARTIAL' in ptype)
    total = float(r.get('total_amount_payable') or 0)
    # money actually collected up front (advance for partial-COD orders)
    received = 0.0
    for p in (r.get('payments') or []):
        if str(p.get('payment_status','')).lower() == 'success':
            received += float(p.get('amount_received') or p.get('amount') or 0)
    ship = float(r.get('shipping_charges') or 0)
    disc = float(r.get('total_discount') or 0)
    codes = r.get('coupon_codes') or []
    pay = (r.get('payments') or [{}])[0]

    o = {
        'line_items': line_items,
        'email': r.get('email') or None,
        'phone': r.get('phone') or None,
        'shipping_address': addr(r.get('shipping_address')),
        'billing_address': addr(r.get('billing_address') or r.get('shipping_address')),
        'currency': 'INR',
        'financial_status': 'paid' if prepaid else ('partially_paid' if partial else 'pending'),
        'inventory_behaviour': 'decrement_obeying_policy',
        'send_receipt': False,
        'send_fulfillment_receipt': False,
        'tags': 'studd-muffyn-app, fastrr-recovered',
        'note': f"Created from Shiprocket/Fastrr app checkout {r.get('order_id')}",
        'note_attributes': [
            {'name': 'fastrr_order_id', 'value': str(r.get('order_id'))},
            {'name': 'source', 'value': 'studd_muffyn_app'},
            {'name': 'payment_type', 'value': str(r.get('payment_type'))},
            {'name': 'payment_gateway', 'value': str(pay.get('gateway') or '')},
            {'name': 'payment_method', 'value': str(pay.get('payment_method') or '')},
            {'name': 'fastrr_txn_id', 'value': str(pay.get('txn_id') or '')},
            {'name': 'pg_transaction_id', 'value': str(pay.get('pg_transaction_id') or '')},
        ],
    }
    if ship:
        o['shipping_lines'] = [{'title': r.get('shipping_plan') or 'Shipping', 'price': str(ship), 'code': r.get('shipping_plan') or 'Standard'}]
    if disc:
        o['discount_codes'] = [{'code': codes[0] if codes else 'FASTRR_DISCOUNT',
                                'amount': str(disc), 'type': 'fixed_amount'}]
    # record exactly what was collected, so the COD balance stays correct and
    # partially-paid customers are never asked to pay the advance twice
    charged = total if prepaid else (received if partial else 0.0)
    if charged:
        o['transactions'] = [{'kind': 'sale', 'status': 'success', 'amount': str(charged),
                              'currency': 'INR', 'gateway': pay.get('gateway') or 'Fastrr'}]
    o['note_attributes'].append({'name': 'amount_prepaid', 'value': str(received)})
    o['note_attributes'].append({'name': 'balance_due_cod', 'value': str(round(total - received, 2))})
    return {k: v for k, v in o.items() if v is not None}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=2)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    load_env_fallback()
    if not API_KEY or not API_SECRET:
        sys.exit('FASTRR_API_KEY / FASTRR_API_SECRET not set')

    now = datetime.now(timezone.utc)
    iso = lambda d: d.strftime('%Y-%m-%dT%H:%M:%SZ')
    since_iso = iso(now - timedelta(days=args.days))

    lst = fastrr('/api/v1/custom-platform-order/details/list', {
        'startDate': since_iso, 'endDate': iso(now), 'timestamp': iso(now),
        'status': 'SUCCESS', 'limit': 250, 'page': 0})
    ids = [o['id'] for o in ((lst.get('result') or {}).get('data') or [])]
    if not ids:
        print('no SUCCESS orders in window'); return

    state = load_state()
    print('building index of already-recovered orders...')
    index = existing_index()
    for k, v in index.items(): state['synced'].setdefault(k, v)
    print(f'  {len(index)} already recovered previously')
    todo = [i for i in ids if i not in state['synced']]
    print(f'{len(ids)} paid Fastrr orders in last {args.days}d | {len(todo)} not yet in Shopify')
    if args.limit: todo = todo[:args.limit]

    created = skipped = failed = 0
    for n, oid in enumerate(todo, 1):
        det = fastrr('/api/v1/custom-platform-order/details', {'order_id': oid, 'timestamp': iso(now)})
        r = det.get('result') or {}
        if r.get('status') != 'SUCCESS':
            print(f'  [{n}] {oid[:10]} status={r.get("status")} — skip'); skipped += 1; continue

        existing = index.get(oid)
        if existing:
            print(f'  [{n}] {oid[:10]} already in Shopify as {existing}')
            state['synced'][oid] = existing; skipped += 1; continue

        payload = build_order(r)
        amt = r.get('total_amount_payable')
        who = (r.get('shipping_address') or {}).get('first_name') or ''
        if not args.apply:
            print(f'  [{n}] DRY-RUN would create: {who} {r.get("phone")} ₹{amt} '
                  f'({len(payload["line_items"])} items, {r.get("payment_type")})')
            continue
        try:
            resp, _ = shopify('POST', 'orders.json', {'order': payload})
            name = resp['order']['name']
            print(f'  [{n}] CREATED {name} — {who} ₹{amt}')
            state['synced'][oid] = name; created += 1
            save_state(state)
            time.sleep(0.6)
        except Exception as e:
            print(f'  [{n}] FAILED {oid[:10]}: {str(e)[:300]}'); failed += 1

    if args.apply: save_state(state)
    print(f'\ncreated={created} skipped={skipped} failed={failed}')

if __name__ == '__main__':
    main()
