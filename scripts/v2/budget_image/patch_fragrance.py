#!/usr/bin/env python3
"""Re-fetch the ad sets for accounts whose adset call was rate-limited, then merge into full.json.
Backs off between attempts instead of hammering (repeated hammering is what keeps this
account throttled)."""
import collections, json, pathlib, sys, time, urllib.error, urllib.parse, urllib.request

SP = pathlib.Path(__file__).parent
env = {}
for line in (pathlib.Path.home() / ".openclaw/workspace/.env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, _, v = line.partition("=")
        env.setdefault(k.strip(), v.strip().strip('"'))
TOK = env["META_ACCESS_TOKEN"]

blob = json.load(open(SP / "full.json"))
have = {a["account"] for a in blob["adsets"]}
need = [(c["account"], c["portal"]) for c in blob["campaigns"] if c["account"] not in have]
need = sorted(set(need))
KEYS = {"SM Fragrance 01": "SM_FRAGRANCE_01", "SM Skin": "SM_SKIN", "SML Skin": "SML_SKIN",
        "SML Hair": "SML_HAIR", "NBP Skin": "NBP_SKIN", "NBP Hair/Perfume": "NBP_HAIR_PERFUME",
        "SM CL 06": "SM_CREDIT_LINE_06"}
print("accounts missing adsets:", [n for n, _ in need], file=sys.stderr)


def fetch(url, params, label, attempts=5):
    for i in range(attempts):
        u = url + "?" + urllib.parse.urlencode({**params, "access_token": TOK})
        try:
            return json.load(urllib.request.urlopen(u, timeout=180)), None
        except urllib.error.HTTPError as e:
            body = e.read()[:160].decode(errors="replace")
            limited = "request limit" in body.lower() or "rate limit" in body.lower()
            if limited and i < attempts - 1:
                wait = 60 * (i + 1)
                print(f"   {label}: throttled, waiting {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            return None, f"HTTP {e.code}: {body[:80]}"
        except Exception as ex:
            if i == attempts - 1:
                return None, str(ex)[:80]
            time.sleep(20)
    return None, "gave up"


def paged(url, params, label):
    out = []
    d, err = fetch(url, params, label)
    if err:
        return out, err
    while True:
        out += d.get("data", [])
        nxt = (d.get("paging") or {}).get("next")
        if not nxt:
            return out, None
        try:
            d = json.load(urllib.request.urlopen(nxt, timeout=180))
        except Exception:
            time.sleep(30)
            try:
                d = json.load(urllib.request.urlopen(nxt, timeout=180))
            except Exception:
                return out, "pagination stopped early"


def aud_label(t):
    inc = [c.get("name") or str(c.get("id")) for c in (t.get("custom_audiences") or [])]
    exc = [c.get("name") or str(c.get("id")) for c in (t.get("excluded_custom_audiences") or [])]
    if (t.get("targeting_automation") or {}).get("advantage_audience"):
        inc = inc or ["Advantage+ broad"]
    base = " + ".join(sorted(set(inc))) if inc else "Broad (no CA)"
    if exc:
        base += "  ⊘ " + " , ".join(sorted(set(exc)))
    return base[:110]


added, still = 0, []
for label, portal in need:
    key = KEYS.get(label)
    aid = env.get(key) if key else None
    if not aid:
        still.append(label)
        continue
    ins, e1 = paged(f"https://graph.facebook.com/v21.0/{aid}/insights",
                    {"level": "adset", "date_preset": "today", "limit": 500,
                     "fields": "adset_id,spend,action_values,actions"}, label)
    perf = {}
    for r in ins:
        rev = sum(float(a.get("value") or 0) for a in (r.get("action_values") or [])
                  if a["action_type"] == "omni_purchase")
        pur = sum(int(float(a.get("value") or 0)) for a in (r.get("actions") or [])
                  if a["action_type"] == "omni_purchase")
        perf[r["adset_id"]] = {"spend": float(r.get("spend") or 0), "rev": rev, "pur": pur}

    meta, e2 = paged(f"https://graph.facebook.com/v21.0/{aid}/adsets",
                     {"fields": "id,name,campaign_id,daily_budget,effective_status,"
                                "targeting{custom_audiences,excluded_custom_audiences,"
                                "targeting_automation}", "limit": 300}, label)
    if e1 or e2:
        still.append(f"{label} ({e1 or e2})")
        if not meta:
            continue
    cstat = {c["id"]: c["live"] for c in blob["campaigns"]}
    cname = {c["id"]: c["name"] for c in blob["campaigns"]}
    for a in meta:
        p = perf.get(a["id"])
        b = float(a.get("daily_budget") or 0) / 100
        if not p and not b:
            continue
        if p and p["spend"] <= 0 and not b:
            continue
        st = a.get("effective_status", "UNKNOWN")
        clive = cstat.get(a.get("campaign_id"), False)
        blob["adsets"].append({
            "portal": portal, "account": label, "id": a["id"],
            "campaign_id": a.get("campaign_id"), "campaign": cname.get(a.get("campaign_id"), ""),
            "name": a.get("name") or "", "audience": aud_label(a.get("targeting") or {}),
            "status": st, "live": st == "ACTIVE" and clive,
            "budget_alloc": round(b, 0),
            "budget_active": round(b if (st == "ACTIVE" and clive) else 0, 0),
            "spend_today": round((p or {}).get("spend", 0), 2),
            "revenue_today": round((p or {}).get("rev", 0), 2),
            "purchases_today": (p or {}).get("pur", 0),
        })
        added += 1
    print(f"   {label}: +{len(meta)} adsets", file=sys.stderr)

blob["notes"] = [n for n in blob["notes"] if "request limit" not in n]
if still:
    blob["notes"].append("adsets unavailable: " + "; ".join(still))
json.dump(blob, open(SP / "full.json", "w"), indent=1)
print(f"\nadded {added} adset rows | adset spend now ₹"
      f"{sum(a['spend_today'] for a in blob['adsets']):,.0f}"
      f" vs campaign ₹{sum(c['spend_today'] for c in blob['campaigns']):,.0f}")
