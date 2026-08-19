#!/usr/bin/env python3
"""Render the daily budget/closing report as one long PNG for WhatsApp.

Drawn with Pillow rather than a headless browser so it runs anywhere (CI, EC2)
without Chrome. Reads full.json, writes report.png.
"""
import collections, json, pathlib, re, sys
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont

SP = pathlib.Path(__file__).parent
W = 1080
PAD = 34

INK = (17, 24, 32)
INK2 = (74, 85, 99)
INK3 = (125, 135, 148)
PAPER = (255, 255, 255)
BAND = (240, 243, 246)
LINE = (214, 220, 228)
ACCENT = (15, 110, 104)
GOOD = (19, 107, 54)
OKC = (44, 107, 143)
WARN = (138, 90, 8)
BAD = (163, 34, 24)
GOOD_BG = (220, 239, 226)
OK_BG = (221, 233, 241)
WARN_BG = (246, 233, 207)
BAD_BG = (246, 222, 219)


def font(size, bold=False):
    cands = ([  # macOS
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ] + [  # Linux / CI
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ])
    for c in cands:
        try:
            return ImageFont.truetype(c, size)
        except Exception:
            continue
    return ImageFont.load_default()


F = {k: font(s, b) for k, (s, b) in {
    "h1": (40, True), "h2": (21, True), "kpi": (34, True), "kpil": (15, False),
    "th": (16, True), "td": (17, False), "tdb": (17, True), "sm": (14, False),
    "tiny": (13, False)}.items()}

def _has_glyph(ch):
    """getbbox() answers even for .notdef, so compare the rendered mask against a
    codepoint that is certainly missing."""
    f = font(28)
    try:
        a = f.getmask(ch).tobytes()
        b = f.getmask("\ue001").tobytes()
        return a != b and any(a)
    except Exception:
        return False


RUPEE = "₹" if _has_glyph("₹") else "Rs "


def money(v):
    v = float(v or 0)
    if abs(v) >= 1e5:
        return f"{RUPEE}{v/1e5:.2f}L"
    return f"{RUPEE}{v:,.0f}"


def rcolor(v):
    if v >= 2.0: return GOOD, GOOD_BG
    if v >= 1.2: return OKC, OK_BG
    if v >= 0.8: return WARN, WARN_BG
    return BAD, BAD_BG


# ---------- data ----------
blob = json.load(open(SP / "full.json"))
C, A = blob["campaigns"], blob["adsets"]
now = datetime.fromisoformat(blob["as_of"])
DAYS = ("365", "300", "180", "120", "90", "60", "30")


def block_of(name):
    n = (name or "").lower()
    for d in DAYS:
        if re.search(rf"(?<![a-z0-9])(ex|exc)[_ ]?{d}(?!\d)", n) or re.search(rf"(?<!\d){d}[_ ]?d[pv]?[_ ]?exc", n):
            return f"Sales · Exc {d}DP"
    if re.search(r"imp_?exc", n): return "Sales · Exc imp"
    if re.search(r"(?<![a-z0-9])(ex|exc)[_ ]?\d+", n): return "Sales · Exc other"
    for d in DAYS:
        if re.search(rf"inc[_ ]?{d}(?!\d)", n) or re.search(rf"(?<![a-z0-9]){d}[_ ]?dp(?!\d)", n):
            return f"Retarget · {d}DP inc"
    if re.search(r"visitor", n): return "Retarget · Visitors"
    if re.search(r"\d+d[_ ]?imp|imp_rtg|(?<![a-z])imp(?![a-z])", n): return "Retarget · Impressions"
    if re.search(r"\d+_?atc|(?<![a-z])atc(?![a-z])", n): return "Retarget · ATC"
    if re.search(r"retarget|(?<![a-z])rtg(?![a-z])", n): return "Retarget · other"
    if re.search(r"loose", n): return "Sales · Loose"
    return "Sales · Broad/other"


for c in C:
    c["block"] = block_of(c["name"])
    c["intent"] = "Retarget" if c["block"].startswith("Retarget") else "Sales"
cby = {c["id"]: c for c in C}
for a in A:
    p = cby.get(a["campaign_id"])
    a["intent"] = p["intent"] if p else "Sales"

uni = [c for c in C if c["spend_today"] > 0 or (c["live"] and c["budget_alloc"] > 0)]
uni_a = [a for a in A if a["spend_today"] > 0 or (a["live"] and a["budget_alloc"] > 0)]
live = [c for c in uni if c["live"]]
shut = [c for c in uni if not c["live"] and c["spend_today"] > 0]


def agg(rows):
    on = [r for r in rows if r["live"]]
    off = [r for r in rows if not r["live"] and r["spend_today"] > 0]
    s = sum(r["spend_today"] for r in rows) or 0
    rv = sum(r["revenue_today"] for r in rows)
    so = sum(r["spend_today"] for r in on); ro = sum(r["revenue_today"] for r in on)
    sf = sum(r["spend_today"] for r in off); rf = sum(r["revenue_today"] for r in off)
    ages = sorted(r["days_active"] for r in rows if r.get("days_active") is not None)
    return {"n": len(rows), "alloc": sum(r["budget_alloc"] for r in rows),
            "alloc_off": sum(r["budget_alloc"] for r in off),
            "alloc_on": sum(r["budget_alloc"] for r in on),
            "spend": s, "rev": rv, "roas": rv / s if s else 0,
            "roas_on": ro / so if so else 0, "roas_off": rf / sf if sf else 0,
            "n_on": len(on), "n_off": len(off),
            "age": ages[len(ages) // 2] if ages else 0}


T = agg(uni); L = agg(live); S_ = agg(shut) if shut else agg([])

# ---------- layout pass ----------
rows_portal = [(p, agg([c for c in uni if c["portal"] == p])) for p in ("SM", "SML", "NBP")]
rows_portal = [(p, a) for p, a in rows_portal if a["n"]]
BUCK = [(0, 7, "0-7d"), (8, 30, "8-30d"), (31, 90, "31-90d"), (91, 180, "91-180d"), (181, 99999, "180d+")]
rows_age = []
for lo, hi, lbl in BUCK:
    rs = [c for c in uni if c["days_active"] is not None and lo <= c["days_active"] <= hi]
    if rs: rows_age.append((lbl, agg(rs)))
rows_intent = [(k, agg([c for c in uni if c["intent"] == k])) for k in ("Sales", "Retarget")]
gb = collections.defaultdict(list)
for c in uni: gb[c["block"]].append(c)
rows_block = sorted(((b, agg(rs)) for b, rs in gb.items()), key=lambda x: -x[1]["alloc"])
ga = collections.defaultdict(list)
for a in uni_a: ga[a["audience"]].append(a)
rows_aud = sorted(((k, agg(v)) for k, v in ga.items()), key=lambda x: -x[1]["spend"])[:12]
rows_close = sorted(shut, key=lambda c: -c["spend_today"])[:14]

HEADER_H = 132
KPI_H = 118
SEC = 46
ROW = 34


def table_h(n, title=True):
    return (SEC if title else 0) + 30 + n * ROW + 16


H = (HEADER_H + KPI_H + 24
     + table_h(2) + 34                     # active vs closed
     + table_h(len(rows_portal) + 1)
     + table_h(len(rows_age))
     + table_h(len(rows_intent))
     + table_h(len(rows_block))
     + table_h(len(rows_aud)) + 22
     + table_h(len(rows_close)) + 70)

img = Image.new("RGB", (W, int(H)), PAPER)
d = ImageDraw.Draw(img)
y = 0

# ---------- header ----------
d.rectangle([0, 0, W, HEADER_H], fill=(16, 24, 32))
d.text((PAD, 26), "Daily Budget & Closing Report", font=F["h1"], fill=(255, 255, 255))
d.text((PAD, 78), now.strftime("%d %b %Y · %I:%M %p IST") + "   ·   SM + SML + NBP   ·   live from Meta",
       font=F["kpil"], fill=(158, 172, 186))
frac = (now.hour * 60 + now.minute) / 1440
d.text((W - PAD - 210, 78), f"day {frac*100:.0f}% elapsed", font=F["kpil"], fill=(158, 172, 186))
y = HEADER_H


def kpi(x, w, label, value, sub, vcol=INK):
    d.text((x, y + 16), label.upper(), font=F["tiny"], fill=INK3)
    d.text((x, y + 36), value, font=F["kpi"], fill=vcol)
    d.text((x, y + 78), sub, font=F["sm"], fill=INK2)


d.rectangle([0, y, W, y + KPI_H], fill=BAND)
cw = (W - PAD * 2) / 4
kpi(PAD, cw, "allocated today", money(T["alloc"]), f"{T['n']} campaigns")
kpi(PAD + cw, cw, "spent", money(T["spend"]),
    f"{T['spend']/T['alloc']*100 if T['alloc'] else 0:.0f}% of allocation")
kpi(PAD + cw * 2, cw, "roas", f"{T['roas']:.2f}", money(T["rev"]) + " revenue", rcolor(T["roas"])[0])
kpi(PAD + cw * 3, cw, "budget closed", money(S_["alloc"]),
    f"{len(shut)} camps @ {S_['roas']:.2f} roas", BAD)
y += KPI_H + 24


def section(title, note=""):
    global y
    d.text((PAD, y), title, font=F["h2"], fill=INK)
    if note:
        tw = d.textlength(title, font=F["h2"])
        d.text((PAD + tw + 12, y + 5), note, font=F["sm"], fill=INK3)
    y += SEC - 12


def table(cols, rows, aligns=None, zebra=True):
    """cols: [(header, width)], rows: list of list[str | (str, color, bg)]"""
    global y
    aligns = aligns or ["l"] + ["r"] * (len(cols) - 1)
    xs, x = [], PAD
    for _, w in cols:
        xs.append(x); x += w
    d.line([PAD, y + 26, W - PAD, y + 26], fill=LINE, width=2)
    for (h, w), xx, al in zip(cols, xs, aligns):
        tw = d.textlength(h, font=F["th"])
        d.text((xx + (w - tw - 10 if al == "r" else 0), y + 4), h, font=F["th"], fill=INK3)
    y += 30
    for i, r in enumerate(rows):
        if zebra and i % 2 == 1:
            d.rectangle([PAD - 8, y - 4, W - PAD + 8, y + ROW - 6], fill=(249, 250, 252))
        for cell, (h, w), xx, al in zip(r, cols, xs, aligns):
            if isinstance(cell, tuple):
                txt, col, bg = cell
                f_ = F["tdb"]
                tw = d.textlength(txt, font=f_)
                bx = xx + (w - tw - 10 if al == "r" else 0)
                if bg:
                    d.rounded_rectangle([bx - 9, y - 3, bx + tw + 9, y + 23], 12, fill=bg)
                d.text((bx, y), txt, font=f_, fill=col)
            else:
                f_ = F["td"]
                tw = d.textlength(cell, font=f_)
                d.text((xx + (w - tw - 10 if al == "r" else 0), y), cell, font=f_, fill=INK)
        y += ROW
    y += 16


def roas_cell(v):
    c, bg = rcolor(v)
    return (f"{v:.2f}", c, bg)


# ---------- active vs closed ----------
section("What closing did", "— same day, split by state")
table([("State", 300), ("Camps", 110), ("Budget", 160), ("Spend", 160), ("Revenue", 160), ("ROAS", 122)],
      [[("STILL RUNNING", GOOD, GOOD_BG), str(L["n"]), money(L["alloc"]), money(L["spend"]),
        money(L["rev"]), roas_cell(L["roas"])],
       [("CLOSED TODAY", BAD, BAD_BG), str(S_["n"]), money(S_["alloc"]), money(S_["spend"]),
        money(S_["rev"]), roas_cell(S_["roas"])]], zebra=False)
msg = (f"{money(S_['alloc'])} of today's allocation is switched off. It spent {money(S_['spend'])} "
       f"at {S_['roas']:.2f} before the cut; what still runs is at {L['roas']:.2f}.")
d.rounded_rectangle([PAD - 8, y - 6, W - PAD + 8, y + 26], 8, fill=WARN_BG)
d.text((PAD + 6, y + 1), msg, font=F["sm"], fill=WARN)
y += 44

# ---------- portal ----------
section("Portal-wise")
rp = [[p, str(a["n"]), money(a["alloc"]),
       f"{a['spend']/a['alloc']*100 if a['alloc'] else 0:.0f}%", money(a["spend"]),
       roas_cell(a["roas"]), roas_cell(a["roas_on"]), roas_cell(a["roas_off"]), money(a["alloc_off"])]
      for p, a in rows_portal]
rp.append([("ALL", INK, None), str(T["n"]), money(T["alloc"]),
           f"{T['spend']/T['alloc']*100 if T['alloc'] else 0:.0f}%", money(T["spend"]),
           roas_cell(T["roas"]), roas_cell(L["roas"]), roas_cell(S_["roas"]), money(S_["alloc"])])
table([("Portal", 132), ("Camps", 92), ("Allocated", 132), ("Used", 92), ("Spend", 132),
       ("ROAS", 106), ("Active", 106), ("Closed", 106), ("Cut", 114)], rp)

# ---------- age ----------
section("By campaign age", "— budget and what it returned")
table([("Days running", 208), ("Camps", 96), ("Allocated", 138), ("Spend", 138),
       ("ROAS", 108), ("Active", 108), ("Closed", 108), ("Budget cut", 108)],
      [[f"{lbl}  ({a['n_on']}L/{a['n_off']}C)", str(a["n"]), money(a["alloc"]), money(a["spend"]),
        roas_cell(a["roas"]), roas_cell(a["roas_on"]), roas_cell(a["roas_off"]), money(a["alloc_off"])]
       for lbl, a in rows_age])

# ---------- intent ----------
section("Sales vs retarget")
table([("Type", 208), ("Camps", 96), ("Allocated", 138), ("Spend", 138),
       ("ROAS", 108), ("Active", 108), ("Closed", 108), ("Budget cut", 108)],
      [[k, str(a["n"]), money(a["alloc"]), money(a["spend"]),
        roas_cell(a["roas"]), roas_cell(a["roas_on"]), roas_cell(a["roas_off"]), money(a["alloc_off"])]
       for k, a in rows_intent])

# ---------- blocks ----------
section("Audience blocks", "— from campaign naming")
table([("Block", 268), ("Camps", 86), ("Age", 74), ("Allocated", 132), ("Spend", 128),
       ("ROAS", 104), ("Active", 104), ("Closed", 104)],
      [[b, str(a["n"]), f"{a['age']}d", money(a["alloc"]), money(a["spend"]),
        roas_cell(a["roas"]), roas_cell(a["roas_on"]), roas_cell(a["roas_off"])]
       for b, a in rows_block])

# ---------- audiences ----------
section("Top audiences", "— real custom-audience names, ex: = excluded")
table([("Audience", 512), ("Sets", 80), ("Spend", 150), ("Revenue", 150), ("ROAS", 120)],
      [[k.replace("⊘", "ex:")[:52], str(a["n"]), money(a["spend"]), money(a["rev"]),
        roas_cell(a["roas"])] for k, a in rows_aud])
d.text((PAD, y - 8), "Ad-set level; CBO campaigns hold budget on the campaign, so allocation shows at "
                     "campaign level only.", font=F["tiny"], fill=INK3)
y += 22

# ---------- closings ----------
section("Closings today", f"— {len(shut)} campaigns switched off, biggest burn first")
table([("Campaign", 512), ("Days", 80), ("Budget cut", 150), ("Spent", 150), ("ROAS", 120)],
      [[c["name"][:52], str(c["days_active"] if c["days_active"] is not None else "-"),
        money(c["budget_alloc"]), money(c["spend_today"]),
        roas_cell(c["revenue_today"] / c["spend_today"] if c["spend_today"] else 0)]
       for c in rows_close])

d.line([PAD, H - 52, W - PAD, H - 52], fill=LINE, width=1)
foot = ("Meta pixel attribution (omni_purchase only) · campaign spend reconciles to each ad account "
        "total · partial-day ROAS understates")
d.text((PAD, H - 40), foot, font=F["tiny"], fill=INK3)

out = SP / "report.png"
img.save(out, "PNG", optimize=True)
print(out, f"{out.stat().st_size/1024:.0f} KB", img.size)
