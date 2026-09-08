"""Shopify 'orders/paid' webhook receiver — auto-grants question-pack quota the moment a
customer pays, instead of requiring them to text "order <number>" back to the bot.

Security: every request must prove it's genuinely from Shopify before this module ever sees
the body — server.py must reject anything that fails verify_request() first. Two independent
checks are supported, either one sufficient on its own:

  1. A secret token in the webhook URL itself (?token=...), checked against
     SHOPIFY_WEBHOOK_TOKEN. This is a token WE generated ourselves and embedded when
     registering the webhook via the Admin API (register_webhook.py) — it doesn't require
     anything from Shopify's side, which matters because the merchant's "Client secret" (the
     value Shopify's own X-Shopify-Hmac-Sha256 signing normally needs) isn't retrievable via
     API at all, only from the Shopify Admin UI. As long as this URL is never logged or shared
     anywhere public, knowing it is equivalent to being Shopify.
  2. X-Shopify-Hmac-Sha256, Shopify's own signature over the raw body, keyed by
     SHOPIFY_WEBHOOK_SECRET — supported too in case that Client Secret is ever supplied later,
     as a stronger, independent second layer. Not required for check 1 to work.

Without at least one of these passing, anyone who found the endpoint URL could forge a "paid"
webhook and grant themselves free questions.

Delivery is at-least-once (Shopify may redeliver the same webhook) — store.grant()'s
UNIQUE(phone, order_name, sku) constraint already makes granting idempotent, same as the
manual "order <number>" path in flow.py, so no extra dedup is needed here.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import re
import time

import flow
import shopify_verify
import store
import wa

log = logging.getLogger(__name__)

# UTILITY-category template, submitted separately for Meta approval — see ASTRO_ORDER_TEMPLATE.
# Body must take exactly 2 params in this order: (order number, questions unlocked).
ORDER_TEMPLATE_NAME = os.environ.get("ASTRO_ORDER_TEMPLATE", "astro_order_confirmed")


def verify_request(raw_body: bytes, header_hmac: str, query_token: str) -> bool:
    token = os.environ.get("SHOPIFY_WEBHOOK_TOKEN", "")
    if token and query_token and hmac.compare_digest(query_token, token):
        return True
    return _verify_signature(raw_body, header_hmac)


def _verify_signature(raw_body: bytes, header_hmac: str) -> bool:
    secret = os.environ.get("SHOPIFY_WEBHOOK_SECRET", "")
    if not secret or not header_hmac:
        return False
    digest = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).digest()
    computed = base64.b64encode(digest).decode()
    return hmac.compare_digest(computed, header_hmac)


def _normalize_phone(raw: str | None) -> str | None:
    """Shopify checkout phone fields come in wildly inconsistent formats ("+91 98765 43210",
    "9876543210", "+919876543210"...). Every customer here is Indian (same assumption flow.py's
    date parser already makes), so: strip to digits, take the last 10, prefix the country code —
    matching the "91XXXXXXXXXX, no plus" format used everywhere else (users.phone, wa.send_text's
    `to`)."""
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) < 10:
        return None
    return "91" + digits[-10:]


def _recently_messaged(phone: str) -> bool:
    """WhatsApp only allows a free-text send within 24h of the customer's last inbound message;
    outside that window only an approved template can reach them."""
    with store.conn() as c:
        row = c.execute("SELECT ts FROM messages WHERE phone=? AND direction='in' "
                        "ORDER BY ts DESC LIMIT 1", (phone,)).fetchone()
    return bool(row) and (time.time() - row["ts"]) < 24 * 3600


def _notify(phone: str, order_no: str, total: int) -> None:
    """Reaching out unprompted (the customer didn't just type "order <number>" themselves) is
    a cold message landing out of nowhere — naming them up front makes it read as a genuine,
    targeted confirmation rather than a bulk blast, so this path greets by name when we already
    know it (returning customer) unlike the manual order-command reply, which is already
    mid-conversation and doesn't need one."""
    if _recently_messaged(phone):
        user = store.get_user(phone) or {}
        name = (user.get("name") or "").split()[0] if user.get("name") else ""
        greeting = flow.t(user, "order_greeting", name=name) if name else ""
        msg = flow.t(user, "order_unlocked", total=total, order_no=order_no, greeting=greeting,
                    remaining=store.remaining(phone), nudge="")
        wa.send_text(phone, msg)
    else:
        # Meta's approved template has no name slot and is English-only — a customer outside
        # the 24h free-text window (new, or returning after a gap) gets this regardless of any
        # stored language/name preference. Submitting a personalized/Hindi template variant is
        # a known follow-up, not yet done.
        wa.send_template(phone, ORDER_TEMPLATE_NAME, [f"#{order_no}", str(total)])


def handle_order_paid(order: dict) -> None:
    """Runs in a background thread after signature verification (server.py) — Shopify expects
    a fast 200, and this does at least one WhatsApp API call plus DB writes."""
    if order.get("financial_status") not in ("paid", "partially_refunded"):
        return
    raw_phone = (order.get("phone") or (order.get("customer") or {}).get("phone")
                or (order.get("shipping_address") or {}).get("phone")
                or (order.get("billing_address") or {}).get("phone"))
    phone = _normalize_phone(raw_phone)
    if not phone:
        log.warning("shopify webhook: order %s paid but no usable phone found", order.get("name"))
        return

    order_no = re.sub(r"\D", "", order.get("name") or "") or str(order.get("id"))
    total = 0
    for li in order.get("line_items", []):
        handle = shopify_verify._handle_of(li)
        if handle in flow.PACK_SKUS:
            for _ in range(int(li.get("quantity") or 1)):
                if store.grant(phone, flow.PACK_SKUS[handle], f"#{order_no}", handle,
                               source="shopify-webhook"):
                    total += flow.PACK_SKUS[handle]

    if total == 0:
        return  # not a pack order, or this order's pack line items were already granted
    log.info("shopify webhook: granted %d questions to %s from order #%s", total, phone, order_no)
    try:
        _notify(phone, order_no, total)
    except Exception:
        log.exception("shopify webhook: notify failed for %s order #%s (quota already granted)",
                      phone, order_no)
