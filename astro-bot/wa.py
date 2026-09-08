"""WhatsApp Cloud API send helpers (customer-facing number)."""
from __future__ import annotations

import logging
import os
import requests

log = logging.getLogger(__name__)


def _url(path: str) -> str:
    return f"https://graph.facebook.com/{os.environ.get('WA_GRAPH_VERSION', 'v21.0')}/{path}"


def _headers() -> dict:
    return {"Authorization": f"Bearer {os.environ['WA_ACCESS_TOKEN']}",
            "Content-Type": "application/json"}


def send_text(to: str, body: str) -> dict:
    if len(body) > 4096:
        body = body[:4090] + "\n…"
    payload = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": to,
               "type": "text", "text": {"preview_url": False, "body": body}}
    r = requests.post(_url(f"{os.environ['WA_PHONE_NUMBER_ID']}/messages"),
                      headers=_headers(), json=payload, timeout=30)
    if not r.ok:
        log.error("send_text failed %s %s", r.status_code, r.text[:400])
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else {}


def send_template(to: str, name: str, params: list[str], lang: str = "en") -> dict:
    """Send an approved WhatsApp template message. Unlike send_text, this works even if the
    customer has never messaged us (or not within the last 24h) — the ONLY way to reach someone
    proactively (e.g. right after a Shopify purchase) is a pre-approved template; a free-text
    send_text to a customer outside that 24h window is rejected by Meta outright."""
    payload = {
        "messaging_product": "whatsapp", "to": to, "type": "template",
        "template": {
            "name": name,
            "language": {"code": lang},
            "components": [{"type": "body", "parameters": [{"type": "text", "text": p} for p in params]}],
        },
    }
    r = requests.post(_url(f"{os.environ['WA_PHONE_NUMBER_ID']}/messages"),
                      headers=_headers(), json=payload, timeout=30)
    if not r.ok:
        log.error("send_template failed %s %s", r.status_code, r.text[:400])
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else {}


def mark_read(message_id: str) -> None:
    try:
        requests.post(_url(f"{os.environ['WA_PHONE_NUMBER_ID']}/messages"), headers=_headers(),
                      json={"messaging_product": "whatsapp", "status": "read",
                            "message_id": message_id}, timeout=10)
    except Exception as e:
        log.warning("mark_read failed: %s", e)


def mark_read_and_typing(message_id: str) -> bool:
    """Mark read AND show the WhatsApp typing bubble in one call — Meta's documented combined
    endpoint. The indicator is displayed for ~25s or until a real message is sent, whichever
    comes first, so a long-running answer needs this re-sent periodically to stay visible for
    the whole wait (see server.py's _process, which does this on a loop). Returns True if Meta
    accepted the call, so a caller can stop retrying if the feature is ever unavailable rather
    than hammering a failing endpoint every 15s for a minute-plus generation.
    """
    try:
        r = requests.post(_url(f"{os.environ['WA_PHONE_NUMBER_ID']}/messages"), headers=_headers(),
                          json={"messaging_product": "whatsapp", "status": "read",
                                "message_id": message_id,
                                "typing_indicator": {"type": "text"}}, timeout=10)
        if not r.ok:
            log.warning("typing indicator failed %s %s", r.status_code, r.text[:300])
        return r.ok
    except Exception as e:
        log.warning("typing indicator raised: %s", e)
        return False
