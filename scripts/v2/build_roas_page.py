#!/usr/bin/env python3
"""
build_roas_page.py — the hourly ROAS dashboard, deployed to Vercel.

Same numbers as the hourly email, plus an hour-by-hour log for today and a
rolling archive of previous days.

The hourly log is RECONSTRUCTED from campaign_hourly_snapshots + shopify_orders
on every build rather than appended to. That means it is self-healing: an hour
the page build missed still appears the next time the page is built, as long as
the snapshot exists. Appending would have left permanent holes whenever a
deploy failed.

Usage:
  python3 scripts/v2/build_roas_page.py --snap-db state/camp_snapshots.db \
      --ntn-db state/ntn.db --out roas-live/index.html --days 7
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from portal_hourly import (  # noqa: E402
    PORTALS, all_portal_rows, build_rows, closures, latest_snapshot_ts,
    portal_of, slot_times, summarise,
)
from success_lookup import TARGET_ROAS, build_both  # noqa: E402
from camp_closing import build_first_activity, collect  # noqa: E402
from daily_finals import load as load_finals, finals_for  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
WEBSITE = {'SM': 'Studd Muffyn', 'SML': 'SM Life', 'NBP': 'Nuskhe by Paras'}

# One colour per website, used for the dot, the row accent and the hour-summary
# chips. Chosen to stay distinguishable for the common forms of colour blindness
# (blue / teal / amber differ in lightness as well as hue, so they do not rely on
# red-green discrimination).
PORTAL_COLOR = {'SM': '#4f46e5', 'SML': '#0d9488', 'NBP': '#d97706'}

# Minimum gap between Meta/Shopify pulls, matching MIN_GAP in
# .github/workflows/roas-email.yml. The workflow still runs every ~10 minutes
# but only calls the APIs once this much time has passed, so the data refreshes
# roughly hourly. KEEP THE TWO IN SYNC.
MIN_PULL_GAP_MIN = 55

# Liveness thresholds follow from that gap: anything under ~70 minutes means a
# pull is landing on schedule. Tighter values would read DELAYED permanently.
LIVE_MAX_MIN = 70
DELAYED_MAX_MIN = 95


# Pulls happen at the top of each hour (:00) so every hour is captured
# complete — see the "Pull Meta at the top of the hour" step in
# .github/workflows/roas-email.yml.
PULL_MINUTE = 0


def next_update(now, last_pull=None):
    """The next top-of-hour pull. Approximate (GitHub skips ticks) so shown "~"."""
    return now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)

CSS = """
:root{--bg:#f6f7fb;--card:#fff;--line:#e8ecf3;--line2:#f2f4f7;--hair:#eaecf0;
 --ink:#101828;--ink2:#344054;--sec:#475467;--mut:#98a2b3;--mut2:#667085;
 --hover:#f9fafb;--input-bd:#d0d5dd;--now-bg:#f5f8ff;--tot-bg:#fcfcfd;
 --pos:#067647;--pos-bg:#ecfdf3;--neg:#b42318;--neg-bg:#fef3f2;
 --warn-i:#93370d;--warn-bg:#fffaeb;--lead-bg:#101828;--pbox:#f9fafb;
 --watch-i:#3e5a7d;--watch-bg:#eff4fb;--focus:#a4bcfd;--top-bg:#eef7f1;--nav-on:#eef1ff;--nav-on-i:#4338ca}
[data-theme=dark]{--bg:#0c1017;--card:#151a24;--line:#242c3b;--line2:#1d2431;--hair:#242c3b;
 --ink:#f2f4f7;--ink2:#ccd3dd;--sec:#aab2bf;--mut:#606c7f;--mut2:#8b95a6;
 --hover:#1a212e;--input-bd:#303a4d;--now-bg:#16203270;--tot-bg:#171d29;
 --pos:#41d18a;--pos-bg:#10301f;--neg:#ff8177;--neg-bg:#3a1713;
 --warn-i:#f5b955;--warn-bg:#33260e;--lead-bg:#4f46e5;--pbox:#1a2130;
 --watch-i:#9db4d0;--watch-bg:#1b2534;--focus:#3f4d8f;--top-bg:#12301f;--nav-on:#232c4d;--nav-on-i:#aab6ff}
[data-theme=dark] .kpi.lead{border-color:#4f46e5}
[data-theme=dark] .kpi.lead .kl{color:#d6d9ff}
[data-theme=dark] .kpi.lead .ks{color:#b9befa}
[data-theme=dark] .pchip{background:var(--card)}
[data-theme=dark] .pchip:hover{border-color:var(--mut2)}
[data-theme=dark] img,[data-theme=dark] .badge{filter:none}

*{box-sizing:border-box}
body{font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--ink);
     margin:0;background:var(--bg);-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:20px 18px 56px}
.bar{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;justify-content:space-between;
     padding:6px 2px 18px}
.bar h1{font-size:19px;margin:0;color:var(--ink);font-weight:800;letter-spacing:-.01em}
.stamp{font-size:12px;color:var(--mut2)}
.stamp b{color:var(--ink)}
.nxt{display:block;color:var(--mut);font-size:11px;margin-top:3px}
@media(min-width:641px){.stamp{text-align:right}}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#12b76a;margin-right:5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:16px;
      box-shadow:0 1px 2px rgba(16,24,40,.04)}
/* KPI tiles (hero) */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;
     box-shadow:0 1px 2px rgba(16,24,40,.04)}
.kpi .kl{font-size:12px;color:var(--mut2);font-weight:600}
.kpi .kv{font-size:26px;font-weight:800;color:var(--ink);margin-top:6px;letter-spacing:-.02em;
         font-variant-numeric:tabular-nums}
.kpi .ks{font-size:11.5px;color:var(--mut);margin-top:5px;line-height:1.45}
.kpi.lead{background:var(--lead-bg);border-color:var(--lead-bg)}
.kpi.lead .kl{color:var(--mut)}
.kpi.lead .kv{color:#fff;font-size:30px}
.kpi.lead .ks{color:#8b93a7}
.delta{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:6px;vertical-align:3px}
.delta.up{background:var(--pos-bg);color:var(--pos)}
.delta.dn{background:var(--neg-bg);color:var(--neg)}
.delta.mut{background:var(--line2);color:var(--mut2)}
.hero{text-align:center;padding:26px 20px 22px}
.roas{font-size:44px;font-weight:800;color:var(--ink);line-height:1;letter-spacing:-.02em}
.roas span{font-size:16px;font-weight:600;color:var(--mut);margin-left:6px}
.sub{font-size:13px;color:var(--sec);margin-top:10px}
.vs{font-size:12px;color:var(--mut);margin-top:7px}
h2{font-size:13.5px;margin:0 0 14px;color:var(--ink);font-weight:700;letter-spacing:0;text-transform:none}
table{border-collapse:collapse;width:100%;font-size:13.5px;font-variant-numeric:tabular-nums}
th{color:var(--mut);text-align:right;padding:0 8px 9px;font-weight:600;font-size:10.5px;
   text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--hair);white-space:nowrap}
th:first-child,td:first-child{text-align:left}
td{padding:11px 8px;border-bottom:1px solid var(--line2);text-align:right;white-space:nowrap;color:var(--ink2)}
tr:hover td{background:var(--hover)}
tr:last-child td{border-bottom:none}
.site{font-weight:600;color:var(--ink)}
.pdot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px;
      vertical-align:1px}
tr.prow td:first-child{border-left:3px solid transparent;padding-left:12px}
tr.p-SM  td:first-child{border-left-color:#4f46e5}
tr.p-SML td:first-child{border-left-color:#0d9488}
tr.p-NBP td:first-child{border-left-color:#d97706}
.chip{display:inline-block;font-size:11px;font-weight:600;padding:3px 10px;
      border-radius:999px;margin-right:6px;color:#fff}
.c-SM{background:#4f46e5}.c-SML{background:#0d9488}.c-NBP{background:#d97706}
.hsum{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.hlabel{font-weight:700;color:var(--ink);min-width:64px}
.asof{font-size:11px;color:var(--mut);margin-left:2px}
.tot td{font-weight:700;color:var(--ink);border-top:2px solid var(--hair);border-bottom:none;background:var(--tot-bg)}
.up{color:var(--pos);font-weight:600}.dn{color:var(--neg);font-weight:600}.mut{color:var(--mut)}
.big{font-weight:700;font-size:14.5px;color:var(--ink)}
.scroll{overflow-x:auto}
.now td{background:var(--now-bg)}
.gap td{color:var(--mut);font-style:italic}
.sub2{display:block;font-size:10px;color:var(--mut);font-weight:400;margin-top:2px}
/* ROAS predictor */
.pred .row{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.pred label{font-size:11px;color:var(--mut2);font-weight:600;text-transform:uppercase;
            letter-spacing:.05em;display:block;margin-bottom:5px}
.pred .fld{flex:1 1 130px;min-width:120px}
.pred .fld input{width:100%;padding:9px 12px;border:1px solid var(--input-bd);border-radius:10px;
            font-size:15px;font-weight:600;color:var(--ink);background:var(--card);
            font-variant-numeric:tabular-nums}
.pred .fld input:focus{outline:2px solid var(--focus);border-color:#4f46e5}
#p_list input[type=checkbox]{width:15px;height:15px;flex:0 0 auto;margin:0;accent-color:#4f46e5}
#p_list label{text-transform:none;letter-spacing:0;color:var(--ink2);font-weight:500}
#p_find{background:var(--card)}
.pchip{display:inline-block;cursor:pointer;font-size:12px;font-weight:700;padding:6px 14px;
       border-radius:999px;border:1.5px solid var(--input-bd);color:var(--sec);margin-right:6px;background:var(--card)}
.pchip:hover{border-color:var(--mut)}
.pchip.on{color:#fff;border-color:transparent}
.pverd{border-radius:12px;padding:13px 16px;margin-top:8px;font-size:14px;font-weight:600;line-height:1.5}
.pv-yes{background:var(--pos-bg);color:var(--pos)}.pv-no{background:var(--neg-bg);color:var(--neg)}
.pv-warn{background:var(--card)aeb;color:var(--warn-i)}
.pgrid{display:flex;flex-wrap:wrap;gap:12px;margin-top:12px}
.pbox{flex:1 1 150px;min-width:140px;background:var(--hover);border:1px solid var(--line2);border-radius:12px;padding:12px 14px}
.pbox b{display:block;font-size:22px;color:var(--ink);margin-top:3px;letter-spacing:-.01em;
        font-variant-numeric:tabular-nums}
.pbox span{font-size:10.5px;color:var(--mut2);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.pnote{font-size:11.5px;color:var(--mut);margin-top:12px;line-height:1.55}
details{margin-top:10px;border-top:1px solid var(--line2);padding-top:10px}
details:first-of-type{border-top:none}
summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--ink);padding:7px 2px;
        list-style:none;display:flex;justify-content:space-between;gap:12px;border-radius:8px}
summary:hover{background:var(--hover)}
summary::-webkit-details-marker{display:none}
summary::after{content:'\25be';color:var(--mut);font-size:11px}
details[open] summary::after{content:'\25b4'}
summary .m{font-weight:400;color:var(--mut2);font-size:12px}
.run{color:var(--pos);font-weight:700}
.badge{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.06em;
       padding:3px 10px;border-radius:999px;margin-right:8px;vertical-align:1px}
.badge.live{background:var(--pos-bg);color:var(--pos)}
.badge.warnb{background:var(--card)aeb;color:var(--warn-i)}
.badge.dead{background:var(--neg-bg);color:var(--neg)}
#age{font-size:12px;color:var(--sec)}
.dot.stale{background:#f79009}
.warn{color:var(--warn-i);font-weight:600;font-size:11px}
.pulse{animation:pl 1.1s ease-in-out infinite}
@keyframes pl{0%,100%{opacity:1}50%{opacity:.35}}
.act{padding:11px 0;border-bottom:1px solid var(--line2)}
.act:last-child{border-bottom:none}
.nm{font-size:13px;font-weight:600;color:var(--ink)}
.dt{font-size:12px;color:var(--mut2);margin-top:3px}
.tag{display:inline-block;font-size:10px;font-weight:700;padding:3px 9px;border-radius:999px;
     letter-spacing:.05em;margin-right:7px}
.t-pause{background:var(--neg-bg);color:var(--neg)}
.t-review{background:var(--card)aeb;color:var(--warn-i)}
.t-watch{background:var(--watch-bg);color:var(--watch-i)}
.ok{font-size:13px;color:var(--pos);font-weight:600}
.foot{font-size:11px;color:var(--mut);text-align:center;line-height:1.7;padding:8px 8px 0}
/* ── left sidebar shell ── */
.shell{display:flex;max-width:1330px;margin:0 auto;align-items:flex-start}
.side{width:242px;flex:0 0 242px;background:var(--card);color:var(--ink2);padding:20px 14px 26px;
      display:flex;flex-direction:column;gap:16px;position:sticky;top:0;height:100vh;overflow-y:auto;
      border-right:1px solid var(--line)}
.side .brand{font-size:14.5px;font-weight:800;color:var(--ink);padding:2px 10px 14px;border-bottom:1px solid var(--hair)}
.navsec{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;
        color:var(--mut);padding:0 10px;margin:2px 0 4px}
a.nav{display:block;color:var(--ink2);text-decoration:none;font-size:13px;padding:9px 12px;border-radius:9px;font-weight:500}
a.nav:hover{background:#f4f6fb;color:var(--ink)}
a.nav.active{background:var(--nav-on);color:var(--nav-on-i);font-weight:700}
.reports{border:none}
.reports>summary{display:none}
.rlist{display:flex;flex-direction:column;gap:2px;margin-top:2px}
a.ritem{display:flex;justify-content:space-between;align-items:baseline;gap:8px;color:var(--ink2);
        text-decoration:none;font-size:12.5px;padding:8px 12px;border-radius:9px}
a.ritem:hover{background:#f4f6fb;color:var(--ink)}
a.ritem .rd{font-weight:600}
a.ritem .rr{font-size:11px;color:var(--mut);font-variant-numeric:tabular-nums}
a.ritem.top{background:var(--top-bg)}
a.ritem.top .rr{color:var(--pos)}
.rnone{font-size:12px;color:var(--mut);padding:6px 10px;line-height:1.5}
.main{flex:1;min-width:0;max-width:1088px;padding:20px 22px 52px}
@media(max-width:900px){
  .shell{flex-direction:column}
  .side{width:auto;flex:none;position:static;height:auto;padding:12px 12px;gap:10px;border-right:none;
        border-bottom:1px solid var(--line)}
  .side .brand{border-bottom:none;padding-bottom:2px}
  .navsec.hidem{display:none}
  a.nav{display:none}
  .reports>summary{display:block;cursor:pointer;font-size:13px;font-weight:700;color:var(--ink);
        padding:9px 12px;background:var(--line2);border-radius:9px;list-style:none}
  .reports>summary::-webkit-details-marker{display:none}
  .rlist{max-height:44vh;overflow-y:auto;margin-top:6px}
  .main{padding:14px 12px 40px;max-width:none}
  .roas{font-size:36px}.card{padding:15px}.kpi .kv{font-size:22px}.kpi.lead .kv{font-size:24px}
}

.tbtn{cursor:pointer;border:1px solid var(--input-bd);background:var(--card);color:var(--ink);
      border-radius:999px;padding:5px 12px;font-size:13px;line-height:1;vertical-align:2px}
.tbtn:hover{background:var(--hover)}
"""


def rupee(v):
    return f'&#8377;{v:,.0f}'


# Each saved hour repeats the same columns as "Today by website", so the two
# read identically — the hourly block is that table frozen at that hour.
HOUR_COLS = ('<tr><th>Website</th><th>Sales</th><th>Orders</th><th>Spend</th>'
             '<th>ROAS</th><th>Budget live</th><th>Budget left</th>'
             '<th>Left %</th><th>Active spent %</th><th>Day spent %</th>'
             '<th>Budget closed</th><th>Products</th></tr>')


def budget_cells(r, cls=''):
    """The budget-position cells: ₹ left on active budgets, that as a % of
    active budget, spend on active budgets as a % of active budget (dead
    unspent budget on closed campaigns influences neither side), and
    cumulative spend as a % of everything that was live today."""
    c = f' class="{cls}"' if cls else ''
    return (f'<td{c}>{rupee(r["budget_left"])}</td>'
            f'<td{c}>{r["budget_left_pct"]:.0f}%</td>'
            f'<td{c}>{r["active_spent_pct"]:.0f}%</td>'
            f'<td{c}>{r["spent_pct"]:.0f}%</td>')


def hour_blocks(prows, arows, open_last=False, times=None, now=None):
    """One collapsible block per hour holding the full per-website breakdown,
    cumulative as at that hour.

    Values are DAY-TO-DATE, not that hour in isolation: a single hour swings on
    a handful of orders (00:00 read 4.49 on three orders while the day tracked
    1.21), so the saved snapshot answers "where did the day stand at 07:00",
    which is the question worth asking of an archive.
    """
    by = {}
    for r in prows + arows:
        by.setdefault(r['slot'], {})[r['portal']] = r

    out, slots = [], sorted(by)
    for i, slot in enumerate(slots):
        g = by[slot]
        a = g.get('ALL')
        if not a or not a['has_snap'] or not (a['cum_spend'] or a['cum_sales']):
            continue
        chips = ''.join(
            f'<span class="chip c-{p}">{p} {g[p]["cum_roas"]:.2f}</span>'
            for p in PORTALS if g.get(p) and g[p]['cum_spend'])
        body = ''
        for p in PORTALS:
            c = g.get(p)
            if not c or not (c['cum_spend'] or c['active_budget']):
                continue
            body += (
                f'<tr class="prow p-{p}"><td class="site">'
                f'<span class="pdot" style="background:{PORTAL_COLOR[p]}"></span>'
                f'{WEBSITE[p]}</td>'
                f'<td>{rupee(c["cum_sales"])}</td><td>{c["cum_orders"]:,}</td>'
                f'<td>{rupee(c["cum_spend"])}</td>'
                f'<td class="big">{c["cum_roas"]:.2f}</td>'
                f'<td>{rupee(c["active_budget"])}</td>'
                + budget_cells(c) +
                f'<td class="mut">{rupee(c["closed_budget"])}</td>'
                f'<td>{c["products"]}</td></tr>')
        body += (
            f'<tr class="tot"><td>All</td><td>{rupee(a["cum_sales"])}</td>'
            f'<td>{a["cum_orders"]:,}</td><td>{rupee(a["cum_spend"])}</td>'
            f'<td>{a["cum_roas"]:.2f}</td><td>{rupee(a["active_budget"])}</td>'
            + budget_cells(a) +
            f'<td>{rupee(a["closed_budget"])}</td><td>{a["products"]}</td></tr>')

        is_last = (i == len(slots) - 1)
        # An hour labelled 12:00 but measured at 12:08 covers eight minutes, not
        # sixty. Say so, otherwise it reads as "the numbers stopped moving".
        ts = (times or {}).get(slot)
        meas = ''
        if ts:
            hhmm = ts[11:16]
            partial = is_last and now is not None and now.strftime('%Y-%m-%d %H:00') == slot
            meas = (f'<span class="asof">as of {hhmm}'
                    + (' &middot; hour still running' if partial else '')
                    + '</span>')
        out.append(
            f'<details{" open" if (open_last and is_last) else ""}>'
            f'<summary><span class="hsum"><span class="hlabel">{slot[-5:]}</span>'
            f'{chips}{meas}</span>'
            f'<span class="m">ROAS {a["cum_roas"]:.2f} &middot; {rupee(a["cum_sales"])} on '
            f'{rupee(a["cum_spend"])} &middot; {a["products"]} products</span></summary>'
            f'<div class="scroll"><table>{HOUR_COLS}{body}</table></div></details>')
    return out


CLOSE_HEAD = ('<tr><th>Closed at</th><th>Website</th><th>Campaign</th>'
              '<th>Spend</th><th>% of budget</th><th>ROAS</th></tr>')


def closure_rows(items):
    """Newest closure first. '~' because we know the campaign was live at the
    previous snapshot and paused at this one — the actual moment is inside that
    ~10 minute window, not the timestamp itself."""
    out = []
    for r in items:
        when = (f'<span class="mut">before {r["closed_ts"][11:16]}</span>'
                if r['before'] else f'~{r["closed_ts"][11:16]}')
        out.append(
            f'<tr><td>{when}</td><td class="site">{r["portal"]}</td>'
            f'<td style="text-align:left">{r["campaign_name"][:64]}</td>'
            f'<td>{rupee(r["spend"])}</td><td>{r["spend_pct"]:.0f}%</td>'
            f'<td class="big">{r["roas"]:.2f}</td></tr>')
    return out


def gather_reports(out_path):
    """Every archived daily products report, newest first, from the json sidecars
    that build_products_report.py writes next to each dated xlsx."""
    d = Path(out_path).parent / 'reports' / 'archive'
    items = []
    if d.exists():
        for jf in sorted(d.glob('products-report-*.json'), reverse=True):
            try:
                m = json.loads(jf.read_text())
                items.append({
                    'date': m.get('today', jf.stem.replace('products-report-', '')),
                    'stamp': m.get('stamp', ''),
                    'file': f"reports/archive/{jf.with_suffix('.xlsx').name}",
                    'grand': m.get('grand', {}),
                })
            except Exception:
                pass
    return items


def sidebar_html(items):
    """Left nav: brand + a Reports menu listing every archived day as a download."""
    s = ['<nav class="side">',
         '<div class="brand">&#128202; NTN Ads &middot; ROAS</div>',
         '<div><div class="navsec">Live</div>'
         '<a class="nav active" href="#top">Blended ROAS</a></div>',
         '<details class="reports" open>',
         '<summary>&#128193; Reports</summary>',
         '<div class="navsec hidem">Products report &middot; daily 2 PM</div>',
         '<div class="rlist">']
    if items:
        for i, it in enumerate(items):
            try:
                dt = datetime.strptime(it['date'], '%Y-%m-%d'); label = f'{dt:%d %b}'
            except Exception:
                label = it['date']
            roas = it['grand'].get('today_roas', 0) or 0
            top = ' top' if i == 0 else ''
            s.append(f'<a class="ritem{top}" href="{it["file"]}" download '
                     f'title="Products report &mdash; {it.get("stamp","")}">'
                     f'<span class="rd">{label}</span>'
                     f'<span class="rr">{roas:.2f}x</span></a>')
    else:
        s.append('<div class="rnone">No reports yet &mdash; the first one saves '
                 'automatically at 2 PM IST.</div>')
    s.append('</div></details></nav>')
    return '\n'.join(s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--snap-db', default='state/camp_snapshots.db')
    ap.add_argument('--ntn-db', default='state/ntn.db')
    ap.add_argument('--out', default='roas-live/index.html')
    ap.add_argument('--days', type=int, default=7, help='days of archive below today')
    ap.add_argument('--finals', default='state/daily_finals.json',
                    help='frozen end-of-day totals for completed days')
    args = ap.parse_args()

    now = datetime.now(IST)
    day = now.strftime('%Y-%m-%d')

    prows = build_rows(args.snap_db, args.ntn_db, day)
    tot = summarise(prows) if prows else None
    arows = all_portal_rows(prows) if prows else []

    # Yesterday and older days use FROZEN finals (all-day Shopify sales / Meta's
    # final daily spend), not the snapshot sum — the last snapshot of a day is
    # short, badly so now that pulls land at the top of the hour. Falls back to
    # the snapshot computation only if a day hasn't been frozen yet.
    finals = load_finals(args.finals)
    yday_date = (now - timedelta(days=1)).strftime('%Y-%m-%d')
    yday = finals_for(finals, yday_date)
    if yday is None:
        yrows = build_rows(args.snap_db, args.ntn_db, yday_date)
        yday = summarise(yrows) if yrows else None

    con = sqlite3.connect(f'file:{args.snap_db}?mode=ro', uri=True)
    lk16, _ = build_both(args.snap_db, exclude_day=day)
    closing = collect(con, day, lk16, lk16, build_first_activity(con))
    con.close()

    a = tot['ALL'] if tot else {'roas': 0, 'rev': 0, 'spend': 0, 'orders': 0, 'products': 0}
    stamp = now.strftime('%d %b %Y, %H:%M IST')
    # The number that matters is when META SPEND was last measured, not when
    # this HTML was generated. Reporting build time as "last updated" made a
    # 72-minute-old spend figure look current.
    snap_ts = latest_snapshot_ts(args.snap_db, day)
    if snap_ts:
        sdt = datetime.fromisoformat(snap_ts)
        data_age = int((now - sdt).total_seconds() // 60)
        data_txt = f'{sdt:%d %b, %H:%M} IST'
    else:
        data_age, data_txt = 0, 'no snapshot yet'
    nxt = next_update(now, sdt if snap_ts else None)
    mins = round((nxt - now).total_seconds() / 60)
    # Once a pull is overdue, printing its scheduled time reads as a time in the
    # past. Say how late it is instead — that is the useful signal.
    nxt_txt = (f'{nxt:%H:%M} IST &middot; in {mins} min' if mins > 0
               else f'due now &middot; {abs(mins)} min overdue')

    h = [f'<!doctype html><html lang="en"><head><meta charset="utf-8">',
         '<meta name="viewport" content="width=device-width,initial-scale=1">',
         # No login gate (operator's call), so at least keep it out of search
         # indexes — this page shows per-website revenue, spend and budgets.
         '<meta name="robots" content="noindex,nofollow,noarchive">',
         f'<title>ROAS {a["roas"]:.2f} — {day}</title>',
         f'<style>{CSS}</style></head><body><a id="top"></a>',
         # theme applies BEFORE first paint so dark mode never flashes white
         '<script>try{if(localStorage.getItem("roasTheme")==="dark")'
         'document.documentElement.dataset.theme="dark";}catch(e){}</script>',
         f'<div class="shell">{sidebar_html(gather_reports(args.out))}<main class="main">',
         '<div class="bar"><h1>Blended ROAS &mdash; hourly '
         '<button id="themeBtn" class="tbtn" title="light / dark">&#127769;</button></h1>',
         f'<div class="stamp">'
         f'<span id="badge" class="badge live">&#9679; LIVE</span>'
         f'<span id="age"><b>Today&rsquo;s figures through {data_txt}</b> '
         f'&middot; {data_age} min old</span>'
         f'<span class="nxt">Meta &amp; Shopify are measured once at the top of each '
         f'hour, so this is a complete hour &mdash; live ~2 min after it turns. '
         f'Yesterday and earlier are frozen full-day totals, untouched by the hourly pull.</span>'
         f'<span class="nxt" id="chk">checking\u2026</span>'
         f'<span class="nxt" id="nxt">Next update ~{nxt_txt}</span></div></div>']

    # hero — KPI tile row. PRESENTATION ONLY: exactly the same values the old
    # single hero card showed, laid out as stat tiles (Aug 2026 restyle).
    # "sales till HH:MM" — the cutoff stays visible because the operator
    # compares this number against a live Shopify report; without the time it
    # reads as wrong whenever the pipeline is a few minutes behind (26 Jul).
    till = f' till {sdt:%H:%M}' if snap_ts else ''
    if yday:
        y = yday['ALL']
        d = a['roas'] - y['roas']
        cls = 'up' if d > 0 else 'dn' if d < 0 else 'mut'
        delta_chip = f'<span class="delta {cls}">{d:+.2f}</span>'
        delta_sub = f'vs yesterday {y["roas"]:.2f}'
    else:
        delta_chip, delta_sub = '', ''
    lead_sub = ' &middot; '.join(x for x in (delta_sub, f'data{till}' if till else '') if x)
    h.append('<div class="kpis">')
    h.append(f'<div class="kpi lead"><div class="kl">Blended ROAS &middot; {day}</div>'
             f'<div class="kv">{a["roas"]:.2f}{delta_chip}</div>'
             f'<div class="ks">{lead_sub}</div></div>')
    h.append(f'<div class="kpi"><div class="kl">Sales</div>'
             f'<div class="kv">{rupee(a["rev"])}</div>'
             f'<div class="ks">{a["orders"]:,} orders &middot; {a["products"]} products live</div></div>')
    h.append(f'<div class="kpi"><div class="kl">Spend</div>'
             f'<div class="kv">{rupee(a["spend"])}</div>'
             f'<div class="ks">{rupee(a.get("closed_budget", 0))} closed so far</div></div>')
    h.append(f'<div class="kpi"><div class="kl">Budget live</div>'
             f'<div class="kv">{rupee(a.get("active_budget", 0))}</div>'
             f'<div class="ks">{a.get("active_spent_pct", 0):.0f}% of active spent &middot; '
             f'{a.get("spent_pct", 0):.0f}% of day budget spent</div></div>')
    h.append(f'<div class="kpi"><div class="kl">Budget left</div>'
             f'<div class="kv">{rupee(a.get("budget_left", 0))}</div>'
             f'<div class="ks">{a.get("budget_left_pct", 0):.0f}% of live budget still to spend</div></div>')
    h.append('</div>')

    # (The products-report downloads live in the left sidebar — see sidebar_html.)

    # today by website
    if tot:
        h.append('<div class="card"><h2>Today by website</h2><div class="scroll"><table>')
        h.append('<tr><th>Website</th><th>Sales</th><th>Orders</th><th>Spend</th>'
                 '<th>ROAS</th><th>Yesterday</th><th>Budget live</th>'
                 '<th>Budget left</th><th>Left %</th><th>Active spent %</th>'
                 '<th>Day spent %</th><th>Budget closed</th><th>Products</th></tr>')
        for p in PORTALS:
            t = tot[p]
            yv = f'{yday[p]["roas"]:.2f}' if yday else '&mdash;'
            h.append(f'<tr class="prow p-{p}"><td class="site">'
                     f'<span class="pdot" style="background:{PORTAL_COLOR[p]}"></span>'
                     f'{WEBSITE[p]}</td><td>{rupee(t["rev"])}</td>'
                     f'<td>{t["orders"]:,}</td>'
                     f'<td>{rupee(t["spend"])}</td><td class="big">{t["roas"]:.2f}</td>'
                     f'<td class="mut">{yv}</td><td>{rupee(t["active_budget"])}</td>'
                     + budget_cells(t) +
                     f'<td class="mut">{rupee(t["closed_budget"])}</td>'
                     f'<td>{t["products"]}</td></tr>')
        h.append(f'<tr class="tot"><td>All</td><td>{rupee(a["rev"])}</td>'
                 f'<td>{a["orders"]:,}</td>'
                 f'<td>{rupee(a["spend"])}</td><td>{a["roas"]:.2f}</td><td></td>'
                 f'<td>{rupee(a["active_budget"])}</td>'
                 + budget_cells(a) +
                 f'<td>{rupee(a["closed_budget"])}</td>'
                 f'<td>{a["products"]}</td></tr>')
        h.append('</table></div></div>')

    # ── ROAS predictor: pick campaigns to close, see if today reaches target ──
    if tot:
        hours_auto = round(max(0.1, 24 - (sdt.hour + sdt.minute / 60)), 1) if snap_ts else 12.0
        # live campaigns at the latest snapshot — the pick-list. Pixel numbers
        # (campaign revenue/roas) are calibrated to Shopify units per portal so
        # the projection stays in the same currency as the page's blended ROAS.
        pcon = sqlite3.connect(f'file:{args.snap_db}?mode=ro', uri=True)
        crows = pcon.execute(
            "SELECT account_name, campaign_id, campaign_name, COALESCE(spend,0), "
            "COALESCE(revenue,0), COALESCE(daily_budget,0) FROM campaign_hourly_snapshots "
            "WHERE hour_slot=(SELECT MAX(hour_slot) FROM campaign_hourly_snapshots "
            "                 WHERE substr(hour_slot,1,10)=?) "
            "AND substr(hour_slot,1,10)=? AND status='Active' AND COALESCE(daily_budget,0)>0",
            (day, day)).fetchall()
        pcon.close()
        camps, pixel_rev = [], {p: 0.0 for p in PORTALS}
        for acct, cid, cname, sp, prv, bud in crows:
            p = portal_of(acct)
            if not p:
                continue
            pixel_rev[p] += prv
            camps.append({'i': cid, 'p': p, 'n': (cname or cid)[:52],
                          's': round(sp), 'r': round(prv / sp, 2) if sp else 0.0,
                          'b': round(bud), 'l': round(max(0.0, bud - sp))})
        camps.sort(key=lambda c: c['r'])
        pdata = {}
        for p in PORTALS:
            t = tot[p]
            pdata[p] = {'rev': round(t['rev']), 'spend': round(t['spend']),
                        'cal': round(t['rev'] / pixel_rev[p], 3) if pixel_rev[p] else 1.0}
        pdata['ALL'] = {'rev': round(a['rev']), 'spend': round(a['spend']),
                        'cal': round(a['rev'] / sum(pixel_rev.values()), 3)
                               if sum(pixel_rev.values()) else 1.0}
        h.append('<div class="card pred"><h2>ROAS predictor &mdash; close which camps to hit target?</h2>')
        h.append('<div id="pchips">'
                 + ''.join(f'<span class="pchip" data-p="{p}" '
                           f'data-c="{PORTAL_COLOR.get(p, "#12355b")}">'
                           f'{WEBSITE.get(p, "All")}</span>'
                           for p in ('ALL',) + PORTALS) + '</div>')
        h.append('<div class="row">'
                 '<div class="fld"><label>Target ROAS</label>'
                 '<input id="p_target" type="number" step="0.05" value="1.30"></div>'
                 '<div class="fld"><label>Hours left today (auto, IST)</label>'
                 '<input id="p_hours" type="number" disabled '
                 'style="background:var(--line2);color:var(--sec)"></div>'
                 '<div class="fld"><label>Forward ROAS (auto, from camps kept live)</label>'
                 '<input id="p_marg" type="number" disabled '
                 'style="background:var(--line2);color:var(--sec)"></div>'
                 '</div>')
        h.append('<div id="p_out"></div>')
        h.append('<div class="row" style="align-items:center">'
                 '<button id="p_auto" class="pchip" style="border-color:#4f46e5;color:#4f46e5">'
                 '&#9889; Auto-pick worst camps to hit target</button>'
                 '<button id="p_clear" class="pchip">Clear selection</button>'
                 '<span id="p_sel" class="asof"></span>'
                 '<input id="p_find" placeholder="filter campaigns&hellip;" '
                 'style="flex:1 1 160px;padding:7px 10px;border:1px solid #d7dfe9;'
                 'border-radius:8px;font-size:13px"></div>')
        h.append('<div id="p_list" style="max-height:340px;overflow-y:auto;'
                 'border:1px solid var(--line2);border-radius:9px"></div>')
        h.append(f'<div class="pnote">Tick the campaigns you would CLOSE (worst pixel ROAS first). '
                 f'Everything left unticked keeps spending its remaining budget until midnight, '
                 f'earning its own today-ROAS (pixel, calibrated to Shopify per website). '
                 f'Auto-filled from the latest snapshot ({data_txt}); hours tick down live. '
                 f'Closing saves only unspent budget &mdash; spend already gone is sunk.</div>')
        h.append(f'<script>var PRED={json.dumps(pdata)};var CAMPS={json.dumps(camps)};'
                 f'var PRED_HA={hours_auto};</script>')
        h.append("""<script>
(function(){
 var cur='ALL', sel={};
 var rs=function(n){return '\\u20B9'+Math.round(n).toLocaleString('en-IN');};
 function el(id){return document.getElementById(id);}
 function hoursLeftIST(){
  var n=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}));
  return Math.max(0,(24*60-(n.getHours()*60+n.getMinutes()))/60);
 }
 function inScope(c){return cur==='ALL'||c.p===cur;}
 function paint(){
  document.querySelectorAll('#pchips .pchip').forEach(function(c){
    var on=c.dataset.p===cur; c.classList.toggle('on',on);
    c.style.background=on?c.dataset.c:'var(--card)';});
 }
 function renderList(){
  var q=(el('p_find').value||'').toLowerCase();
  var html='';
  CAMPS.filter(inScope).forEach(function(c){
    if(q && c.n.toLowerCase().indexOf(q)<0) return;
    html+='<label style="display:flex;gap:9px;align-items:center;padding:7px 10px;'
      +'border-bottom:1px solid var(--line2);font-size:12.5px;cursor:pointer;'
      +(sel[c.i]?'background:var(--neg-bg)':'')+'">'
      +'<input type="checkbox" data-i="'+c.i+'" '+(sel[c.i]?'checked':'')+'>'
      +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
      +'<span class="pdot" style="background:'
      +({SM:'#4f46e5',SML:'#0d9488',NBP:'#d97706'}[c.p]||'#888')+'"></span>'+c.n+'</span>'
      +'<span style="color:'+(c.r<1?'var(--neg)':'var(--pos)')+';font-weight:700;min-width:44px;text-align:right">'
      +c.r.toFixed(2)+'</span>'
      +'<span class="mut" style="min-width:150px;text-align:right">'+rs(c.s)+' spent &middot; '
      +rs(c.l)+' left</span></label>';
  });
  el('p_list').innerHTML=html||'<div style="padding:14px" class="mut">no campaigns</div>';
  el('p_list').querySelectorAll('input').forEach(function(cb){
    cb.addEventListener('change',function(){sel[cb.dataset.i]=cb.checked;renderList();calc();});});
 }
 function project(closedSet){
  var d=PRED[cur];
  var H=hoursLeftIST();
  var hs=Math.min(1,PRED_HA>0?H/PRED_HA:1);
  var sf=0,wr=0;
  CAMPS.filter(inScope).forEach(function(c){
    if(closedSet[c.i]) return;
    var f=c.l*hs; sf+=f; wr+=c.r*f;
  });
  var rpix=sf>0?wr/sf:0, r=rpix*d.cal;
  var endS=d.spend+sf;
  return {sf:sf,r:r,end:endS>0?(d.rev+r*sf)/endS:0,H:H};
 }
 function calc(){
  var d=PRED[cur];
  var T=parseFloat(el('p_target').value)||0;
  var p0=project({}), p1=project(sel);
  el('p_hours').value=p1.H.toFixed(1);
  el('p_marg').value=p1.r?p1.r.toFixed(2):'0.00';
  var nSel=CAMPS.filter(inScope).filter(function(c){return sel[c.i];});
  var selBud=nSel.reduce(function(s,c){return s+c.b;},0);
  var selSaved=p0.sf-p1.sf;
  el('p_sel').textContent=nSel.length
    ? nSel.length+' camps picked \\u2014 '+rs(selBud)+' daily budget, saves '+rs(selSaved)+' future spend'
    : 'nothing picked';
  var out='<div class="pgrid">'
   +'<div class="pbox"><span>Now</span><b>'+(d.spend>0?(d.rev/d.spend).toFixed(2):'-')+'</b>'
   +rs(d.rev)+' / '+rs(d.spend)+'</div>'
   +'<div class="pbox"><span>Close nothing</span><b>'+p0.end.toFixed(2)+'</b>'
   +'+'+rs(p0.sf)+' spend to come</div>'
   +'<div class="pbox"><span>Close the '+nSel.length+' picked</span><b>'+p1.end.toFixed(2)+'</b>'
   +'+'+rs(p1.sf)+' spend to come</div></div>';
  var verdict;
  if(p1.end>=T){
    verdict='<div class="pverd pv-yes">&#10003; YES \\u2014 '
      +(nSel.length?'closing these '+nSel.length:'even with nothing closed, today')
      +' reaches target '+T.toFixed(2)+' (projected close '+p1.end.toFixed(2)+')</div>';
  } else {
    var best=bestPossible(T);
    verdict='<div class="pverd '+(best.reachable?'pv-warn':'pv-no')+'">'
      +(nSel.length?'&#10007; NOT with these '+nSel.length+' \\u2014 projected close '+p1.end.toFixed(2):'&#10007; Not on track \\u2014 projected close '+p0.end.toFixed(2))
      +(best.reachable
        ?'. Auto-pick can still get there (closing '+best.n+' camps ends at '+best.end.toFixed(2)+').'
        :'. Target is OUT OF REACH today \\u2014 best possible is '+best.end.toFixed(2)
          +' (closing the worst '+best.n+' camps).')
      +'</div>';
  }
  el('p_out').innerHTML=out+verdict;
 }
 function bestPossible(T){
  // greedy: close worst-pixel-ROAS camps one by one, track the best close
  var trial={},best={end:project({}).end,n:0,reachable:project({}).end>=T},k=0;
  var list=CAMPS.filter(inScope);
  for(var i=0;i<list.length;i++){
    trial[list[i].i]=true;k++;
    var e=project(trial).end;
    if(e>best.end){best.end=e;best.n=k;}
    if(e>=T){return {end:e,n:k,reachable:true};}
  }
  best.reachable=best.end>=T;
  return best;
 }
 el('p_auto').addEventListener('click',function(ev){
  ev.preventDefault();
  var T=parseFloat(el('p_target').value)||0;
  sel={};var list=CAMPS.filter(inScope);
  for(var i=0;i<list.length;i++){
    sel[list[i].i]=true;
    if(project(sel).end>=T) break;
  }
  if(project(sel).end<parseFloat(el('p_target').value||0)){/* keep best-effort selection */}
  renderList();calc();
 });
 el('p_clear').addEventListener('click',function(ev){ev.preventDefault();sel={};renderList();calc();});
 el('p_find').addEventListener('input',renderList);
 document.querySelectorAll('#pchips .pchip').forEach(function(c){
   c.addEventListener('click',function(){cur=c.dataset.p;paint();renderList();calc();});});
 el('p_target').addEventListener('input',calc);
 paint();renderList();calc();
 setInterval(calc,60000);
})();
</script>""")
        h.append('</div>')

    # hourly log — the "saved every hour" section
    stimes = slot_times(args.snap_db, day)
    rows = hour_blocks(prows, arows, open_last=True, times=stimes, now=now)
    h.append(f'<div class="card"><h2>Saved every hour &mdash; today ({len(rows)})</h2>')
    h.append(''.join(rows) if rows else
             '<div class="mut">no hours recorded yet today</div>')
    h.append('<div class="foot" style="text-align:left;padding-left:0">'
             'Every hour is saved with the same columns as Today by website, '
             'cumulative to that point in the day. \u201cAs of\u201d is when the '
             'numbers were actually pulled \u2014 the newest hour is normally only '
             'part-way through, so it will look close to the one before it.</div>')
    h.append('</div>')

    # previous days
    # Previous days keep their FULL hour-by-hour table, collapsed by date.
    # Rebuilt from the databases every time, so a day the page never rendered
    # live still appears here complete.
    arch = []
    for i in range(1, args.days + 1):
        d = (now - timedelta(days=i)).strftime('%Y-%m-%d')
        pr = build_rows(args.snap_db, args.ntn_db, d)
        if not pr:
            continue
        # Day totals: sales/spend/ROAS/orders from the frozen finals (accurate),
        # budgets kept from the snapshot (finals don't carry a budget state).
        full = summarise(pr)
        fin = finals_for(finals, d)
        if fin:
            for k in list(PORTALS) + ['ALL']:
                full[k].update({m: fin[k][m] for m in ('rev', 'spend', 'roas', 'orders')})
        if not full['ALL']['spend']:
            continue
        arch.append((d, full, pr, all_portal_rows(pr)))

    if arch:
        h.append('<div class="card"><h2>Saved hours &mdash; previous days</h2>')
        for d, full, pr, ar in arch:
            t = full['ALL']
            label = datetime.strptime(d, '%Y-%m-%d').strftime('%a %d %b %Y')
            per = ' &middot; '.join(f'{p} {full[p]["roas"]:.2f}' for p in PORTALS)
            h.append(
                f'<details><summary><span>{label}</span>'
                f'<span class="m">ROAS {t["roas"]:.2f} &middot; {rupee(t["rev"])} on '
                f'{rupee(t["spend"])} &middot; {t["orders"]:,} orders &middot; {per} '
                f'&middot; {rupee(t["closed_budget"])} closed</span></summary>'
                + ''.join(hour_blocks(pr, ar, times=slot_times(args.snap_db, d)))
                + (lambda cl: (f'<h2 style="margin-top:16px">Closed that day '
                               f'({len(cl)})</h2><div class="scroll"><table>'
                               + CLOSE_HEAD + ''.join(closure_rows(cl))
                               + '</table></div>') if cl else '')(
                      closures(args.snap_db, d))
                + '</details>')
        h.append('</div>')

    # decisions
    act = [r for r in closing if r['verdict'] in
           ('PAUSE', 'PAUSE (not whitelisted)', 'REVIEW', 'WATCH')]
    h.append(f'<div class="card"><h2>Needs a decision &mdash; {len(act)}</h2>')
    if not act:
        h.append('<div class="ok">&#10003; Nothing over-spending below target.</div>')
    for r in act[:20]:
        v = r['verdict']
        cls = ('t-pause' if v.startswith('PAUSE') else
               't-review' if v == 'REVIEW' else 't-watch')
        sr = f", {r['success_rate']}% recover" if r['success_rate'] is not None else ''
        mg = f", 3h {r['marginal_3h']:.2f}" if r['marginal_3h'] is not None else ''
        h.append(f'<div class="act"><div class="nm"><span class="tag {cls}">'
                 f'{v.split(" ")[0]}</span>{r["campaign_name"][:70]}</div>'
                 f'<div class="dt">{r["portal"]} &middot; {r["spend_pct"]:.0f}% of budget '
                 f'&middot; ROAS {r["roas"]:.2f}{mg}{sr}</div></div>')
    h.append('</div>')

    # Closed campaigns, newest first — reconstructed from the status history so
    # a closure during an hour the page never rendered still appears.
    closed_today = closures(args.snap_db, day)
    h.append(f'<div class="card"><h2>Closed campaigns &mdash; today '
             f'({len(closed_today)})</h2>')
    if closed_today:
        h.append('<div class="scroll"><table>' + CLOSE_HEAD
                 + ''.join(closure_rows(closed_today)) + '</table></div>')
        h.append('<div class="foot" style="text-align:left;padding-left:0">'
                 'Time is the first snapshot that saw the campaign paused, so the '
                 'close happened within about 10 minutes before it. '
                 '&ldquo;before HH:MM&rdquo; means it was already off when we '
                 'first saw it that day.</div>')
    else:
        h.append('<div class="ok">&#10003; Nothing closed yet today.</div>')
    h.append('</div>')

    n_scale = sum(1 for r in closing if r['verdict'] == 'SCALE')
    h.append(f'<div class="foot">{len(closing)} campaigns tracked &middot; {n_scale} scale '
             f'candidates &middot; recovery rates from {lk16.n_camp_days} past campaign-days '
             f'at target {TARGET_ROAS}<br>'
             'Blended ROAS counts <b>all</b> Shopify revenue including organic and repeat &mdash; '
             'a profitability read per website, not a campaign metric.<br>'
             'Campaign figures are Meta pixel-attributed. Nothing is paused automatically. '
             'Meta and Shopify are pulled at the top of each hour, so each hour is '
             'captured complete and the board is live within a couple of minutes.</div>')
    # Live status: counts down to the next scheduled rebuild, flips to a pulsing
    # "Refreshing now" once due, then reloads to pick up the new deploy. Paced at
    # 45s so a late build (GitHub queueing) doesn't hammer the page.
    # Liveness monitor. Polls status.json every 2 minutes (no-store, so never a
    # cached answer) and reports whether the pipeline is actually alive rather
    # than just when this HTML happened to be generated. If the poll comes back
    # with a newer data_ts, the page reloads itself so what you are looking at
    # is never behind what has been published.
    #
    # LIVE_MAX_MIN is 15 because that is the real floor: builds land roughly
    # every 5-10 minutes (cron plus the keepalive heartbeat), so anything fresher
    # than 15 minutes means the pipeline is keeping up. Past 25 it is degraded,
    # past 45 something is broken.
    h.append(f'''<script>
var DATA_TS = "{snap_ts or ''}", POLL = 120000,
    LIVE_MAX = {LIVE_MAX_MIN}, DELAYED_MAX = {DELAYED_MAX_MIN};
function fmt(t){{ return t.toTimeString().slice(0,8); }}
function paint(ageMin, checkedAt, ok){{
  var b=document.getElementById('badge'), a=document.getElementById('age'),
      c=document.getElementById('chk');
  if(!b) return;
  if(!ok){{ b.className='badge dead'; b.innerHTML='&#9679; CHECK FAILED'; }}
  else if(ageMin>DELAYED_MAX){{ b.className='badge dead'; b.innerHTML='&#9679; NOT LIVE'; }}
  else if(ageMin>LIVE_MAX){{ b.className='badge warnb'; b.innerHTML='&#9679; DELAYED'; }}
  else {{ b.className='badge live'; b.innerHTML='&#9679; LIVE'; }}
  if(a) a.textContent='data '+ageMin+' min old';
  if(c) c.textContent='live status checked '+fmt(checkedAt)+' \u00b7 rechecks every 2 min';
}}
function check(){{
  fetch('status.json?t='+Date.now(), {{cache:'no-store'}})
    .then(function(r){{ return r.json(); }})
    .then(function(j){{
      var age = Math.max(0, Math.round((Date.now()-new Date(j.data_ts).getTime())/60000));
      paint(age, new Date(), true);
      if(j.data_ts && DATA_TS && j.data_ts !== DATA_TS) location.reload();
    }})
    .catch(function(){{ paint(999, new Date(), false); }});
}}
check(); setInterval(check, POLL);

var NEXT={int(nxt.timestamp() * 1000)};
function tick(){{
  var el=document.getElementById('nxt'); if(!el) return;
  var d=NEXT-Date.now();
  if(d>0){{
    var m=Math.floor(d/60000), s=Math.floor(d%60000/1000);
    el.innerHTML='Next pull ~'+(m>0?m+'m ':'')+('0'+s).slice(-2)+'s';
  }} else {{
    var late=Math.floor((Date.now()-NEXT)/60000);
    el.innerHTML='<span class="run pulse">&#9679; Pull due'
                 +(late>2?' \u00b7 '+late+'m overdue':'\u2026')+'</span>';
  }}
}}
tick(); setInterval(tick,1000);
</script>''')
    # light/dark toggle — presentation only, choice remembered per browser
    h.append("""<script>
(function(){
 var b=document.getElementById('themeBtn'); if(!b) return;
 function set(t){
   if(t==='dark'){document.documentElement.dataset.theme='dark';b.innerHTML='&#9728;&#65039;';}
   else{delete document.documentElement.dataset.theme;b.innerHTML='&#127769;';}
   try{localStorage.setItem('roasTheme',t);}catch(e){}
 }
 set((function(){try{return localStorage.getItem('roasTheme')||'light';}catch(e){return 'light';}})());
 b.addEventListener('click',function(){
   set(document.documentElement.dataset.theme==='dark'?'light':'dark');});
})();
</script>""")
    h.append('</main></div></body></html>')

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text('\n'.join(h), encoding='utf-8')

    # Heartbeat the page polls every 2 minutes. Kept tiny and served no-store
    # (see roas-live/vercel.json) so the check is cheap and never cached — the
    # page can tell whether the pipeline is alive without reloading itself.
    (out.parent / 'status.json').write_text(json.dumps({
        'data_ts': snap_ts,
        'data_age_min': data_age,
        'built_ts': now.isoformat(timespec='seconds'),
        'next_update_ts': nxt.isoformat(timespec='seconds'),
        'roas': a['roas'], 'sales': a['rev'], 'spend': a['spend'],
        'orders': a['orders'], 'products': a['products'],
    }, indent=1), encoding='utf-8')
    print(f'wrote {out} — ROAS {a["roas"]:.2f}, {len(rows)} hour rows, '
          f'{len(arch)} archived days, {len(act)} decisions, stamp {stamp}, '
          f'next ~{nxt:%H:%M} IST')


if __name__ == '__main__':
    main()
