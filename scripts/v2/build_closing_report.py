#!/usr/bin/env python3
"""
build_closing_report.py — interactive portal-wise closing report (single HTML file).

Sent hourly to WhatsApp as a document attachment: recipients tap it and the
<details> product accordions work in any phone browser — no app, no artifact.

Per portal (SM / NBP / SML): closed vs live camps per product with expandable
per-campaign breakdown — budget, audience setting (from ad-set targeting),
sales/retarget, ROAS, closed-by (auto rule vs manual).

Inputs:
  --snap-db     campaign_hourly_snapshots (hourly collector DB)
  --out         output HTML (default roas-live/closing.html)
  --aud-cache   JSON cache of per-campaign audience summaries. Fetched from Meta
                only for campaign ids not yet cached (targeting rarely changes;
                without the cache this would be ~100 API calls every hour).
  --kills       auto_close_kills.json (optional) → AUTO vs manual attribution.
META_ACCESS_TOKEN env needed only when uncached campaigns appear.
"""
import argparse
import html as H
import json
import os
import re
import sqlite3
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from portal_hourly import portal_of, product_of  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
PORTALS = [('SM', 'Studd Muffyn'), ('NBP', 'Nuskhe by Paras'), ('SML', 'SM Life')]


def classify(name):
    n = (name or '').lower()
    if (re.search(r'(?<![a-z])(ex|exc)[_ ]?\d+ ?d[pv]?', n)
            or re.search(r'\d+ ?dp?[_ ]?exc', n) or re.search(r'imp_?exc', n)):
        return 'sales'
    if re.search(r'retarget|(?<![a-z])rtg(?![a-z])', n):
        return 'retarget'
    if re.search(r'inc\s?\d+ ?dp|incvisitor|visitor|\d+d[_ ]?imp|imp_rtg|'
                 r'(?<![a-z])\d+ ?dp(?![a-z])|\d+_?atc', n):
        return 'retarget'
    return 'sales'


def audience_summary(cid, cache, token):
    if cid in cache:
        return cache[cid]
    if not token:
        return '?'
    try:
        u = (f"https://graph.facebook.com/v19.0/{cid}/adsets?"
             + urllib.parse.urlencode({'fields': 'targeting', 'limit': 25, 'access_token': token}))
        data = json.load(urllib.request.urlopen(u, timeout=40)).get('data', [])
    except Exception:
        return '?'          # transient — retry next build, don't cache
    inc, exc, ages, adv, ints = set(), set(), set(), False, 0
    for a in data:
        t = a.get('targeting') or {}
        if (t.get('targeting_automation') or {}).get('advantage_audience'):
            adv = True
        for ca in (t.get('custom_audiences') or []):
            inc.add(ca.get('name') or str(ca.get('id')))
        for ca in (t.get('excluded_custom_audiences') or []):
            exc.add(ca.get('name') or str(ca.get('id')))
        ages.add(f"{t.get('age_min', '?')}-{t.get('age_max', '?')}")
        for fs in (t.get('flexible_spec') or []):
            ints += len(fs.get('interests') or [])
    parts = []
    if adv: parts.append('Advantage+')
    if inc: parts.append('CA: ' + ', '.join(sorted(inc))[:70])
    if ints: parts.append(f'{ints} interests')
    if not parts: parts.append('Broad')
    if exc: parts.append('excl: ' + ', '.join(sorted(exc))[:70])
    ag = ','.join(sorted(ages))
    if ag and ag != '18-65': parts.append('age ' + ag)
    cache[cid] = ' · '.join(parts)
    return cache[cid]


def block_of(name):
    """Operator's audience blocks, from name markers. Ordered: exclusions first
    (an 'exc 180dp' camp is prospecting, not a 180DP include)."""
    n = (name or '').lower()
    if re.search(r'(?<![a-z])(ex|exc)[_ ]?180', n) or re.search(r'180[_ ]?dp?[_ ]?exc', n):
        return 'Exc 180DP'
    if re.search(r'(?<![a-z])(ex|exc)[_ ]?30', n) or re.search(r'30[_ ]?dp?v?[_ ]?exc', n):
        return 'Exc 30DP'
    if re.search(r'imp_?exc|(?<![a-z])(ex|exc)[_ ]?\d+', n):
        return 'Exc other'
    if re.search(r'inc[_ ]?180|(?<![a-z])180[_ ]?dp', n):
        return '180DP include'
    if re.search(r'inc[_ ]?30|(?<![a-z])30[_ ]?dp', n):
        return '30DP include'
    if re.search(r'(?<![a-z])365', n):
        return '365D include'
    if re.search(r'visitor', n):
        return 'Visitors'
    if re.search(r'\d+d[_ ]?imp|imp_rtg|(?<![a-z])imp(?![a-z])', n):
        return 'Impressions'
    if re.search(r'\d+_?atc|(?<![a-z])atc(?![a-z])', n):
        return 'ATC'
    if re.search(r'retarget|(?<![a-z])rtg(?![a-z])', n):
        return 'Retarget other'
    if re.search(r'loose', n):
        return 'Loose'
    return 'Broad/other'


_STOP = {'ntn', 'adv', 'web', 'wanda', 'sales', 'conv', 'loose', 'reel', 'clp', 'copy',
         'strong', 'v', 'high', 'potential', 'highpotential', 'brand', 'paras', 'single',
         'rtg', 'retarget', 'exc', 'ex', 'inc', 'imp', 'dp', 'atc', 'explorer'}


def product_fallback(name):
    """When product_of() has no match, derive a readable label from the name:
    prefer the NTN sku code, else the first meaningful words."""
    m = re.search(r'ntn ?_?(\d{3,4})', (name or '').lower())
    code = f'NTN{m.group(1)}' if m else ''
    words = [w for w in re.split(r'[^a-zA-Z]+', name or '')
             if len(w) > 2 and w.lower() not in _STOP and not w.isdigit()][:3]
    label = ' '.join(words).lower()
    if code and label: return f'{code} {label}'
    return code or label or 'unclassified'


def inr(n): return 'Rs {:,}'.format(round(n))
def _roas(sp, rv): return round(rv / sp, 2) if sp else None


def chip(r):
    if r is None: return '<span class="chip na">–</span>'
    cls = 'ok' if r >= 1.6 else 'warn' if r >= 1.0 else 'bad'
    return f'<span class="chip {cls}">{r:.2f}</span>'


def agg(cs):
    sp = sum(c['spend'] for c in cs); rv = sum(c['revenue'] for c in cs)
    return len(cs), sp, rv, _roas(sp, rv)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--snap-db', default='state/camp_snapshots.db')
    ap.add_argument('--out', default='roas-live/closing.html')
    ap.add_argument('--aud-cache', default='state/closing_aud_cache.json')
    ap.add_argument('--kills', default='state/auto_close_kills.json')
    args = ap.parse_args()

    now = datetime.now(IST)
    day = now.strftime('%Y-%m-%d')
    token = os.environ.get('META_ACCESS_TOKEN', '')

    cache = {}
    try:
        cache = json.loads(Path(args.aud_cache).read_text())
    except Exception:
        pass
    kills_today = set()
    try:
        kills_today = set(json.loads(Path(args.kills).read_text()).get(day, []))
    except Exception:
        pass

    con = sqlite3.connect(f'file:{args.snap_db}?mode=ro', uri=True)
    rows = con.execute(
        "SELECT campaign_id, campaign_name, account_name, MAX(COALESCE(spend,0)), "
        "MAX(COALESCE(revenue,0)), MAX(COALESCE(daily_budget,0)) "
        "FROM campaign_hourly_snapshots WHERE hour_slot LIKE ? GROUP BY campaign_id",
        (day + '%',)).fetchall()
    latest, = con.execute(
        "SELECT MAX(hour_slot) FROM campaign_hourly_snapshots WHERE hour_slot LIKE ?",
        (day + '%',)).fetchone()
    if not latest:
        print('closing report: no snapshots for today yet — skipping')
        return
    status = dict(con.execute(
        "SELECT campaign_id, status FROM campaign_hourly_snapshots WHERE hour_slot=?",
        (latest,)).fetchall())
    max_ts, = con.execute(
        "SELECT MAX(ts) FROM campaign_hourly_snapshots WHERE hour_slot LIKE ?",
        (day + '%',)).fetchone()
    con.close()
    through = (max_ts or latest)[11:16]

    camps = []
    for cid, name, acct, spend, rev, budget in rows:
        p = portal_of(acct)
        if not p or spend <= 0:
            continue
        st = status.get(cid, 'Paused')
        camps.append({
            'id': cid, 'name': name, 'portal': p, 'kind': classify(name),
            'product': product_of(name) or product_fallback(name), 'spend': round(spend),
            'revenue': round(rev), 'roas': _roas(spend, rev), 'budget': round(budget),
            'status': 'Live' if st == 'Active' else 'Closed',
            'block': block_of(name),
            'aud': audience_summary(cid, cache, token),
            'closed_by': ('Auto' if cid in kills_today else 'Manual') if st != 'Active' else '',
        })
    try:
        Path(args.aud_cache).parent.mkdir(parents=True, exist_ok=True)
        Path(args.aud_cache).write_text(json.dumps(cache))
    except Exception as e:
        print(f'  aud-cache save failed: {e}')

    g = lambda k, s: [c for c in camps if c['kind'] == k and c['status'] == s]

    def tile(label, cs):
        n, sp, rv, r = agg(cs)
        return (f'<div class="tile"><div class="tlabel">{label}</div>'
                f'<div class="tn">{n}<span class="tunit">camps</span></div>'
                f'<div class="trow"><span>{inr(sp)} spent</span>{chip(r)}</div>'
                f'<div class="tsub">pixel revenue {inr(rv)}</div></div>')

    tiles = (tile('SALES · LIVE', g('sales', 'Live')) + tile('SALES · CLOSED', g('sales', 'Closed'))
             + tile('RETARGET · LIVE', g('retarget', 'Live'))
             + tile('RETARGET · CLOSED', g('retarget', 'Closed')))

    def camp_row(c):
        closedby = ('<span class="tag auto">AUTO</span>' if c['closed_by'] == 'Auto'
                    else 'manual' if c['status'] == 'Closed' else '—')
        strip = 'livestrip' if c['status'] == 'Live' else 'closedstrip'
        stat = ('<span class="st live">LIVE</span>' if c['status'] == 'Live'
                else '<span class="st closed">CLOSED</span>')
        return (f'<tr class="{strip}"><td class="cname" title="{H.escape(c["name"])}">'
                f'{H.escape(c["name"][:56])}</td>'
                f'<td><span class="tag {c["kind"]}">{c["kind"]}</span></td>'
                f'<td>{stat}</td><td class="num">{inr(c["budget"])}</td>'
                f'<td class="audcell">{H.escape(c["aud"])}</td><td>{closedby}</td>'
                f'<td class="num">{inr(c["spend"])}</td><td class="cnum">{chip(c["roas"])}</td></tr>')

    sections = []
    for pcode, pname in PORTALS:
        pc = [c for c in camps if c['portal'] == pcode]
        if not pc:
            continue
        ncl, spcl, _, rcl = agg([c for c in pc if c['status'] == 'Closed'])
        nlv, splv, _, rlv = agg([c for c in pc if c['status'] == 'Live'])
        _, ssp, _, sr = agg([c for c in pc if c['kind'] == 'sales' and c['status'] == 'Live'])
        _, rsp, _, rr = agg([c for c in pc if c['kind'] == 'retarget' and c['status'] == 'Live'])

        prod = defaultdict(list)
        for c in pc:
            prod[c['product']].append(c)
        maxn = max(len(v) for v in prod.values())
        rows_html = []
        for pr, cs in sorted(prod.items(), key=lambda kv: -sum(c['spend'] for c in kv[1])):
            ncl_p = sum(1 for c in cs if c['status'] == 'Closed')
            nlv_p = len(cs) - ncl_p
            sp_p = sum(c['spend'] for c in cs); rv_p = sum(c['revenue'] for c in cs)
            segs = ''
            if ncl_p:
                segs += f'<span class="seg closedseg" style="width:{max(ncl_p / maxn * 100, 2):.1f}%"></span>'
            if nlv_p:
                segs += f'<span class="seg liveseg" style="width:{max(nlv_p / maxn * 100, 2):.1f}%"></span>'
            body = ''.join(camp_row(c) for c in
                           sorted(cs, key=lambda x: (x['status'] != 'Live', -x['spend'])))
            livetxt = f' · {nlv_p} live' if nlv_p else ''
            rows_html.append(
                f'<details class="prod"><summary><span class="pname">{H.escape(pr)}</span>'
                f'<span class="btrack">{segs}</span>'
                f'<span class="bnum">{ncl_p} closed{livetxt}</span>'
                f'<span class="psp">{inr(sp_p)}</span>{chip(_roas(sp_p, rv_p))}'
                f'<span class="caret">▸</span></summary>'
                f'<div class="ptable"><table><thead><tr><th>Campaign</th><th>Type</th>'
                f'<th>Status</th><th class="num">Budget</th><th>Audience setting</th>'
                f'<th>Closed by</th><th class="num">Spend</th><th class="cnum">ROAS</th></tr>'
                f'</thead><tbody>{body}</tbody></table></div></details>')

        # sales/retarget × live/closed split with ROAS for the portal head
        def cell(kind, st):
            n, sp, _, r = agg([c for c in pc if c['kind'] == kind and c['status'] == st])
            return f'<b>{n}</b> · {inr(sp)} · R <b>{r if r is not None else "–"}</b>'
        split = (f'<div class="splitgrid">'
                 f'<div class="sg h"></div><div class="sg h">ACTIVE</div><div class="sg h">CLOSED</div>'
                 f'<div class="sg l">Sales</div><div class="sg">{cell("sales","Live")}</div>'
                 f'<div class="sg">{cell("sales","Closed")}</div>'
                 f'<div class="sg l">Retarget</div><div class="sg">{cell("retarget","Live")}</div>'
                 f'<div class="sg">{cell("retarget","Closed")}</div></div>')

        # audience-block matrix: active vs closed per block with ROAS
        blocks = {}
        for c in pc:
            blocks.setdefault(c['block'], []).append(c)
        brows = []
        for bname, bcs in sorted(blocks.items(), key=lambda kv: -sum(c['spend'] for c in kv[1])):
            la = [c for c in bcs if c['status'] == 'Live']
            ca = [c for c in bcs if c['status'] == 'Closed']
            nla, spla, _, rla = agg(la)
            nca, spca, _, rca = agg(ca)
            na_chip = '<span class="chip na">–</span>'   # no backslashes in
            # f-string expressions — SyntaxError on Python < 3.12 (GHA is 3.11)
            brows.append(
                f'<tr><td class="pname">{bname}</td>'
                f'<td class="num">{nla or "–"}</td><td class="num">{inr(spla) if spla else "–"}</td>'
                f'<td class="cnum">{chip(rla) if nla else na_chip}</td>'
                f'<td class="num">{nca or "–"}</td><td class="num">{inr(spca) if spca else "–"}</td>'
                f'<td class="cnum">{chip(rca) if nca else na_chip}</td></tr>')
        block_tbl = (f'<div class="card blocktbl"><table><thead>'
                     f'<tr><th>Audience block</th><th class="num">Active</th><th class="num">Spend</th>'
                     f'<th class="cnum">ROAS</th><th class="num">Closed</th><th class="num">Spend</th>'
                     f'<th class="cnum">ROAS</th></tr></thead><tbody>{"".join(brows)}</tbody></table></div>')

        sections.append(
            f'<h2>{pname} <span class="h2sub">({pcode})</span></h2>'
            f'{split}'
            f'{block_tbl}'
            f'<div class="prodlist">{"".join(rows_html)}</div>')

    n_cl, sp_cl, _, r_cl = agg([c for c in camps if c['status'] == 'Closed'])
    n_lv, sp_lv, _, r_lv = agg([c for c in camps if c['status'] == 'Live'])
    n_auto = sum(1 for c in camps if c['closed_by'] == 'Auto')

    css = Path(__file__).with_name('closing_report.css').read_text()
    page = (f'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<title>NTN Closing Report — {now.strftime("%d %b")}</title>'
            f'<style>{css}</style></head><body><div class="wrap">'
            f'<h1><span class="dia">◆</span>&nbsp; NTN CLOSING REPORT &nbsp;<span class="dia">◆</span></h1>'
            f'<div class="stamp">{now.strftime("%d %b %Y")} · data through {through} IST · '
            f'{n_cl} closed / {n_lv} live · tap a product to expand · pixel ROAS</div>'
            f'<div class="tiles">{tiles}</div>'
            f'<div class="legend"><span><span class="sw" style="background:var(--closedc)"></span>Closed</span>'
            f'<span><span class="sw" style="background:var(--live)"></span>Live</span>'
            f'<span>{n_auto} closed by AUTO rule · {n_cl - n_auto} manual</span></div>'
            f'{"".join(sections)}'
            f'<p class="note">Closed = spent today, paused at latest snapshot. Budget = daily '
            f'(ad-set sum for ABO). AUTO = spend≥40% & ROAS≤0.4 rule. Per-campaign ROAS is pixel-attributed.</p>'
            f'</div></body></html>')
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(page)
    print(f'wrote {args.out} — {n_cl} closed / {n_lv} live, through {through} IST '
          f'({sum(1 for c in camps if c["aud"] == "?")} camps uncached-audience)')


if __name__ == '__main__':
    main()
