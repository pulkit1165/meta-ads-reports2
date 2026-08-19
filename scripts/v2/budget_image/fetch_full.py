#!/usr/bin/env python3
"""Full daily allocation + performance pull: portals, budgets, audiences, closings.

Per account it collects
  · campaign insights (today, 7d)  — drives the universe, INCLUDING already-paused campaigns
  · adset insights (today)         — lets audience/budget attribution be exact
  · adset metadata                 — daily_budget (ABO), status, custom-audience names
  · campaign metadata              — daily_budget (CBO), status, created_time

Budget rules
  allocated = campaign.daily_budget when set (CBO), else sum of its adsets' daily_budget (ABO)
  active    = the part of that still running right now
  closed    = allocated - active   (what auto-close or the operator switched off today)

Every account's campaign-spend sum is reconciled against its account-level total.
"""
import collections, json, pathlib, sys, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

SP = pathlib.Path(__file__).parent
IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime.now(IST)
TODAY = NOW.date()

import os

REPO = pathlib.Path(__file__).resolve().parents[3]
env = dict(os.environ)                       # CI passes everything as real env vars
for f in (REPO / "config/accounts.env", REPO / ".env",
          pathlib.Path.home() / ".openclaw/workspace/.env"):
    if f.exists():
        for line in f.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                env.setdefault(k.strip(), v.strip().strip('"'))
TOK = env["META_ACCESS_TOKEN"]

ACCTS = [("SM", "SM_FRAGRANCE_01", "SM Fragrance 01"), ("SM", "SM_SKIN", "SM Skin"),
         ("SM", "SM_HAIR", "SM Hair"), ("SM", "SM_CRYSTALS", "SM Crystals"),
         ("SM", "SM_PERFUME", "SM Perfume"), ("SM", "SM_CREDIT_LINE_05", "SM CL 05"),
         ("SM", "SM_CREDIT_LINE_06", "SM CL 06"), ("SM", "N129", "N129"),
         ("SM", "MONEY03", "SM Money 03"),
         ("SML", "SML_SKIN", "SML Skin"), ("SML", "SML_HAIR", "SML Hair"),
         ("SML", "SML_CRYSTALS", "SML Crystals"),
         ("SML", "SML_CL_06", "SML CL 06"), ("SML", "SML_CL_07", "SML CL 07"),
         ("NBP", "NBP_SKIN", "NBP Skin"), ("NBP", "NBP_HAIR_PERFUME", "NBP Hair/Perfume"),
         ("NBP", "NBP_CRYSTALS", "NBP Crystals")]

LIVE_STATES = {"ACTIVE"}


def get(url, params, tries=3):
    u = url + "?" + urllib.parse.urlencode({**params, "access_token": TOK})
    for i in range(tries):
        try:
            return json.load(urllib.request.urlopen(u, timeout=180))
        except urllib.error.HTTPError as e:
            body = e.read()[:200].decode(errors="replace")
            if "rate limit" in body.lower() or e.code == 613:
                return {"__err": "rate-limited"}
            if i == tries - 1:
                return {"__err": f"HTTP {e.code}: {body[:90]}"}
        except Exception as ex:
            if i == tries - 1:
                return {"__err": str(ex)[:90]}
    return {"__err": "unknown"}


def paged(url, params):
    out, d = [], get(url, params)
    if "__err" in d:
        return out, d["__err"]
    while True:
        out += d.get("data", [])
        nxt = (d.get("paging") or {}).get("next")
        if not nxt:
            return out, None
        try:
            d = json.load(urllib.request.urlopen(nxt, timeout=180))
        except Exception:
            return out, "pagination stopped early"


def perf(aid, level, preset):
    key = f"{level}_id"
    data, err = paged(f"https://graph.facebook.com/v21.0/{aid}/insights",
                      {"level": level, "date_preset": preset, "limit": 500,
                       "fields": f"{key},spend,action_values,actions"})
    out = {}
    for r in data:
        rev = sum(float(a.get("value") or 0) for a in (r.get("action_values") or [])
                  if a["action_type"] == "omni_purchase")
        pur = sum(int(float(a.get("value") or 0)) for a in (r.get("actions") or [])
                  if a["action_type"] == "omni_purchase")
        out[r[key]] = {"spend": float(r.get("spend") or 0), "rev": rev, "pur": pur}
    return out, err


def aud_label(t):
    """Readable audience from adset targeting."""
    inc = [c.get("name") or str(c.get("id")) for c in (t.get("custom_audiences") or [])]
    exc = [c.get("name") or str(c.get("id")) for c in (t.get("excluded_custom_audiences") or [])]
    if (t.get("targeting_automation") or {}).get("advantage_audience"):
        inc = inc or ["Advantage+ broad"]
    base = " + ".join(sorted(set(inc))) if inc else "Broad (no CA)"
    if exc:
        base += "  ⊘ " + " , ".join(sorted(set(exc)))
    return base[:110]


campaigns, adsets, notes, checks = [], [], [], []
for portal, key, label in ACCTS:
    aid = env.get(key)
    if not aid:
        continue
    tot = get(f"https://graph.facebook.com/v21.0/{aid}/insights",
              {"date_preset": "today", "fields": "spend"})
    if "__err" in tot:
        notes.append(f"{label}: {tot['__err']}")
        print(f"   {label}: SKIPPED ({tot['__err'][:50]})", file=sys.stderr)
        continue
    acct_today = float((tot.get("data") or [{}])[0].get("spend") or 0)

    c_today, e1 = perf(aid, "campaign", "today")
    c_week, e2 = perf(aid, "campaign", "last_7d")
    if not c_today and not c_week:
        print(f"   {label}: no delivery", file=sys.stderr)
        continue
    a_today, e3 = perf(aid, "adset", "today")
    for e in (e1, e2, e3):
        if e:
            notes.append(f"{label}: {e}")

    cmeta, ec = paged(f"https://graph.facebook.com/v21.0/{aid}/campaigns",
                      {"fields": "id,name,created_time,effective_status,daily_budget",
                       "limit": 400})
    ameta, ea = paged(f"https://graph.facebook.com/v21.0/{aid}/adsets",
                      {"fields": "id,name,campaign_id,daily_budget,effective_status,"
                                 "targeting{custom_audiences,excluded_custom_audiences,"
                                 "targeting_automation}", "limit": 400})
    for e in (ec, ea):
        if e:
            notes.append(f"{label}: {e}")
    cmap = {c["id"]: c for c in cmeta}

    # adset budgets grouped per campaign (ABO)
    abo = collections.defaultdict(lambda: {"alloc": 0.0, "active": 0.0})
    for a in ameta:
        b = float(a.get("daily_budget") or 0) / 100
        if b:
            abo[a["campaign_id"]]["alloc"] += b
            if a.get("effective_status") in LIVE_STATES:
                abo[a["campaign_id"]]["active"] += b

    for cid in set(c_today) | set(c_week):
        m = cmap.get(cid, {})
        cb = float(m.get("daily_budget") or 0) / 100
        st = m.get("effective_status", "UNKNOWN")
        if cb:                                   # CBO — budget sits on the campaign
            alloc = cb
            active = cb if st in LIVE_STATES else 0.0
        else:                                    # ABO — budget sits on the ad sets
            alloc = abo.get(cid, {}).get("alloc", 0.0)
            active = abo.get(cid, {}).get("active", 0.0) if st in LIVE_STATES else 0.0
        created = m.get("created_time")
        created = (datetime.fromisoformat(created).astimezone(IST).date().isoformat()
                   if created else None)
        t = c_today.get(cid, {})
        w = c_week.get(cid, {})
        campaigns.append({
            "portal": portal, "account": label, "id": cid,
            "name": m.get("name") or cid, "created": created,
            "days_active": (TODAY - datetime.fromisoformat(created).date()).days if created else None,
            "status": st, "live": st in LIVE_STATES,
            "budget_alloc": round(alloc, 0), "budget_active": round(active, 0),
            "budget_closed": round(alloc - active, 0),
            "spend_today": round(t.get("spend", 0), 2), "revenue_today": round(t.get("rev", 0), 2),
            "purchases_today": t.get("pur", 0),
            "spend_7d": round(w.get("spend", 0), 2), "revenue_7d": round(w.get("rev", 0), 2),
        })

    for a in ameta:
        p = a_today.get(a["id"])
        b = float(a.get("daily_budget") or 0) / 100
        if not p and not b:
            continue
        if p and p["spend"] <= 0 and not b:
            continue
        cm = cmap.get(a.get("campaign_id"), {})
        st = a.get("effective_status", "UNKNOWN")
        camp_live = cm.get("effective_status") in LIVE_STATES
        adsets.append({
            "portal": portal, "account": label, "id": a["id"],
            "campaign_id": a.get("campaign_id"), "campaign": cm.get("name") or "",
            "name": a.get("name") or "", "audience": aud_label(a.get("targeting") or {}),
            "status": st, "live": st in LIVE_STATES and camp_live,
            "budget_alloc": round(b, 0),
            "budget_active": round(b if (st in LIVE_STATES and camp_live) else 0, 0),
            "spend_today": round((p or {}).get("spend", 0), 2),
            "revenue_today": round((p or {}).get("rev", 0), 2),
            "purchases_today": (p or {}).get("pur", 0),
        })

    got = sum(v["spend"] for v in c_today.values())
    checks.append({"account": label, "account_total": round(acct_today, 2),
                   "campaign_sum": round(got, 2), "drift": round(got - acct_today, 2)})
    flag = "" if abs(got - acct_today) < max(2.0, acct_today * 0.005) else "  <-- DRIFT"
    print(f"   {label:18s} camps {len(c_today):3d} adsets {len(a_today):4d}"
          f"  acct ₹{acct_today:>9,.0f} vs ₹{got:>9,.0f}{flag}", file=sys.stderr)

json.dump({"as_of": NOW.isoformat(), "date": TODAY.isoformat(), "campaigns": campaigns,
           "adsets": adsets, "notes": notes, "checks": checks},
          open(SP / "full.json", "w"), indent=1)

ts = sum(c["spend_today"] for c in campaigns)
tr = sum(c["revenue_today"] for c in campaigns)
ba = sum(c["budget_alloc"] for c in campaigns)
bc = sum(c["budget_closed"] for c in campaigns)
print(f"\ncampaigns {len(campaigns)}  adsets {len(adsets)}")
print(f"allocated ₹{ba:,.0f}  active ₹{ba-bc:,.0f}  closed ₹{bc:,.0f}")
print(f"spend ₹{ts:,.0f}  revenue ₹{tr:,.0f}  ROAS {tr/ts if ts else 0:.2f}")
adset_spend = sum(a["spend_today"] for a in adsets)
print(f"adset spend ₹{adset_spend:,.0f} (vs campaign ₹{ts:,.0f})")
if notes:
    print("NOTES:", "; ".join(notes[:4]))
