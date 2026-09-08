"""Verify a Shopify order actually contains a question pack before granting quota.

Reads only. Matching is deliberately strict: the order must contain a known pack SKU, be
paid, and belong to this WhatsApp number (or the customer must supply the checkout phone).
Nobody unlocks questions by guessing an order number.

The bot serves customers of more than one brand's Shopify store through this single
WhatsApp number — the astrology service itself isn't brand-specific, only which store an
order lives in is. An order number is checked against every configured store in turn until
one matches, since the customer's message ("order 1234") doesn't say which store they
bought from.
"""
from __future__ import annotations

import logging
import os
import re
import requests

log = logging.getLogger(__name__)

VERSION = os.environ.get("SHOPIFY_API_VERSION", "2024-10")

# Back-compat single-store globals — still read directly by anything not yet store-aware.
STORE = os.environ.get("SHOPIFY_STORE_URL", "")
TOKEN = os.environ.get("SHOPIFY_ACCESS_TOKEN", "")

STORES = [
    {"name": "sm", "store": STORE, "token": TOKEN},
    {"name": "sml", "store": os.environ.get("SHOPIFY_STORE_URL_SML", ""),
     "token": os.environ.get("SHOPIFY_ACCESS_TOKEN_SML", "")},
]
STORES = [s for s in STORES if s["store"] and s["token"]]


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def _phone_matches(order: dict, phone: str) -> bool:
    """Compare on the last 10 digits — country-code formatting varies wildly at checkout."""
    want = _digits(phone)[-10:]
    if not want:
        return False
    candidates = [
        order.get("phone"),
        (order.get("customer") or {}).get("phone"),
        (order.get("shipping_address") or {}).get("phone"),
        (order.get("billing_address") or {}).get("phone"),
    ]
    return any(_digits(c)[-10:] == want for c in candidates if c)


def verify_order(order_number: str, phone: str, pack_skus: dict[str, int]) -> list[dict]:
    """Return [{sku, questions, store}] for pack line items on a paid order belonging to
    this phone — checking every configured store, since the customer's "order <number>"
    message doesn't say which brand's store they bought from."""
    if not STORES:
        raise RuntimeError("No Shopify store configured (SHOPIFY_STORE_URL / _SML)")
    for s in STORES:
        grants = _verify_order_on_store(s["store"], s["token"], s["name"], order_number, phone, pack_skus)
        if grants:
            return grants
    return []


def _verify_order_on_store(store: str, token: str, store_name: str, order_number: str,
                           phone: str, pack_skus: dict[str, int]) -> list[dict]:
    url = f"https://{store}/admin/api/{VERSION}/orders.json"
    r = requests.get(url, headers={"X-Shopify-Access-Token": token},
                     params={"name": f"#{order_number}", "status": "any", "limit": 5}, timeout=30)
    r.raise_for_status()
    orders = r.json().get("orders", [])
    if not orders:
        return []

    for order in orders:
        if order.get("financial_status") not in ("paid", "partially_refunded"):
            log.info("order %s (%s) not paid (%s)", order_number, store_name, order.get("financial_status"))
            continue
        if not _phone_matches(order, phone):
            log.info("order %s (%s) phone mismatch for %s", order_number, store_name, phone)
            continue
        grants = []
        for li in order.get("line_items", []):
            handle = _handle_of(li)
            if handle in pack_skus:
                for _ in range(int(li.get("quantity") or 1)):
                    grants.append({"sku": handle, "questions": pack_skus[handle], "store": store_name})
        if grants:
            return grants
    return []


def _handle_of(line_item: dict) -> str:
    """Line items carry no handle, so derive it from the title the same way Shopify does."""
    title = (line_item.get("title") or "").strip().lower()
    return re.sub(r"[^a-z0-9]+", "-", title).strip("-")
