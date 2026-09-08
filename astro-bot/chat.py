#!/usr/bin/env python3
"""Local test harness — the exact production conversation, in your terminal, no WhatsApp.

    ./chat.py                 # start a fresh test customer
    ./chat.py --phone 9198…   # resume / inspect a specific number

Runs the same flow.handle() the webhook calls, so what you read here is what a customer
would receive verbatim. Test-only helpers start with a slash and are NOT customer commands:

    /grant 10     give yourself 10 questions (simulates a verified purchase)
    /facts        show the computed fact pack the model is allowed to use
    /audit        show the guard verdict for every answer so far
    /reset        wipe this test customer and start over
    /quit
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")
_extra = os.environ.get("EXTRA_ENV_FILE")
if _extra and Path(_extra).expanduser().is_file():
    load_dotenv(Path(_extra).expanduser(), override=False)
sys.path.insert(0, str(Path(__file__).parent))

import store, flow, factpack, guard   # noqa: E402

BOLD, DIM, GRN, YEL, RED, RST = "\033[1m", "\033[2m", "\033[32m", "\033[33m", "\033[31m", "\033[0m"


def show_facts(phone: str) -> None:
    u = store.get_user(phone)
    if not (u and u.get("dob")):
        print(f"{YEL}No birth details yet.{RST}")
        return
    pack = factpack.fetch(u)
    print(f"\n{BOLD}Computed fact pack — the only things the model may state:{RST}")
    for f in pack["facts"]:
        print(f"  {DIM}[{f['id']:>3}] {f['topic']:<10}{RST} {f['text']}")
    print(f"\n{DIM}birth time known: {pack['meta']['birthTimeKnown']} | "
          f"houses counted from: {pack['meta']['houseBasis']}{RST}\n")


def show_audit(phone: str) -> None:
    with store.conn() as c:
        rows = c.execute("SELECT topic, guard_status, guard_notes, question FROM questions"
                         " WHERE phone=? ORDER BY id", (phone,)).fetchall()
    if not rows:
        print(f"{YEL}No questions answered yet.{RST}")
        return
    print(f"\n{BOLD}Guard audit{RST}")
    for i, r in enumerate(rows, 1):
        colour = {"clean": GRN, "repaired": YEL, "fallback": RED}.get(r["guard_status"], "")
        print(f"  {i}. [{r['topic']}] {colour}{r['guard_status']}{RST} — {r['question'][:56]}")
        if r["guard_notes"]:
            for note in r["guard_notes"].split("; "):
                print(f"       {DIM}caught: {note}{RST}")
    print()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phone", default="919000000099", help="test customer number")
    ap.add_argument("--fresh", action="store_true", help="wipe this number before starting")
    ap.add_argument("--paywall", action="store_true",
                    help="enforce the question quota (default: off, so you can just chat)")
    args = ap.parse_args()
    phone = args.phone

    store.init()
    if args.fresh:
        with store.conn() as c:
            for t in ("users", "factpacks", "entitlements", "questions", "messages"):
                c.execute(f"DELETE FROM {t} WHERE phone=?", (phone,))

    # The harness exists to judge answer quality, so the paywall is off unless asked for.
    # The bypass lives here and never in flow.py — production always enforces the quota.
    def top_up() -> None:
        if not args.paywall and store.remaining(phone) < 5:
            store.grant(phone, 50, f"#LOCAL-{store.remaining(phone)}-{os.getpid()}",
                        "local-test", source="local")
    top_up()

    backend = os.environ.get("ASTRO_LLM_BACKEND", "claude_cli")
    print(f"{BOLD}Astro bot — local harness{RST}  {DIM}customer +{phone} · backend {backend} · "
          f"{store.remaining(phone)} questions{RST}")
    mode = f"{YEL}paywall ON{RST}" if args.paywall else f"{DIM}paywall off — ask freely{RST}"
    print(f"{DIM}Type a message as the customer. /facts, /audit, /reset, /quit{RST}  ·  {mode}\n")

    while True:
        try:
            msg = input(f"{BOLD}you ▶{RST} ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not msg:
            continue
        if msg in ("/quit", "/q", "/exit"):
            break
        if msg == "/facts":
            show_facts(phone); continue
        if msg == "/audit":
            show_audit(phone); continue
        if msg == "/reset":
            with store.conn() as c:
                for t in ("users", "factpacks", "entitlements", "questions", "messages"):
                    c.execute(f"DELETE FROM {t} WHERE phone=?", (phone,))
            print(f"{YEL}test customer wiped.{RST}\n"); continue
        if msg.startswith("/grant"):
            n = int((msg.split() + ["10"])[1])
            store.grant(phone, n, f"#LOCAL{store.question_count(phone)}", "local-test", source="local")
            print(f"{GRN}granted {n} — balance {store.remaining(phone)}{RST}\n"); continue

        top_up()
        reply = flow.handle(phone, msg)
        shown = reply
        if not args.paywall:
            shown = re.sub(r"\n+— \d+ questions? left$", "", shown)
            shown = re.sub(r"\n+You have \d+ questions? ready to ask\. Go ahead\. 🙏$", "", shown)
        print(f"\n{GRN}bot ◀{RST} {shown}\n")
        # Re-verify what was just sent, so the harness proves the guarantee rather than asserting it.
        u = store.get_user(phone)
        if u and u.get("dob"):
            try:
                v = guard.dedupe(guard.verify(reply, factpack.fetch(u)))
                print(f"{DIM}guard: {'clean — every claim matches the chart' if not v else v}{RST}\n")
            except Exception:
                pass


if __name__ == "__main__":
    main()
