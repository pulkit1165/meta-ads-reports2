#!/usr/bin/env python3
"""Hourly: pull today's budget/spend across all ad accounts, render one long PNG,
publish it publicly, and have the Cloudflare worker WhatsApp it to every hourly
subscriber.

  python3 scripts/v2/budget_image/run_hourly.py            # fetch, render, publish, send
  python3 scripts/v2/budget_image/run_hourly.py --no-send  # stop after rendering
  python3 scripts/v2/budget_image/run_hourly.py --to 91…   # single recipient

WhatsApp goes through the worker on purpose: the Whapi token lives only in that
worker as a Cloudflare secret, so nothing here ever needs the credential. The
worker fetches the image server-side, which is why it has to be published to a
public URL first.

Env: META_ACCESS_TOKEN plus the act_* ids (config/accounts.env).
"""
import argparse, json, os, pathlib, subprocess, sys, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

HERE = pathlib.Path(__file__).resolve().parent
IST = timezone(timedelta(hours=5, minutes=30))
PY = sys.executable
WORKER = "https://meta-ads-cron-pinger.pulkit-studdmuffyn.workers.dev"
WORKER_KEY = os.environ.get("WORKER_KEY", "ntnhourly2026")


def step(name, args, required=True):
    print(f"\n=== {name}", flush=True)
    p = subprocess.run([PY, str(HERE / args[0])] + args[1:], cwd=HERE,
                       capture_output=True, text=True, timeout=1800)
    out = (p.stdout or "").strip()
    err = (p.stderr or "").strip()
    if out:
        print(out[-1500:], flush=True)
    if p.returncode != 0:
        print(err[-1200:], file=sys.stderr, flush=True)
        if required:
            sys.exit(f"{name} failed (exit {p.returncode})")
    elif err:
        print(err[-600:], file=sys.stderr, flush=True)
    return p.returncode == 0


def caption():
    """One line that carries the headline even if the image never renders."""
    blob = json.load(open(HERE / "full.json"))
    C = blob["campaigns"]
    uni = [c for c in C if c["spend_today"] > 0 or (c["live"] and c["budget_alloc"] > 0)]
    live = [c for c in uni if c["live"]]
    shut = [c for c in uni if not c["live"] and c["spend_today"] > 0]

    def f(rows):
        s = sum(r["spend_today"] for r in rows)
        rv = sum(r["revenue_today"] for r in rows)
        return sum(r["budget_alloc"] for r in rows), s, (rv / s if s else 0)

    ba, s, roas = f(uni)
    _, _, roas_on = f(live)
    bc, sc, roas_off = f(shut)

    # Headline ROAS must be Shopify sales / Meta spend — the same feed the hourly
    # ROAS image uses — so the two messages never disagree. Pixel is secondary.
    shop = ""
    try:
        import time, urllib.request
        with urllib.request.urlopen(
                "https://roas-live.vercel.app/wa_table.json?t=" + str(int(time.time())),
                timeout=45) as r:
            d = json.loads(r.read().decode())
        sales = sum(float(x.get("sales") or 0) for x in d.get("rows", [])
                    if x.get("website") != "All")
        spend = sum(float(x.get("spend") or 0) for x in d.get("rows", [])
                    if x.get("website") != "All")
        if spend:
            shop = (f"ROAS {sales/spend:.2f} (Shopify Rs {sales/1e5:.2f}L "
                    f"through {d.get('data_through', '')}) · pixel {roas:.2f}")
    except Exception:
        pass
    if not shop:
        shop = f"ROAS {roas:.2f} (Meta-attributed)"

    now = datetime.now(IST).strftime("%d %b %I:%M %p")
    return (f"Budget & closing · {now} IST\n"
            f"Allocated Rs {ba/1e5:.2f}L · spent Rs {s/1e5:.2f}L ({s/ba*100 if ba else 0:.0f}%)\n"
            f"{shop}\n"
            f"Closed today: Rs {bc/1e5:.2f}L @ {roas_off:.2f} pixel ({len(shut)} camps) · "
            f"still running {roas_on:.2f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-send", action="store_true")
    ap.add_argument("--to", default="")
    a = ap.parse_args()

    step("fetch", ["fetch_full.py"])
    # ad sets for any account whose adset call got throttled (audiences + ABO budgets)
    step("patch throttled accounts", ["patch_fragrance.py"], required=False)
    step("render", ["render_report_png.py"])

    png = HERE / "report.png"
    print(f"\nimage: {png} ({png.stat().st_size/1024:.0f} KB)")

    if a.no_send:
        print("--no-send: stopping before WhatsApp")
        return

    print("\n=== publish", flush=True)
    pub = subprocess.run([PY, str(HERE / "publish_image.py")], cwd=HERE,
                         capture_output=True, text=True, timeout=600)
    print((pub.stdout or "").strip()[-400:], flush=True)
    if pub.returncode != 0:
        print((pub.stderr or "")[-600:], file=sys.stderr)
        sys.exit("publish failed — nothing sent")
    img_url = (pub.stdout or "").strip().splitlines()[-1]

    print("\n=== send via worker", flush=True)
    params = {"key": WORKER_KEY, "url": img_url, "caption": caption()}
    if a.to:
        params["to"] = a.to
    # Cloudflare's edge 403s the default urllib User-Agent, so set a real one.
    req = urllib.request.Request(f"{WORKER}/send-image?" + urllib.parse.urlencode(params),
                                 headers={"User-Agent": "ntn-budget-report/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            print(r.read().decode()[:600], flush=True)
    except Exception as e:
        sys.exit(f"worker send failed: {e}")


if __name__ == "__main__":
    main()
