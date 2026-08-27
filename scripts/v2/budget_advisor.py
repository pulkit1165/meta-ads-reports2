#!/usr/bin/env python3
"""
Budget Advisor — daily push / reactivate / close decisions.

Answers four questions each morning:
  1. Can I push budget tomorrow?      (learning-phase saturation)
  2. What can I reactivate at ROAS X? (paused campaigns above your bar)
  3. What can I close today?          (and still hit the order target)
  4. Is my approach earning INCREMENTAL roas? (marginal, not average)

Usage:
  python3 budget_advisor.py --target-orders 1200 --reactivate-roas 1.5
  python3 budget_advisor.py --portal NBP --target-orders 600 --reactivate-roas 2.0
"""
import os, sys, json, time, argparse, urllib.request, urllib.parse, re, statistics, math
from datetime import datetime, timedelta, timezone
from collections import defaultdict

IST = timezone(timedelta(hours=5, minutes=30))
ENVP = os.path.expanduser("~/.openclaw/workspace/.env")
OUT = os.path.expanduser("~/Downloads/budget_advisor")

def load_env():
    e = {}
    for line in open(ENVP):
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1); e[k] = v
    return e

ENV = load_env()
TOK = ENV["META_ACCESS_TOKEN"]

def portal_of(name):
    if name.startswith("SM_"): return "SM"
    if name.startswith("NBP_"): return "NBP"
    if name.startswith("SML_"): return "SML"
    return None

ACCOUNTS = {k: v for k, v in ENV.items() if v.startswith("act_") and portal_of(k)}
SHOPS = {
    "SM":  (ENV.get("SHOPIFY_STORE_URL"),     ENV.get("SHOPIFY_ACCESS_TOKEN")),
    "NBP": (ENV.get("SHOPIFY_STORE_URL_NBP"), ENV.get("SHOPIFY_ACCESS_TOKEN_NBP")),
    "SML": (ENV.get("SHOPIFY_STORE_URL_SML"), ENV.get("SHOPIFY_ACCESS_TOKEN_SML")),
}

# ---------- api helpers ----------
def api(url, tries=5):
    for a in range(tries):
        try:
            return json.load(urllib.request.urlopen(url, timeout=120))
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:200]
            if e.code in (429, 500, 502, 503) or '"code":17' in body or '"code":80004' in body:
                time.sleep(15 * (a + 1)); continue
            return {"__err": body}
        except Exception:
            time.sleep(8)
    return {}

def paged(url, cap=40):
    out, p = [], 0
    while url and p < cap:
        d = api(url)
        out += d.get("data", [])
        url = (d.get("paging") or {}).get("next")
        p += 1; time.sleep(0.2)
    return out

def roas_of(r):
    for x in (r.get("purchase_roas") or []):
        if x.get("action_type") in ("omni_purchase", "purchase"):
            return float(x.get("value", 0))
    pr = r.get("purchase_roas") or []
    return float(pr[0]["value"]) if pr else 0.0

def revenue_of(r):
    for a in (r.get("action_values") or []):
        if a.get("action_type") == "omni_purchase": return float(a.get("value", 0))
    for a in (r.get("action_values") or []):
        if a.get("action_type") == "purchase": return float(a.get("value", 0))
    return float(r.get("spend", 0)) * roas_of(r)

def purchases_of(r):
    for a in (r.get("actions") or []):
        if a.get("action_type") == "omni_purchase": return int(float(a.get("value", 0)))
    for a in (r.get("actions") or []):
        if a.get("action_type") == "purchase": return int(float(a.get("value", 0)))
    return 0

def tr(since, until):
    return urllib.parse.quote(json.dumps({"since": since, "until": until}))

# ---------- pulls ----------
def active_accounts(accounts, days=7):
    """Skip accounts with no spend recently — most of the 15 are dormant."""
    now = datetime.now(IST).date()
    since = (now - timedelta(days=days)).isoformat()
    live = {}
    for nm, acct in accounts.items():
        d = api(f"https://graph.facebook.com/v21.0/{acct}/insights?fields=spend"
                f"&time_range={tr(since, now.isoformat())}&access_token={urllib.parse.quote(TOK)}")
        sp = sum(float(r.get("spend", 0)) for r in d.get("data", []))
        if sp > 0: live[nm] = acct
        time.sleep(0.15)
    return live


def pull_learning(accounts):
    """Learning stage for adsets that actually spent today (fast path).

    Fetching every active adset is hopeless on accounts with thousands of them,
    and adsets with no spend today cannot affect today's learning ratio anyway.
    """
    today = datetime.now(IST).date().isoformat()
    rows = []
    for nm, acct in accounts.items():
        ins = [r for r in paged(
            f"https://graph.facebook.com/v21.0/{acct}/insights?level=adset&fields=adset_id,adset_name,"
            f"spend,purchase_roas,actions,action_values&time_range={tr(today, today)}"
            f"&limit=500&access_token={urllib.parse.quote(TOK)}") if r.get("adset_id")]
        ins = [r for r in ins if float(r.get("spend", 0)) > 0]
        ids = [r["adset_id"] for r in ins]
        meta = {}
        for i in range(0, len(ids), 45):
            m = api(f"https://graph.facebook.com/v21.0/?ids={','.join(ids[i:i+45])}"
                    f"&fields=id,name,campaign_id,effective_status,daily_budget,learning_stage_info"
                    f"&access_token={urllib.parse.quote(TOK)}")
            if isinstance(m, dict):
                meta.update({k: v for k, v in m.items() if isinstance(v, dict) and "id" in v})
            time.sleep(0.2)
        for r in ins:
            m = meta.get(r["adset_id"], {})
            li = m.get("learning_stage_info") or {}
            rows.append(dict(portal=portal_of(nm), acct=nm, adset_id=r["adset_id"],
                             name=m.get("name", r.get("adset_name", "")),
                             campaign_id=m.get("campaign_id"),
                             stage=li.get("status", "UNKNOWN"),
                             conversions=li.get("conversions", 0),
                             last_edit=li.get("last_sig_edit_ts"),
                             budget=float(m.get("daily_budget") or 0) / 100,
                             spend_today=float(r.get("spend", 0)),
                             rev_today=revenue_of(r)))
        print(f"  learning: {nm} {len(ins)} adsets spending today", flush=True)
    return rows

def pull_campaigns(accounts, days_back=30):
    """Campaign meta + windows: today, yesterday, 7d, 30d."""
    now = datetime.now(IST).date()
    today = now.isoformat(); yday = (now - timedelta(days=1)).isoformat()
    d7s = (now - timedelta(days=7)).isoformat(); d7e = yday
    d30s = (now - timedelta(days=days_back)).isoformat()
    out = {}
    for nm, acct in accounts.items():
        wins = {}
        for label, (s, u) in {"today": (today, today), "yday": (yday, yday),
                              "d7": (d7s, d7e), "d30": (d30s, yday)}.items():
            wins[label] = {r["campaign_id"]: r for r in paged(
                f"https://graph.facebook.com/v21.0/{acct}/insights?level=campaign&fields=campaign_id,"
                f"campaign_name,spend,purchase_roas,actions,action_values&time_range={tr(s,u)}"
                f"&limit=400&access_token={urllib.parse.quote(TOK)}") if r.get("campaign_id")}
        ids = set()
        for w in wins.values(): ids |= set(w)
        meta = {}
        idl = sorted(ids)
        for i in range(0, len(idl), 40):
            m = api(f"https://graph.facebook.com/v21.0/?ids={','.join(idl[i:i+40])}"
                    f"&fields=id,name,effective_status,daily_budget,lifetime_budget,created_time,updated_time"
                    f"&access_token={urllib.parse.quote(TOK)}")
            if isinstance(m, dict):
                meta.update({k: v for k, v in m.items() if isinstance(v, dict) and "id" in v})
            time.sleep(0.2)
        for cid in ids:
            m = meta.get(cid, {})
            rec = dict(portal=portal_of(nm), acct=nm, id=cid, name=m.get("name", ""),
                       status=m.get("effective_status", "?"),
                       budget=float(m.get("daily_budget") or m.get("lifetime_budget") or 0) / 100,
                       created=(m.get("created_time") or "")[:10],
                       updated=(m.get("updated_time") or "")[:10])
            for label in ("today", "yday", "d7", "d30"):
                r = wins[label].get(cid, {})
                rec[label] = dict(spend=float(r.get("spend", 0)), rev=revenue_of(r) if r else 0.0,
                                  orders=purchases_of(r) if r else 0)
            out[cid] = rec
        print(f"  campaigns: {nm} {len(ids)}", flush=True)
    return out

def pull_shopify(portal, days=14):
    dom, tok = SHOPS.get(portal, (None, None))
    if not dom: return {}
    since = (datetime.now(IST) - timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)
    url = (f"https://{dom}/admin/api/2024-10/orders.json?status=any&limit=250"
           f"&created_at_min={urllib.parse.quote(since.isoformat())}"
           f"&fields=id,created_at,total_price,cancelled_at")
    day = defaultdict(lambda: [0, 0.0]); hourly = defaultdict(lambda: defaultdict(int))
    while url:
        req = urllib.request.Request(url, headers={"X-Shopify-Access-Token": tok})
        body = None
        for a in range(5):
            try:
                r = urllib.request.urlopen(req, timeout=90); body = r.read()
                link = r.headers.get("Link", ""); break
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503): time.sleep(3 * (a + 1)); continue
                return dict(day=dict(day), hourly={k: dict(v) for k, v in hourly.items()})
            except Exception:
                time.sleep(5)
        if body is None: break
        d = json.loads(body)
        for o in d.get("orders", []):
            if o.get("cancelled_at"): continue
            dt = datetime.fromisoformat(o["created_at"].replace("Z", "+00:00")).astimezone(IST)
            k = dt.date().isoformat()
            day[k][0] += 1; day[k][1] += float(o.get("total_price") or 0)
            hourly[k][dt.hour] += 1
        m = re.search(r'<([^>]+)>;\s*rel="next"', link or "")
        url = m.group(1) if m else None
        time.sleep(0.4)
    return dict(day=dict(day), hourly={k: dict(v) for k, v in hourly.items()})

# ---------- analytics ----------
def learning_ratio(rows, portal=None):
    """Learning share of spend that will STILL BE RUNNING tomorrow.

    Meta drops learning_stage_info.status the moment an adset stops delivering,
    so adsets whose campaign was auto-closed today come back as UNKNOWN. Counting
    that dead spend in the denominator understates the true ratio badly (14% vs
    26% on 27 Aug), so it is excluded — money already killed cannot destabilise
    tomorrow's delivery.
    """
    LIVE = ("SUCCESS", "LEARNING", "LEARNING_LIMITED", "FAIL")
    rows = [r for r in rows if not portal or r["portal"] == portal]
    live = [r for r in rows if r["stage"] in LIVE]
    dead = [r for r in rows if r["stage"] not in LIVE]
    tot = sum(r["spend_today"] for r in live)
    lrn = [r for r in live if r["stage"].startswith("LEARNING")]
    lspend = sum(r["spend_today"] for r in lrn)
    return dict(spend_live=tot, spend_learning=lspend,
                spend_killed_today=sum(r["spend_today"] for r in dead),
                ratio=(lspend / tot if tot else 0),
                n_learning=len(lrn), n_live=len(live), n_killed=len(dead),
                learning_adsets=[dict(name=r["name"], portal=r["portal"],
                                      spend=round(r["spend_today"]), conv=r.get("conversions", 0))
                                 for r in sorted(lrn, key=lambda x: x["spend_today"])])

def learning_economics(camps, portal=None):
    """Minimum viable budget for an adset to escape learning.

    Meta graduates an adset at ~50 conversions in 7 days, so the floor is
    50 x CAC / 7 per day. Anything funded under that can never graduate and
    burns money indefinitely.
    """
    cs = [c for c in camps.values() if not portal or c["portal"] == portal]
    spend7 = sum(c["d7"]["spend"] for c in cs)
    orders7 = sum(c["d7"]["orders"] for c in cs)
    cac = spend7 / orders7 if orders7 else 0
    return dict(cac=round(cac), orders_per_day=round(orders7 / 7),
                min_per_adset_day=round(50 * cac / 7) if cac else 0,
                weekly_conversions=orders7,
                capacity_adsets=round(orders7 * 0.20 / 50) if orders7 else 0)

def fit_response(spend_day, shop_day):
    """Power-law ad response: revenue = a * spend^b.

    b is the elasticity, so MARGINAL roas = b x average roas. b < 1 means
    diminishing returns; b near 0 means revenue does not respond to spend at all.
    """
    days = sorted(set(spend_day) & set(shop_day))
    pts = []
    for d in days:
        sp = spend_day.get(d, 0)
        rv = shop_day[d][1] if isinstance(shop_day[d], (list, tuple)) else shop_day[d]
        if sp > 1000 and rv > 0: pts.append((sp, rv))
    if len(pts) < 6:
        return dict(ok=False, reason=f"only {len(pts)} usable days")
    X = [math.log(p[0]) for p in pts]; Y = [math.log(p[1]) for p in pts]
    mx = sum(X) / len(X); my = sum(Y) / len(Y)
    den = sum((x - mx) ** 2 for x in X)
    if den == 0: return dict(ok=False, reason="spend never varied")
    b = sum((x - mx) * (y - my) for x, y in zip(X, Y)) / den
    a = math.exp(my - b * mx)
    yh = [math.log(a) + b * x for x in X]
    ss_res = sum((y - q) ** 2 for y, q in zip(Y, yh))
    ss_tot = sum((y - my) ** 2 for y in Y)
    r2 = 1 - ss_res / ss_tot if ss_tot else 0
    lo = min(p[0] for p in pts); hi = max(p[0] for p in pts)
    cur = sum(p[0] for p in pts[-3:]) / min(3, len(pts))
    conf = "strong" if (r2 >= .6 and hi / lo >= 1.5) else ("weak" if r2 >= .25 else "none")
    return dict(ok=True, a=a, b=round(b, 3), r2=round(r2, 2), n=len(pts),
                spend_lo=round(lo), spend_hi=round(hi), cur_spend=round(cur),
                variation=round(100 * (hi / lo - 1)), confidence=conf,
                avg_roas=round((a * cur ** b) / cur, 2) if cur else 0,
                marginal_roas=round(b * (a * cur ** b) / cur, 2) if cur else 0)


def learning_penalty(camps, ref_date=None):
    """How much worse a campaign performs while still in learning — measured, not assumed."""
    from datetime import date as _d
    today = ref_date or datetime.now(IST).date()
    buckets = {"new": [0.0, 0.0], "settling": [0.0, 0.0], "mature": [0.0, 0.0]}
    for c in camps.values():
        w = c["d7"]
        if w["spend"] < 3000: continue
        try:
            y, m, dd = map(int, c["created"].split("-")); age = (today - _d(y, m, dd)).days
        except Exception:
            continue
        k = "new" if age < 7 else ("settling" if age < 21 else "mature")
        buckets[k][0] += w["spend"]; buckets[k][1] += w["rev"]
    out = {}
    for k, (sp, rv) in buckets.items():
        out[k] = dict(spend=round(sp), roas=round(rv / sp, 2) if sp else 0)
    base = out["mature"]["roas"] or 1
    out["discount_new"] = round((out["new"]["roas"] / base), 2) if base else 1
    out["discount_settling"] = round((out["settling"]["roas"] / base), 2) if base else 1
    return out

def optimal_push(fit, bar, max_step=20.0):
    """Solve for the spend level where marginal ROAS equals `bar`.

    marginal(S) = b*a*S^(b-1)  =>  S* = (bar/(a*b))^(1/(b-1))
    Returns the recommended move, clamped to +/-max_step because a budget edit
    beyond ~20% resets learning and because the curve should not be extrapolated far.
    """
    if not fit.get("ok"): return dict(ok=False, reason=fit.get("reason", "no fit"))
    a, b, S = fit["a"], fit["b"], fit["cur_spend"]
    if b <= 0:
        return dict(ok=True, solvable=False, pct=0.0, reason="spend and revenue are uncorrelated — adding budget does nothing",
                    marginal_now=fit["marginal_roas"], cur_spend=S)
    if b >= 1:
        return dict(ok=True, solvable=False, pct=max_step, reason="increasing returns in the fit — treat with suspicion",
                    marginal_now=fit["marginal_roas"], cur_spend=S)
    Sstar = (bar / (a * b)) ** (1 / (b - 1))
    raw = 100.0 * (Sstar / S - 1)
    pct = max(-max_step, min(max_step, raw))
    S2 = S * (1 + pct / 100.0)
    marg_after = b * a * S2 ** (b - 1)
    return dict(ok=True, solvable=True, pct=round(pct, 1), raw_pct=round(raw, 1),
                target_spend=round(Sstar), cur_spend=S, bar=bar,
                marginal_now=fit["marginal_roas"], marginal_after=round(marg_after, 2),
                clamped=abs(raw) > max_step,
                delta_spend=round(S2 - S),
                delta_revenue=round(a * S2 ** b - a * S ** b))



def closure_audit(camps, protect_roas=1.0):
    """Is auto-close cutting too deep?

    The true optimum delivery rate is not computable — what a closed campaign
    WOULD have earned had it kept running is unobservable, and any full-day
    delivery factor estimated from this data is contaminated by the closures
    themselves. What IS observable is how many campaigns were closed today
    despite a healthy 7-day record. Those are the ones to protect.
    """
    ran = [c for c in camps.values() if c["today"]["spend"] > 0]
    closed = [c for c in ran if c["status"] != "ACTIVE"]
    active = [c for c in ran if c["status"] == "ACTIVE"]
    def r7(c): return c["d7"]["rev"] / c["d7"]["spend"] if c["d7"]["spend"] else 0
    fp = [c for c in closed if r7(c) >= protect_roas]
    alloc = sum(c["budget"] for c in ran)
    spent = sum(c["today"]["spend"] for c in ran)
    # what the protected set would plausibly have spent, at the same budget
    # utilisation the surviving campaigns are showing today
    util = (sum(c["today"]["spend"] for c in active) / sum(c["budget"] for c in active)) if active else 0
    would = sum(c["budget"] * util for c in fp)
    already = sum(c["today"]["spend"] for c in fp)
    recovered = max(0.0, would - already)
    bands = {}
    for lo, hi, k in ((0, .5, "<0.5"), (.5, 1, "0.5-1.0"), (1, 1.5, "1.0-1.5"),
                      (1.5, 2, "1.5-2.0"), (2, 99, ">=2.0")):
        sel = [c for c in closed if lo <= r7(c) < hi]
        bands[k] = dict(n=len(sel), budget=round(sum(c["budget"] for c in sel)))
    return dict(protect_roas=protect_roas,
                closed_n=len(closed), closed_budget=round(sum(c["budget"] for c in closed)),
                false_positive_n=len(fp), false_positive_budget=round(sum(c["budget"] for c in fp)),
                bands=bands, util=round(util, 2),
                delivery_now=round(spent / alloc, 3) if alloc else 0,
                delivery_if_protected=round((spent + recovered) / alloc, 3) if alloc else 0,
                recovered_spend=round(recovered),
                worst=[dict(name=c["name"], portal=c["portal"], roas7=round(r7(c), 2),
                            budget=round(c["budget"]), spent_today=round(c["today"]["spend"]))
                       for c in sorted(fp, key=lambda x: -x["budget"])[:8]])

def morning_allocation(camps, portal=None, window="yday"):
    """What you actually put on the table at the start of the day.

    The live "ACTIVE budget" is a mid-day artefact — auto-close removes roughly
    half of the morning allocation before evening, so sizing tomorrow's push off
    it would systematically under-allocate. The honest base is the budget attached
    to every campaign that ran that day, and the delivery rate is what fraction of
    it actually converted into spend.
    """
    cs = [c for c in camps.values() if not portal or c["portal"] == portal]
    ran = [c for c in cs if c[window]["spend"] > 0]
    alloc = sum(c["budget"] for c in ran)
    spent = sum(c[window]["spend"] for c in ran)
    still_active = sum(c["budget"] for c in ran if c["status"] == "ACTIVE")
    return dict(window=window, allocated=round(alloc), spent=round(spent),
                campaigns=len(ran), still_active_budget=round(still_active),
                closed_budget=round(alloc - still_active),
                closed_pct=round(100 * (alloc - still_active) / alloc) if alloc else 0,
                delivery_rate=round(spent / alloc, 3) if alloc else 0)

def recommend_allocation(fit, morn, bar, max_step=20.0):
    """Translate 'optimal spend' into 'what to allocate tomorrow morning'."""
    o = optimal_push(fit, bar, max_step)
    dr = morn["delivery_rate"] or 1
    if not o.get("ok"):
        return dict(ok=False, reason=o.get("reason"))
    if not o.get("solvable"):
        return dict(ok=True, solvable=False, reason=o.get("reason"),
                    allocate=morn["allocated"], pct=0.0,
                    marginal_now=o.get("marginal_now"), delivery_rate=dr)
    target_spend = o["cur_spend"] * (1 + o["pct"] / 100.0)
    allocate = target_spend / dr
    pct_alloc = 100.0 * (allocate / morn["allocated"] - 1) if morn["allocated"] else 0
    return dict(ok=True, solvable=True, pct=round(pct_alloc, 1), spend_pct=o["pct"],
                allocate=round(allocate), allocated_now=morn["allocated"],
                target_spend=round(target_spend), spend_now=o["cur_spend"],
                delivery_rate=dr, marginal_now=o["marginal_now"],
                marginal_after=o["marginal_after"], clamped=o["clamped"],
                raw_pct=o.get("raw_pct"), delta_spend=o["delta_spend"],
                delta_revenue=o["delta_revenue"])

def learning_headroom(econ, lr, penalty):
    """How much NEW money can enter learning tomorrow, and what it will return."""
    cap_spend = econ["capacity_adsets"] * econ["min_per_adset_day"]
    stuck = [x for x in lr["learning_adsets"] if x["spend"] < econ["min_per_adset_day"]]
    stuck_spend = sum(x["spend"] for x in stuck)
    free_now = max(0, cap_spend - lr["spend_learning"])
    free_after_fix = max(0, cap_spend - (lr["spend_learning"] - stuck_spend))
    return dict(capacity_spend=round(cap_spend), in_learning=round(lr["spend_learning"]),
                headroom_now=round(free_now), headroom_after_fixing_stuck=round(free_after_fix),
                stuck_count=len(stuck), stuck_spend=round(stuck_spend),
                slots_now=int(free_now // econ["min_per_adset_day"]) if econ["min_per_adset_day"] else 0,
                min_per_adset=econ["min_per_adset_day"], discount=penalty["discount_new"])

def simulate_push(fitres, pct, live_spend, learning_spend, min_adset):
    """What a +pct% budget push does to learning, revenue and marginal ROAS."""
    if not fitres.get("ok"): return dict(ok=False, reason=fitres.get("reason"))
    a, b = fitres["a"], fitres["b"]; S = fitres["cur_spend"]
    S2 = S * (1 + pct / 100.0)
    add = S2 - S
    rev1 = a * S ** b; rev2 = a * S2 ** b
    inc = (rev2 - rev1) / add if add else 0
    # learning: Meta resets an adset when its budget moves more than ~20%
    resets = pct > 20
    new_learning = (live_spend + add) if resets else learning_spend
    new_ratio = new_learning / (live_spend + add) if (live_spend + add) else 0
    return dict(ok=True, pct=pct, add=round(add), new_spend=round(S2),
                extra_revenue=round(rev2 - rev1), incremental_roas=round(inc, 2),
                new_total_revenue=round(rev2),
                resets_learning=resets, new_learning_spend=round(new_learning),
                new_learning_ratio=round(new_ratio, 3),
                settled_spend=round((live_spend + add) - new_learning),
                min_adset_day=min_adset)

def push_capacity(active_budget, lr, inc_roas, target_roas):
    """How much budget can safely be added tomorrow."""
    ratio = lr["ratio"]
    # Meta resets learning on >20% budget edits; scale that ceiling by learning saturation.
    base = active_budget * 0.20
    if ratio <= 0.20:   factor, verdict = 1.00, "PUSH — learning is settled"
    elif ratio <= 0.35: factor, verdict = 0.60, "PUSH CAREFULLY — a third of spend still learning"
    elif ratio <= 0.50: factor, verdict = 0.30, "HOLD MOSTLY — half the spend is unstable"
    else:               factor, verdict = 0.00, "DO NOT PUSH — most spend is in learning"
    # incremental roas gate: if marginal roas is below target, adding money buys losses
    gate = 1.0
    if inc_roas is not None:
        if inc_roas < 0.5 * target_roas: gate, verdict = 0.0, "DO NOT PUSH — incremental ROAS is far below target"
        elif inc_roas < target_roas:     gate = 0.5
    return dict(headroom=round(base * factor * gate), factor=factor, gate=gate, verdict=verdict)

def reactivation_list(camps, min_roas, window="d7", portal=None):
    out = []
    for c in camps.values():
        if portal and c["portal"] != portal: continue
        if c["status"] == "ACTIVE": continue
        w = c[window]
        if w["spend"] < 2000: continue          # too little history to trust
        r = w["rev"] / w["spend"] if w["spend"] else 0
        if r < min_roas: continue
        out.append(dict(id=c["id"], name=c["name"], portal=c["portal"], acct=c["acct"],
                        budget=c["budget"], roas=round(r, 2), spend=round(w["spend"]),
                        orders=w["orders"], cac=round(w["spend"] / w["orders"]) if w["orders"] else 0))
    return sorted(out, key=lambda x: -x["roas"])

def closing_list(camps, orders_needed_from_active, portal=None):
    """Close worst ROAS first while projected orders still clear the target."""
    act = [c for c in camps.values() if c["status"] == "ACTIVE" and (not portal or c["portal"] == portal)]
    scored = []
    for c in act:
        w = c["d7"]
        r = w["rev"] / w["spend"] if w["spend"] else 0
        opd = w["orders"] / 7.0
        scored.append(dict(id=c["id"], name=c["name"], portal=c["portal"], budget=c["budget"],
                           roas=round(r, 2), orders_per_day=round(opd, 1), spend7=round(w["spend"])))
    scored.sort(key=lambda x: x["roas"])
    total_opd = sum(s["orders_per_day"] for s in scored)
    slack = total_opd - orders_needed_from_active
    closable, freed, lost = [], 0.0, 0.0
    for s in scored:
        if s["orders_per_day"] <= slack - lost and s["roas"] < 1.0:
            closable.append(s); freed += s["budget"]; lost += s["orders_per_day"]
    return dict(candidates=scored[:15], closable=closable, budget_freed=round(freed),
                orders_at_risk=round(lost, 1), projected_active_orders=round(total_opd, 1),
                slack=round(slack, 1))

def incremental_roas(shop_day, spend_day, lookback=10):
    """Marginal revenue per marginal rupee — the number that actually matters."""
    days = sorted(set(shop_day) & set(spend_day))[-lookback:]
    pts = [(spend_day[d], shop_day[d][1]) for d in days if spend_day.get(d, 0) > 0]
    out = dict(days=days, dod=None, slope=None, avg=None, series=[])
    if len(pts) < 3: return out
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    mx, my = statistics.mean(xs), statistics.mean(ys)
    den = sum((x - mx) ** 2 for x in xs)
    if den > 0:
        out["slope"] = round(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den, 2)
    out["avg"] = round(sum(ys) / sum(xs), 2) if sum(xs) else 0
    ser = []
    for i in range(1, len(days)):
        a, b = days[i - 1], days[i]
        ds = spend_day.get(b, 0) - spend_day.get(a, 0)
        dr = shop_day[b][1] - shop_day[a][1]
        ser.append(dict(date=b, dspend=round(ds), drev=round(dr),
                        inc=round(dr / ds, 2) if abs(ds) > 3000 else None))
    out["series"] = ser
    recent = [s["inc"] for s in ser[-4:] if s["inc"] is not None]
    out["dod"] = round(statistics.median(recent), 2) if recent else None
    return out

def project_today(shop, portal):
    """Project EOD orders from the intraday curve of the last 7 days."""
    now = datetime.now(IST)
    today = now.date().isoformat()
    hourly = shop.get("hourly", {})
    past = [d for d in sorted(hourly) if d != today][-7:]
    if not past: return None
    fracs = []
    for d in past:
        h = hourly[d]; tot = sum(h.values())
        if tot < 10: continue
        upto = sum(v for k, v in h.items() if k <= now.hour)
        fracs.append(upto / tot)
    if not fracs: return None
    f = statistics.median(fracs)
    sofar = shop["day"].get(today, [0, 0.0])[0]
    return dict(orders_so_far=sofar, frac_elapsed=round(f, 3),
                projected=round(sofar / f) if f > 0.05 else None, hour=now.hour)

# ---------- report ----------
def rs(x):
    try: return f"Rs {round(x):,}"
    except Exception: return "Rs 0"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-orders", type=float, required=True, help="orders/day you are aiming at")
    ap.add_argument("--reactivate-roas", type=float, default=1.5, help="min ROAS to consider reactivating")
    ap.add_argument("--target-roas", type=float, default=2.0, help="your ROAS goal (gates budget pushes)")
    ap.add_argument("--portal", default=None, choices=["SM", "NBP", "SML"])
    ap.add_argument("--no-html", action="store_true")
    ap.add_argument("--push", default=None,
                    help='push %% per portal, e.g. "SM:10,NBP:0,SML:15" (skips the prompt)')
    ap.add_argument("--no-prompt", action="store_true", help="skip the interactive push question")
    a = ap.parse_args()

    accts = {k: v for k, v in ACCOUNTS.items() if not a.portal or portal_of(k) == a.portal}
    print("finding live accounts...", flush=True)
    accts = active_accounts(accts)
    print(f"  {len(accts)} accounts with spend: {', '.join(accts)}", flush=True)
    portals = [a.portal] if a.portal else ["SM", "NBP", "SML"]
    print(f"\nBUDGET ADVISOR  {datetime.now(IST).strftime('%d %b %Y %H:%M IST')}"
          f"   target {a.target_orders:.0f} orders/day @ {a.target_roas}x\n")

    print("pulling meta...", flush=True)
    lrows = pull_learning(accts)
    camps = pull_campaigns(accts)
    print("pulling shopify...", flush=True)
    shop = {p: pull_shopify(p) for p in portals}

    # spend per day (meta, all accounts in scope) for incremental roas
    spend_day = defaultdict(float)
    spend_day_p = defaultdict(lambda: defaultdict(float))
    now = datetime.now(IST).date()
    for nm, acct in accts.items():
        d = paged(f"https://graph.facebook.com/v21.0/{acct}/insights?level=account&time_increment=1"
                  f"&fields=spend&time_range={tr((now-timedelta(days=13)).isoformat(), now.isoformat())}"
                  f"&limit=100&access_token={urllib.parse.quote(TOK)}")
        for r in d:
            spend_day[r["date_start"]] += float(r.get("spend", 0))
            spend_day_p[portal_of(nm)][r["date_start"]] += float(r.get("spend", 0))
    shop_all = defaultdict(lambda: [0, 0.0])
    for p in portals:
        for k, v in shop[p].get("day", {}).items():
            shop_all[k][0] += v[0]; shop_all[k][1] += v[1]

    active_budget = sum(c["budget"] for c in camps.values() if c["status"] == "ACTIVE")
    lr = learning_ratio(lrows)
    inc = incremental_roas(dict(shop_all), dict(spend_day))
    cap = push_capacity(active_budget, lr, inc["dod"], a.target_roas)

    todays = datetime.now(IST).date().isoformat()
    spend_today = sum(c["today"]["spend"] for c in camps.values())
    proj = {p: project_today(shop[p], p) for p in portals}
    orders_today = sum((shop[p]["day"].get(todays, [0, 0.0])[0]) for p in portals)
    projected = sum(pr["projected"] for pr in proj.values() if pr and pr["projected"]) or None

    econ = learning_economics(camps)
    alloc = defaultdict(float); alloc_n = defaultdict(int)
    for c in camps.values():
        alloc[c["status"]] += c["budget"]; alloc_n[c["status"]] += 1
    alloc_total = sum(alloc.values())
    killed_spend = sum(c["today"]["spend"] for c in camps.values() if c["status"] != "ACTIVE")

    morn_all = morning_allocation(camps, window="yday")
    morn_today = morning_allocation(camps, window="today")
    print("\n" + "=" * 78)
    print("1. BUDGET BASE — what you allocate in the morning, not what survives the day")
    print("=" * 78)
    print(f"  {'':<26}{'YESTERDAY (full day)':>22}{'TODAY (so far)':>20}")
    print(f"  {'morning allocation':<26}{rs(morn_all['allocated']):>22}{rs(morn_today['allocated']):>20}")
    print(f"  {'auto-closed during day':<26}{rs(morn_all['closed_budget'])+f" ({morn_all['closed_pct']}%)":>22}"
          f"{rs(morn_today['closed_budget'])+f" ({morn_today['closed_pct']}%)":>20}")
    print(f"  {'actually spent':<26}{rs(morn_all['spent']):>22}{rs(morn_today['spent']):>20}")
    print(f"  {'delivery rate':<26}{f'{100*morn_all[chr(39)+chr(39)] if False else 100*morn_all["delivery_rate"]:.0f}%':>22}"
          f"{f'{100*morn_today["delivery_rate"]:.0f}%':>20}")
    print(f"\n  >>> every rupee you allocate delivers {morn_all['delivery_rate']:.2f} of spend —")
    print(f"      to move spend by X you must move the morning allocation by X / {morn_all['delivery_rate']:.2f}")
    alloc = defaultdict(float); alloc_n = defaultdict(int)
    for c in camps.values():
        alloc[c["status"]] += c["budget"]; alloc_n[c["status"]] += 1
    alloc_total = sum(alloc.values())
    killed_spend = sum(c["today"]["spend"] for c in camps.values() if c["status"] != "ACTIVE")
    print(f"\n  for reference, the whole account: {rs(alloc_total)} sits on {len(camps)} campaigns,")
    print(f"  of which {rs(alloc.get('ACTIVE',0))} ({100*alloc.get('ACTIVE',0)/alloc_total if alloc_total else 0:.0f}%) is ACTIVE this second.")

    print("\n" + "=" * 78)
    print("2. LEARNING — how much of tomorrow's money is unstable")
    print("=" * 78)
    print(f"  spend on adsets still delivering  {rs(lr['spend_live'])}   ({lr['n_live']} adsets)")
    print(f"  of which LEARNING                 {rs(lr['spend_learning'])}   ({lr['n_learning']} adsets)")
    print(f"  >>> TRUE LEARNING RATIO            {100*lr['ratio']:.0f}%")
    print(f"  (excluded: {rs(lr['spend_killed_today'])} on {lr['n_killed']} adsets killed today — dead money cannot destabilise tomorrow)")
    print(f"\n  CAC {rs(econ['cac'])}  ->  an adset needs 50 conversions/7d to graduate")
    print(f"  MINIMUM VIABLE BUDGET PER LEARNING ADSET: {rs(econ['min_per_adset_day'])}/day")
    stuck = [x for x in lr["learning_adsets"] if x["spend"] < econ["min_per_adset_day"]]
    if stuck:
        print(f"\n  {len(stuck)} learning adsets are funded BELOW that floor and can never graduate")
        print(f"  they are burning {rs(sum(x['spend'] for x in stuck))}/day:")
        for x in stuck[:8]:
            print(f"      {rs(x['spend']):>10}/day  conv {x['conv']:>3}  {x['portal']:<5}{x['name'][:40]}")
    print(f"\n  capacity: {econ['weekly_conversions']:,} conversions/week supports ~{econ['capacity_adsets']} "
          f"learning adsets at a 20% share")

    print("\n" + "=" * 78)
    print(f"3. WHAT CAN I REACTIVATE AT ROAS >= {a.reactivate_roas}?")
    print("=" * 78)
    re_list = reactivation_list(camps, a.reactivate_roas, portal=a.portal)
    if not re_list:
        print(f"  nothing paused clears {a.reactivate_roas}x on 7-day data.")
    else:
        cum = 0; fits = 0
        print(f"  {'roas':>6}{'budget':>11}{'7d spend':>11}{'orders':>8}{'CAC':>8}  campaign")
        for c in re_list[:20]:
            cum += c["budget"]
            flag = "<= fits headroom" if cum <= cap["headroom"] else ""
            if cum <= cap["headroom"]: fits += 1
            print(f"  {c['roas']:>6.2f}{c['budget']:>11,.0f}{c['spend']:>11,.0f}{c['orders']:>8}{c['cac']:>8,.0f}  {c['name'][:44]} {flag}")
        total = sum(c["budget"] for c in re_list)
        print(f"\n  {len(re_list)} campaigns available, {rs(total)} of budget")
        print(f"  >>> reactivate the top {fits} ({rs(min(total, cap['headroom']))}) to stay inside learning headroom")

    print("\n" + "=" * 78)
    print("4. WHAT CAN I CLOSE TODAY AND STILL HIT TARGET?")
    print("=" * 78)
    if projected:
        print(f"  orders so far today      {orders_today}  (~{100*statistics.median([p['frac_elapsed'] for p in proj.values() if p]):.0f}% of the day elapsed)")
        print(f"  projected end of day     {projected}   vs target {a.target_orders:.0f}")
        gap = projected - a.target_orders
        print(f"  {'surplus' if gap>=0 else 'SHORTFALL'}                  {gap:+.0f} orders")
    cl = closing_list(camps, a.target_orders, portal=a.portal)
    print(f"\n  active campaigns produce ~{cl['projected_active_orders']:.0f} orders/day (7d avg), slack {cl['slack']:+.1f}")
    if cl["closable"]:
        print(f"  >>> you can close {len(cl['closable'])} campaigns, freeing {rs(cl['budget_freed'])}, "
              f"costing ~{cl['orders_at_risk']:.1f} orders/day:")
        for c in cl["closable"][:10]:
            print(f"      roas {c['roas']:>5.2f}  {rs(c['budget']):>12}  {c['orders_per_day']:>4.1f} ord/d  {c['name'][:44]}")
    else:
        print("  >>> no safe closes — you need every active campaign to hit target")
    print(f"\n  worst performers regardless (close only if target allows):")
    for c in cl["candidates"][:6]:
        print(f"      roas {c['roas']:>5.2f}  {rs(c['budget']):>12}  {c['orders_per_day']:>4.1f} ord/d  {c['name'][:44]}")

    print("\n" + "=" * 78)
    print("5. IS MY APPROACH EARNING INCREMENTAL ROAS?")
    print("=" * 78)
    print(f"  average ROAS (shopify, last {len(inc['days'])}d)  {inc['avg']}")
    print(f"  incremental ROAS (regression slope)  {inc['slope'] if inc['slope'] is not None else 'n/a'}")
    print(f"  incremental ROAS (median day-over-day) {inc['dod'] if inc['dod'] is not None else 'n/a'}")
    print(f"\n  {'date':<12}{'d spend':>11}{'d revenue':>12}{'incremental':>13}")
    for s in inc["series"][-8:]:
        v = f"{s['inc']:.2f}" if s["inc"] is not None else "flat"
        print(f"  {s['date']:<12}{s['dspend']:>+11,}{s['drev']:>+12,}{v:>13}")
    if inc["dod"] is not None:
        if inc["dod"] >= a.target_roas: msg = "adding budget is EARNING above target — push"
        elif inc["dod"] >= 1.0:         msg = "adding budget earns above cost but below target — push only into proven camps"
        elif inc["dod"] >= 0:           msg = "added budget is LOSING money — reallocate, do not add"
        else:                            msg = "added budget is destroying revenue — cut back"
        print(f"\n  >>> {msg}")

    # full campaign table so the web UI can recompute thresholds client-side
    camp_rows = []
    for c in camps.values():
        w7 = c["d7"]; w30 = c["d30"]
        camp_rows.append(dict(id=c["id"], name=c["name"], portal=c["portal"], acct=c["acct"],
                              status=c["status"], budget=round(c["budget"]), created=c["created"],
                              updated=c["updated"],
                              roas7=round(w7["rev"]/w7["spend"], 2) if w7["spend"] else 0,
                              spend7=round(w7["spend"]), orders7=w7["orders"],
                              opd=round(w7["orders"]/7.0, 2),
                              roas30=round(w30["rev"]/w30["spend"], 2) if w30["spend"] else 0,
                              spend30=round(w30["spend"]),
                              today_spend=round(c["today"]["spend"]), today_orders=c["today"]["orders"],
                              yday_spend=round(c["yday"]["spend"]), yday_orders=c["yday"]["orders"],
                              yday_rev=round(c["yday"]["rev"])))
    learn_rows = [dict(portal=r["portal"], name=r["name"], stage=r["stage"],
                       spend=round(r["spend_today"]), conv=r.get("conversions", 0)) for r in lrows]
    per_portal = {}
    for p_ in portals:
        pd = shop[p_].get("day", {})
        per_portal[p_] = dict(shopify=pd,
                              spend={k: round(v) for k, v in spend_day_p.get(p_, {}).items()},
                              projected=(proj.get(p_) or {}))
    # ================= 6. THE CALL =================
    penalty = learning_penalty(camps)
    fits = {}
    for p_ in portals:
        fits[p_] = fit_response(dict(spend_day_p.get(p_, {})), shop[p_].get("day", {}))
    fits["ALL"] = fit_response(dict(spend_day), dict(shop_all))
    head = learning_headroom(econ, lr, penalty)

    print("\n" + "=" * 78)
    print("6. HOW MUCH LEARNING BUDGET CAN I PUT?")
    print("=" * 78)
    print(f"  capacity  {econ['capacity_adsets']} adsets x {rs(econ['min_per_adset_day'])} = {rs(head['capacity_spend'])}/day")
    print(f"  already in learning                     {rs(head['in_learning'])}")
    print(f"  >>> ROOM FOR NEW LEARNING NOW           {rs(head['headroom_now'])}   ({head['slots_now']} adsets)")
    if head["stuck_count"]:
        print(f"  >>> if you fix the {head['stuck_count']} stuck adsets first  {rs(head['headroom_after_fixing_stuck'])}"
              f"   (frees {rs(head['stuck_spend'])} that is producing nothing)")
    print(f"\n  measured learning tax: new campaigns run at {int(100*penalty['discount_new'])}% of mature ROAS")
    print(f"    new (<7d)      ROAS {penalty['new']['roas']}   on {rs(penalty['new']['spend'])}")
    print(f"    settling(7-21d)ROAS {penalty['settling']['roas']}   on {rs(penalty['settling']['spend'])}")
    print(f"    mature (>21d)  ROAS {penalty['mature']['roas']}   on {rs(penalty['mature']['spend'])}")
    print(f"  so anything you start tomorrow should be judged against "
          f"{penalty['discount_new']} x its eventual ROAS in week one.")

    print("\n" + "=" * 78)
    print(f"7. WHAT TO ALLOCATE TOMORROW MORNING (solved for marginal ROAS = {a.target_roas})")
    print("=" * 78)
    print(f"  {'portal':<6}{'alloc now':>12}{'spend':>11}{'deliv':>7}{'marginal':>10}{'fit':>9}"
          f"  ->  {'ALLOCATE':>12}{'move':>8}")
    recs = {}
    for p_ in portals:
        f = fits[p_]; mp = morning_allocation(camps, portal=p_, window="yday")
        r = recommend_allocation(f, mp, a.target_roas) if f.get("ok") else dict(ok=False, reason=f.get("reason"))
        recs[p_] = dict(r, portal=p_, morning=mp)
        if not r.get("ok"):
            print(f"  {p_:<6}{rs(mp['allocated']):>12}{rs(mp['spent']):>11}"
                  f"{f'{100*mp[chr(100)+chr(101)+chr(108)+chr(105)+chr(118)+chr(101)+chr(114)+chr(121)+chr(95)+chr(114)+chr(97)+chr(116)+chr(101)]:.0f}%' if False else f'{100*mp["delivery_rate"]:.0f}%':>7}"
                  f"{'—':>10}{'—':>9}  ->  {'hold':>12}{'':>8}  {r.get('reason','')}")
            continue
        if not r.get("solvable"):
            print(f"  {p_:<6}{rs(mp['allocated']):>12}{rs(mp['spent']):>11}{f'{100*mp["delivery_rate"]:.0f}%':>7}"
                  f"{r.get('marginal_now',0):>10.2f}{('R2 '+str(f['r2'])):>9}  ->  {'HOLD':>12}{'':>8}")
            print(f"         {r.get('reason','')}")
            continue
        print(f"  {p_:<6}{rs(r['allocated_now']):>12}{rs(r['spend_now']):>11}{f'{100*r["delivery_rate"]:.0f}%':>7}"
              f"{r['marginal_now']:>10.2f}{('R2 '+str(f['r2'])):>9}  ->  {rs(r['allocate']):>12}{f'{r[chr(112)+chr(99)+chr(116)]:+.0f}%' if False else f'{r["pct"]:+.0f}%':>8}")
        if r["clamped"]:
            print(f"         (solver wanted {r['raw_pct']:+.0f}% on spend; capped at 20% — a bigger edit resets learning)")
    tot_alloc_now = sum(r["morning"]["allocated"] for r in recs.values())
    tot_alloc_new = sum(r.get("allocate", r["morning"]["allocated"]) for r in recs.values())
    tot_d = sum(r.get("delta_spend", 0) for r in recs.values())
    tot_r = sum(r.get("delta_revenue", 0) for r in recs.values())
    print(f"\n  >>> ALLOCATE TOMORROW: {rs(tot_alloc_new)} vs {rs(tot_alloc_now)} today"
          f"  ({100*(tot_alloc_new/tot_alloc_now-1) if tot_alloc_now else 0:+.0f}%)")
    if tot_d:
        print(f"  >>> that changes spend by {rs(tot_d)} and revenue by {rs(tot_r)}"
              f"  -> incremental {tot_r/tot_d:.2f}")

    print("\n" + "=" * 78)
    print("8. HOW DO I ACTUALLY GET INCREMENTAL ROAS TOMORROW?")
    print("=" * 78)
    losers = sorted([c for c in camps.values() if c["status"] == "ACTIVE" and c["d7"]["spend"] > 3000
                     and (c["d7"]["rev"] / c["d7"]["spend"]) < 1.0],
                    key=lambda c: c["d7"]["rev"] / c["d7"]["spend"])
    loser_budget = sum(c["budget"] for c in losers)
    winners = reactivation_list(camps, max(a.reactivate_roas, 1.5), portal=a.portal)
    pool = head["stuck_spend"] + loser_budget
    print(f"  Expansion (adding new money) prices at {fits['ALL'].get('marginal_roas','n/a')} — that is the number that says 'do not push'.")
    print(f"  Reallocation is a different trade, and it is where the incremental gain is:\n")
    print(f"    SOURCE  stuck learning adsets      {rs(head['stuck_spend'])}/day  returning ~0")
    print(f"    SOURCE  active campaigns under 1x  {rs(loser_budget)}/day  ({len(losers)} campaigns)")
    print(f"    ------------------------------------------------------")
    print(f"    POOL TO REDEPLOY                   {rs(pool)}/day")
    if winners:
        take = []; acc = 0
        for w in winners:
            if acc >= pool: break
            take.append(w); acc += w["budget"]
        exp = sum(w["budget"] * w["roas"] for w in take) * penalty["discount_new"]
        spend_moved = sum(w["budget"] for w in take)
        cur_ret = sum(c["budget"] * (c["d7"]["rev"] / c["d7"]["spend"]) for c in losers)
        print(f"\n    DESTINATION  top {len(take)} paused winners, {rs(spend_moved)}/day")
        for w in take[:6]:
            print(f"       {w['roas']:>5.2f}x  {rs(w['budget']):>10}/day  {w['name'][:46]}")
        print(f"\n    they historically return {sum(w['budget']*w['roas'] for w in take)/spend_moved if spend_moved else 0:.2f}x;"
              f" apply the {penalty['discount_new']} learning tax -> {exp/spend_moved if spend_moved else 0:.2f}x in week one")
        print(f"    money currently returns {cur_ret/loser_budget if loser_budget else 0:.2f}x where it sits")
        gain = exp - cur_ret
        print(f"\n  >>> SAME TOTAL SPEND. Expected change: {rs(gain)}/day of revenue"
              f"  ({rs(exp)} vs {rs(cur_ret)})")
        print(f"  >>> that is your incremental ROAS tomorrow: {exp/spend_moved if spend_moved else 0:.2f} on redeployed money,")
        print(f"      versus {fits['ALL'].get('marginal_roas','n/a')} if you simply add budget to what is already running.")
    else:
        print("\n  no paused winners above the bar — the pool should stay unspent until creative improves.")

    # ================= 9. SHOULD I BE CLOSING THIS MUCH? =================
    aud = closure_audit(camps, protect_roas=1.0)
    print("\n" + "=" * 78)
    print("9. SHOULD I BE CLOSING THIS MUCH?  (delivery rate: 55%, 70%, 90%, 100%?)")
    print("=" * 78)
    print(f"  auto-close cut {aud['closed_n']} campaigns today, {rs(aud['closed_budget'])} of allocation")
    print(f"\n  {'7-day ROAS of the campaign it closed':<38}{'camps':>7}{'budget':>13}")
    for k, v in aud["bands"].items():
        flag = "   <-- these look like mistakes" if k in ("1.0-1.5", "1.5-2.0", ">=2.0") and v["n"] else ""
        print(f"    {k:<36}{v['n']:>7}{rs(v['budget']):>13}{flag}")
    print(f"\n  >>> {aud['false_positive_n']} campaigns were closed today despite a 7-day ROAS at or above "
          f"{aud['protect_roas']}x")
    print(f"  >>> that is {rs(aud['false_positive_budget'])} of proven budget killed on one bad intraday reading")
    if aud["worst"]:
        print(f"\n  biggest of them:")
        for w in aud["worst"][:6]:
            print(f"    7d {w['roas7']:>5.2f}   budget {rs(w['budget']):>10}   spent today {rs(w['spent_today']):>9}   "
                  f"{w['portal']:<4}{w['name'][:42]}")
    print(f"\n  THE ANSWER on delivery rate:")
    print(f"    today            {100*aud['delivery_now']:.0f}%")
    print(f"    with a guard that never closes a campaign whose 7-day ROAS >= {aud['protect_roas']}x:"
          f"  ~{100*aud['delivery_if_protected']:.0f}%")
    print(f"    (recovers about {rs(aud['recovered_spend'])} of spend that is being cut off mid-day)")
    print(f"\n  I am not going to hand you a single 'correct' number — 70% or 90% cannot be")
    print(f"  derived honestly, because what a closed campaign WOULD have earned is")
    print(f"  unobservable. What the data does support is the rule, not the ratio:")
    print(f"    * keep closing on intraday ROAS for campaigns with no track record")
    print(f"    * NEVER close one whose 7-day ROAS is above {aud['protect_roas']}x on a single bad day")
    print(f"  Do that and the delivery rate settles where it settles — around "
          f"{100*aud['delivery_if_protected']:.0f}% on today's mix.")

    state = dict(generated=datetime.now(IST).isoformat(), target_orders=a.target_orders,
                 target_roas=a.target_roas, reactivate_roas=a.reactivate_roas, portal=a.portal,
                 active_budget=round(active_budget), spend_today=round(spend_today), learning=lr,
                 push=cap, incremental=inc, orders_today=orders_today, projected=projected,
                 campaigns=camp_rows, adsets=learn_rows,
                 economics=econ, fits=fits, recommendation=recs,
                 learning_headroom=head, learning_penalty=penalty,
                 closure_audit=aud, morning=morn_all, morning_today=morn_today,
                 allocated={k: round(v) for k, v in alloc.items()},
                 killed_spend_today=round(killed_spend),
                 shopify={k: v for k, v in dict(shop_all).items()},
                 spend_day={k: round(v) for k, v in spend_day.items()},
                 portals=per_portal)
    os.makedirs(OUT, exist_ok=True)
    with open(f"{OUT}/state.json", "w") as f: json.dump(state, f, indent=1, default=str)
    web = os.path.expanduser("~/meta-ads-reports/roas-live/budget.json")
    try:
        with open(web, "w") as f: json.dump(state, f, separators=(",", ":"), default=str)
        print(f"web json -> {web}")
    except Exception as e:
        print("web json failed:", e)
    print(f"\nstate -> {OUT}/state.json")
    if not a.no_html:
        from budget_advisor_html import render
        p = render(state, OUT)
        print(f"dashboard -> {p}")

if __name__ == "__main__":
    main()
