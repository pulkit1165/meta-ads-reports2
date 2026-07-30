#!/usr/bin/env python3
"""Build AWB -> Shopify order map for the Delhivery recon dashboard.

Uses Shopify GraphQL BULK operations: one request per store, no pagination,
no rate limits. Covers SM + SML + NBP. Output: awb-order-map.csv
(columns: AWB, Shopify Order, Portal, Order Total, Created) — import it in
the dashboard via the "Order map" button.

Usage:  python3 build_awb_map.py [days_back]   (default 90)
"""
import os, sys, json, time, re, csv, urllib.request
from datetime import datetime, timedelta

ENV = {}
for line in open(os.path.expanduser("~/.openclaw/workspace/.env")):
    m = re.match(r"([A-Z_]+)=(.*)", line.strip())
    if m:
        ENV[m.group(1)] = m.group(2)

STORES = {
    "SM":  (ENV.get("SHOPIFY_STORE_URL"),     ENV.get("SHOPIFY_ACCESS_TOKEN")),
    "SML": (ENV.get("SHOPIFY_STORE_URL_SML"), ENV.get("SHOPIFY_ACCESS_TOKEN_SML")),
    "NBP": (ENV.get("SHOPIFY_STORE_URL_NBP"), ENV.get("SHOPIFY_ACCESS_TOKEN_NBP")),
}
VER = ENV.get("SHOPIFY_API_VERSION", "2024-10")
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 90
SINCE = (datetime.utcnow() - timedelta(days=DAYS)).strftime("%Y-%m-%d")


def gql(shop, tok, query):
    req = urllib.request.Request(
        f"https://{shop}/admin/api/{VER}/graphql.json",
        data=json.dumps({"query": query}).encode(),
        headers={"X-Shopify-Access-Token": tok, "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


MUT = '''mutation {{ bulkOperationRunQuery(query: """
{{ orders(query: "created_at:>={since}") {{ edges {{ node {{
    id name createdAt totalPriceSet {{ shopMoney {{ amount }} }}
    fulfillments {{ trackingInfo {{ number }} }}
}} }} }} }}
""") {{ bulkOperation {{ id status }} userErrors {{ field message }} }} }}'''

rows, stats = [], []
for portal, (shop, tok) in STORES.items():
    if not shop or not tok:
        print(f"!! {portal}: missing credentials, skipped"); continue
    r = gql(shop, tok, MUT.format(since=SINCE))
    errs = r["data"]["bulkOperationRunQuery"]["userErrors"]
    if errs:
        print(f"!! {portal}: {errs}"); continue
    print(f"{portal}: bulk export started ({SINCE} onward)…", flush=True)
    status = None
    for _ in range(240):                       # up to 20 min per store
        time.sleep(5)
        s = gql(shop, tok, "{ currentBulkOperation { status objectCount url } }")
        status = s["data"]["currentBulkOperation"]
        if status["status"] in ("COMPLETED", "FAILED"):
            break
    if status["status"] != "COMPLETED" or not status.get("url"):
        print(f"!! {portal}: {status['status']}"); continue
    data = urllib.request.urlopen(status["url"], timeout=300).read().decode()
    n_awb = 0
    for line in data.strip().split("\n"):
        o = json.loads(line)
        total = (o.get("totalPriceSet") or {}).get("shopMoney", {}).get("amount", "")
        awbs = {t["number"] for f in (o.get("fulfillments") or [])
                for t in f.get("trackingInfo", []) if t.get("number")}
        for awb in awbs:
            rows.append([awb, o["name"], portal, total, o["createdAt"][:10]])
            n_awb += 1
    stats.append(f"{portal}: {status['objectCount']} orders, {n_awb} AWB links")
    print(f"{portal}: done — {status['objectCount']} orders, {n_awb} AWB links")

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "awb-order-map.csv")
with open(out, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["AWB", "Shopify Order", "Portal", "Order Total", "Created"])
    w.writerows(rows)
print(f"\nwrote {out} — {len(rows):,} AWB links | " + " | ".join(stats))
