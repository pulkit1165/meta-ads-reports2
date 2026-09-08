"""Flask webhook for the customer-facing astro bot.

Deliberately separate from whatsapp-bot/ (the internal ops bot): that one is allowlisted to
the team and can run repo scripts; this one talks to paying strangers and can do neither.
"""
from __future__ import annotations

import concurrent.futures
import logging
import os
import sys
import threading
import time
from collections import defaultdict, deque
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, request, jsonify, abort

load_dotenv(Path(__file__).parent / ".env")
_extra = os.environ.get("EXTRA_ENV_FILE")
if _extra and Path(_extra).expanduser().is_file():
    load_dotenv(Path(_extra).expanduser(), override=False)

sys.path.insert(0, str(Path(__file__).parent))
import wa               # noqa: E402
import store            # noqa: E402
import flow             # noqa: E402
import shopify_webhook  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
    handlers=[logging.FileHandler(os.environ.get("LOG_FILE", "astro-bot.log")),
              logging.StreamHandler()],
)
log = logging.getLogger("astro-bot")

app = Flask(__name__)

# Meta retries webhooks aggressively; a retry must not bill a second question.
_seen_ids: deque[str] = deque(maxlen=2000)
_seen_lock = threading.Lock()
# One conversation at a time per customer, so two fast messages can't double-spend quota.
_locks: dict[str, threading.Lock] = defaultdict(threading.Lock)
_rate: dict[str, deque] = defaultdict(lambda: deque(maxlen=20))
RATE_LIMIT, RATE_WINDOW = 12, 60.0


def _rate_ok(phone: str) -> bool:
    now = time.time()
    q = _rate[phone]
    while q and now - q[0] > RATE_WINDOW:
        q.popleft()
    if len(q) >= RATE_LIMIT:
        return False
    q.append(now)
    return True


def _process(sender: str, text: str, message_id: str) -> None:
    try:
        wa.mark_read_and_typing(message_id)
    except Exception:
        pass
    store.log_message(sender, "in", text)

    def _run() -> str:
        with _locks[sender]:
            try:
                return flow.handle(sender, text)
            except Exception:
                log.exception("flow crashed for %s", sender)
                return ("Something went wrong on my side. Please send your message again in a "
                        "minute — nothing has been counted against your pack. 🙏")

    # The dual-gate answer pipeline can run 40-150s+. WhatsApp's typing bubble only holds for
    # ~25s per call, so we poll the worker and re-send the indicator every 18s (safely inside
    # that window) until it's done — the customer sees "typing..." continuously instead of
    # dead silence, which is what made an in-progress answer look like the bot had stopped.
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        future = ex.submit(_run)
        while True:
            try:
                reply = future.result(timeout=18)
                break
            except concurrent.futures.TimeoutError:
                try:
                    wa.mark_read_and_typing(message_id)
                except Exception:
                    pass

    store.log_message(sender, "out", reply)
    try:
        wa.send_text(sender, reply)
    except Exception:
        log.exception("send failed for %s", sender)


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True, "backend": os.environ.get("ASTRO_LLM_BACKEND", "claude_cli")})


@app.get("/webhook")
def verify():
    mode, token, challenge = (request.args.get("hub.mode"), request.args.get("hub.verify_token"),
                              request.args.get("hub.challenge"))
    if mode == "subscribe" and token and token == os.environ.get("WA_VERIFY_TOKEN"):
        log.info("webhook verified")
        return challenge or "", 200
    abort(403)


@app.post("/webhook")
def event():
    payload = request.get_json(silent=True) or {}
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            for msg in (change.get("value", {}) or {}).get("messages", []):
                mid = msg.get("id", "")
                with _seen_lock:
                    if mid in _seen_ids:
                        log.info("duplicate webhook %s ignored", mid)
                        continue
                    _seen_ids.append(mid)
                sender = (msg.get("from") or "").lstrip("+")
                if msg.get("type") != "text":
                    threading.Thread(target=wa.send_text, args=(
                        sender, "Please send your question as a text message. 🙏"),
                        daemon=True).start()
                    continue
                text = (msg.get("text", {}) or {}).get("body", "")
                if not _rate_ok(sender):
                    log.warning("rate limited %s", sender)
                    continue
                log.info("← %s: %s", sender, text[:100].replace("\n", " "))
                threading.Thread(target=_process, args=(sender, text, mid), daemon=True).start()
    return jsonify({"status": "received"}), 200


@app.post("/shopify-webhook")
def shopify_order_webhook():
    raw = request.get_data()
    sig = request.headers.get("X-Shopify-Hmac-Sha256", "")
    token = request.args.get("token", "")
    if not shopify_webhook.verify_request(raw, sig, token):
        log.warning("shopify webhook: verification failed")
        abort(401)
    order = request.get_json(silent=True) or {}
    log.info("shopify webhook: %s for order %s", request.headers.get("X-Shopify-Topic", "?"),
             order.get("name"))
    threading.Thread(target=shopify_webhook.handle_order_paid, args=(order,), daemon=True).start()
    return jsonify({"ok": True}), 200


if __name__ == "__main__":
    store.init()
    missing = [k for k in ("WA_PHONE_NUMBER_ID", "WA_ACCESS_TOKEN", "WA_VERIFY_TOKEN")
               if not os.environ.get(k)]
    if missing:
        log.error("missing env: %s — copy .env.example to .env", missing)
        sys.exit(1)
    port = int(os.environ.get("PORT", "8090"))
    log.info("astro-bot on :%d backend=%s", port, os.environ.get("ASTRO_LLM_BACKEND", "claude_cli"))
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
