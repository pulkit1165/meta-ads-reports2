#!/usr/bin/env python3
"""
daily_ops_report.py — the operator's morning "📋 <day>" tab, automated.

Recreates (and fixes) the one-off "📋 24 Jul" daily report the old Antriksh
process generated once and then died. Runs at 9 AM IST for yesterday, writes
one tab per day into the Meta Ads Reports (GHA) sheet. Sections:

  * order count + 80/20 rule (new-campaign budget ≤20% of the day's total)
  * 70/30 core rule — "core" comes from the ⚙️ Core Products tab, which the
    OPERATOR edits as ground-level performance changes (their 27 Jul request:
    "create a functionality where we can change these products"). Keywords are
    substring-matched against campaign names; Active=N rows are ignored.
  * opening budget vs spend (utilisation)
  * ROAS per portal — SHOPIFY-BLENDED from daily_finals (real orders vs Meta
    final spend), NOT pixel; the old report used pixel and overstated NBP
  * product open/close transition vs the previous day
  * 6 PM onwards vs daytime performance (the dayparting signal)

Verdict thresholds: 80/20 → ✅ ≤20% new, 🔴 above. 70/30 → ✅ core ≥70%,
⚠️ 60–70%, 🔴 <60%.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from portal_hourly import portal_of, product_of, SALES_FILTER  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
SHEET_ID = '1hJ3IS2VDtTAEyyJIV__jvts9CMQdYhyxKAfWKtrkUH4'
CONFIG_TAB = '⚙️ Core Products'
PORTAL_LABEL = {'SM': 'Studd Muffyn (SM)', 'SML': 'SM Life (SML)',
                'NBP': 'Nuskhe by Paras (NBP)'}
PORTALS = ['SM', 'SML', 'NBP']


def rupee(v: float) -> str:
    return f'₹{v:,.0f}'


# ── data pulls ────────────────────────────────────────────────────────────
def day_campaigns(snap_db: str, day: str) -> dict:
    """Per-campaign facts for the IST day: budget/spend maxima, created date,
    activity at the first and last snapshot, spend as of 18:00."""
    con = sqlite3.connect(snap_db)
    rows = con.execute(
        "SELECT ts, account_name, campaign_id, campaign_name, daily_budget,"
        "       spend, status FROM campaign_hourly_snapshots"
        " WHERE date(ts,'+330 minutes')=? ORDER BY ts", (day,)).fetchall()
    created = dict(con.execute(
        "SELECT campaign_id, MIN(created_time) FROM campaign_hourly_snapshots"
        " WHERE date(ts,'+330 minutes')=? GROUP BY campaign_id", (day,)))
    con.close()
    if not rows:
        return {}
    ts_all = sorted({r[0] for r in rows})
    first_ts, last_ts = ts_all[0], ts_all[-1]
    six_pm = f'{day}T18:00:00+05:30'
    camps: dict = {}
    for ts, acct, cid, cname, budget, spend, status in rows:
        portal = portal_of(acct)
        if not portal:
            continue
        c = camps.setdefault(cid, {
            'portal': portal, 'name': cname or '', 'budget': 0.0, 'spend': 0.0,
            'spend_18': 0.0, 'active_first': False, 'active_last': False,
            'budget_open': None,
            'created': (created.get(cid) or '')[:10]})
        c['budget'] = max(c['budget'], budget or 0.0)
        if ts == first_ts:
            c['budget_open'] = budget or 0.0
        c['spend'] = max(c['spend'], spend or 0.0)
        if ts <= six_pm:
            c['spend_18'] = max(c['spend_18'], spend or 0.0)
        if ts == first_ts and status == 'Active':
            c['active_first'] = True
        if ts == last_ts and status == 'Active':
            c['active_last'] = True
    return camps


def shopify_split(ntn_db: str, day: str) -> dict:
    """Per-portal full-day and evening (18:00+) Shopify revenue/orders."""
    con = sqlite3.connect(ntn_db)
    out = {p: {'rev': 0.0, 'orders': 0, 'ev_rev': 0.0, 'ev_orders': 0}
           for p in PORTALS}
    for portal, rev, orders in con.execute(
            f"SELECT portal, COALESCE(SUM(total_price),0), COUNT(*)"
            f" FROM shopify_orders WHERE date(created_at,'+330 minutes')=?"
            f" AND {SALES_FILTER} GROUP BY portal", (day,)):
        if portal in out:
            out[portal].update(rev=rev, orders=orders)
    for portal, rev, orders in con.execute(
            f"SELECT portal, COALESCE(SUM(total_price),0), COUNT(*)"
            f" FROM shopify_orders WHERE date(created_at,'+330 minutes')=?"
            f" AND time(created_at,'+330 minutes')>='18:00' AND {SALES_FILTER}"
            f" GROUP BY portal", (day,)):
        if portal in out:
            out[portal].update(ev_rev=rev, ev_orders=orders)
    con.close()
    return out


# ── core-products config (operator-editable sheet tab) ────────────────────
def load_core_config(sh, snap_db: str, day: str) -> dict:
    """Read {portal: [keyword,…]} from the config tab; seed the tab from the
    last 7 days' top products if it doesn't exist yet."""
    try:
        ws = sh.worksheet(CONFIG_TAB)
        rows = ws.get_all_values()
    except Exception:
        rows = None
    if rows is None:
        seed = _seed_core(snap_db, day)
        ws = sh.add_worksheet(title=CONFIG_TAB, rows=100, cols=4)
        header = [
            ['CORE PRODUCTS — EDIT THIS LIST', '', '', ''],
            ['Keyword is matched (case-insensitive) inside campaign names.',
             '', '', ''],
            ['Set Active to N to disable a row. Add rows freely.', '', '', ''],
            ['', '', '', ''],
            ['Portal', 'Keyword', 'Active', 'Note'],
        ]
        body = [[p, kw, 'Y', 'auto-seeded from last 7d revenue — replace with '
                 'your list'] for p, kw in seed]
        ws.update(values=header + body, range_name='A1')
        rows = header + body
        print(f'  seeded {CONFIG_TAB} with {len(body)} keywords — operator '
              f'should edit it')
    cfg: dict = {p: [] for p in PORTALS}
    for r in rows:
        if len(r) >= 3 and r[0].strip() in cfg and r[1].strip() \
                and r[2].strip().upper() != 'N':
            cfg[r[0].strip()].append(r[1].strip().lower())
    return cfg


def _seed_core(snap_db: str, day: str) -> list:
    con = sqlite3.connect(snap_db)
    end = datetime.strptime(day, '%Y-%m-%d')
    start = (end - timedelta(days=6)).strftime('%Y-%m-%d')
    agg: dict = {}
    for acct, cname, rev in con.execute(
            "SELECT account_name, campaign_name, MAX(revenue)"
            " FROM campaign_hourly_snapshots"
            " WHERE date(ts,'+330 minutes') BETWEEN ? AND ?"
            " GROUP BY date(ts,'+330 minutes'), campaign_id", (start, day)):
        portal = portal_of(acct)
        prod = product_of(cname or '')
        if portal and prod:
            agg[(portal, prod)] = agg.get((portal, prod), 0.0) + (rev or 0.0)
    con.close()
    out = []
    for p in PORTALS:
        top = sorted(((v, prod) for (pp, prod), v in agg.items() if pp == p),
                     reverse=True)[:6]
        out += [(p, prod.lower()) for _, prod in top]
    return out


# ── report assembly ───────────────────────────────────────────────────────
def build_rows(day: str, camps: dict, shop: dict,
               finals: dict, finals_prev: dict, core_cfg: dict,
               camps_prev: dict) -> list:
    d = datetime.strptime(day, '%Y-%m-%d')
    rows: list = [
        [f'DAILY REPORT · {d:%-d %B %Y}'],
        [f'Generated {datetime.now(IST):%d %b %Y %H:%M} IST · '
         f'ROAS = Shopify sales / Meta spend · core list: "{CONFIG_TAB}" tab'],
        [],
    ]
    total_orders = sum(shop[p]['orders'] for p in PORTALS)
    rows += [['No. of Orders', total_orders], []]

    # 80/20 — "new" is budget ADDED during the day, matching the operator's
    # original manual report: opening budgets are "existing"; intraday budget
    # raises on old campaigns plus any campaign that appears after the first
    # snapshot all count as new additions.
    rows += [['━━━ 80/20 RULE — new budget additions ≤20% of the day ━━━'],
             ['Portal', 'Existing (opening) ₹', 'New additions ₹', 'Total ₹',
              'New %', 'Verdict']]
    for p in PORTALS:
        mine = [c for c in camps.values() if c['portal'] == p]
        ex = sum(c['budget_open'] for c in mine if c['budget_open'] is not None)
        new = sum(c['budget'] - c['budget_open'] if c['budget_open'] is not None
                  else c['budget'] for c in mine)
        tot = ex + new
        pct = new / tot * 100 if tot else 0
        rows.append([PORTAL_LABEL[p], round(ex), round(new), round(tot),
                     f'{pct:.1f}%', '✅ On rule' if pct <= 20
                     else f'🔴 {pct:.0f}% new — cap is 20%'])
    rows.append([])

    # 70/30 core
    rows += [['━━━ 70/30 — core products (target: core ≥70% of budget) ━━━'],
             ['Portal', 'Core Budget', 'Core %', 'Non-core %', 'Verdict']]
    for p in PORTALS:
        tot = sum(c['budget'] for c in camps.values() if c['portal'] == p)
        # campaign names use underscores; keywords use spaces — normalise both
        core = sum(c['budget'] for c in camps.values()
                   if c['portal'] == p
                   and any(k in re.sub(r'[_\s]+', ' ', c['name'].lower())
                           for k in core_cfg[p]))
        pct = core / tot * 100 if tot else 0
        verdict = ('✅ On rule' if pct >= 70 else
                   '⚠️ Slightly under' if pct >= 60 else '🔴 Core under-funded')
        if not core_cfg[p]:
            verdict = '— no core list yet'
        rows.append([PORTAL_LABEL[p], rupee(core), f'{pct:.1f}%',
                     f'{100 - pct:.1f}%', verdict])
    rows.append([])

    # opening budget vs spend
    rows += [['━━━ OPENING BUDGET vs SPEND ━━━'],
             ['Portal', 'Opening Budget', 'Spend', 'Utilisation %',
              'Unspent/closed']]
    tot_b = tot_s = 0.0
    for p in PORTALS:
        b = sum(c['budget'] for c in camps.values() if c['portal'] == p)
        s = finals.get(p, {}).get('spend') or \
            sum(c['spend'] for c in camps.values() if c['portal'] == p)
        tot_b += b; tot_s += s
        rows.append([PORTAL_LABEL[p], rupee(b), rupee(s),
                     f'{s / b * 100:.0f}%' if b else '—', rupee(b - s)])
    rows.append(['TOTAL', rupee(tot_b), rupee(tot_s),
                 f'{tot_s / tot_b * 100:.0f}%' if tot_b else '—',
                 rupee(tot_b - tot_s)])
    rows.append([])

    # ROAS (Shopify blended)
    rows += [['━━━ ROAS (Shopify sales / Meta spend) ━━━'],
             ['Portal', 'ROAS', 'Previous day', 'Change', 'Orders']]
    for p in PORTALS:
        f, fp = finals.get(p, {}), finals_prev.get(p, {})
        roas = (f.get('sales') or 0) / f['spend'] if f.get('spend') else 0
        prev = (fp.get('sales') or 0) / fp['spend'] if fp.get('spend') else 0
        rows.append([PORTAL_LABEL[p], f'{roas:.2f}x',
                     f'{prev:.2f}x' if prev else '—',
                     f'{roas - prev:+.2f}' if prev else '—',
                     shop[p]['orders']])
    rows.append([])

    # product transition
    rows += [['━━━ PRODUCTS — OPEN / CLOSE TRANSITION ━━━'],
             ['Portal', 'Opening', 'Closed during day', 'Net live at close',
              'Prev-day opening', 'Transition']]
    for p in PORTALS:
        def prods(cs, key):
            return {product_of(c['name']) for c in cs.values()
                    if c['portal'] == p and c[key] and product_of(c['name'])}
        op, end = prods(camps, 'active_first'), prods(camps, 'active_last')
        prev_op = prods(camps_prev, 'active_first') if camps_prev else set()
        diff = len(op) - len(prev_op)
        rows.append([PORTAL_LABEL[p], len(op), len(op - end), len(end),
                     len(prev_op) if camps_prev else '—',
                     ('same as prev day' if diff == 0 else
                      f'{abs(diff)} {"more" if diff > 0 else "less"} than '
                      f'prev day') if camps_prev else '—'])
    rows.append([])

    # 6 PM onwards
    rows += [['━━━ 6 PM ONWARDS PERFORMANCE ━━━'],
             ['Portal', 'Evening Spend', 'Evening Revenue', 'Evening Orders',
              'Evening ROAS', 'Daytime ROAS', 'Lift', 'Evening spend share']]
    T = {'es': 0.0, 'er': 0.0, 'eo': 0, 'ds': 0.0, 'dr': 0.0}
    for p in PORTALS:
        espend = sum(max(c['spend'] - c['spend_18'], 0.0)
                     for c in camps.values() if c['portal'] == p)
        day_spend = finals.get(p, {}).get('spend') or \
            sum(c['spend'] for c in camps.values() if c['portal'] == p)
        erev, eorders = shop[p]['ev_rev'], shop[p]['ev_orders']
        drev = (finals.get(p, {}).get('sales') or shop[p]['rev']) - erev
        dspend = max(day_spend - espend, 0.0)
        eroas = erev / espend if espend else 0
        droas = drev / dspend if dspend else 0
        lift = (f'{(eroas / droas - 1) * 100:.0f}% higher' if droas and eroas > droas
                else f'{(1 - eroas / droas) * 100:.0f}% lower' if droas else '—')
        rows.append([PORTAL_LABEL[p], rupee(espend), rupee(erev), eorders,
                     f'{eroas:.2f}x', f'{droas:.2f}x', lift,
                     f'{espend / day_spend * 100:.0f}%' if day_spend else '—'])
        T['es'] += espend; T['er'] += erev; T['eo'] += eorders
        T['ds'] += dspend; T['dr'] += drev
    eroas = T['er'] / T['es'] if T['es'] else 0
    droas = T['dr'] / T['ds'] if T['ds'] else 0
    rows.append(['TOTAL', rupee(T['es']), rupee(T['er']), T['eo'],
                 f'{eroas:.2f}x', f'{droas:.2f}x',
                 f'{(eroas / droas - 1) * 100:.0f}% higher' if droas else '—',
                 f'{T["es"] / (T["es"] + T["ds"]) * 100:.0f}%'
                 if T['es'] + T['ds'] else '—'])
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--snap-db', default='state/camp_snapshots.db')
    ap.add_argument('--ntn-db', default='state/ntn.db')
    ap.add_argument('--finals', default='state/daily_finals.json')
    ap.add_argument('--date', help='YYYY-MM-DD (default: yesterday IST)')
    ap.add_argument('--sa', default='google-service-account.json')
    ap.add_argument('--dry-run', action='store_true',
                    help='print the tab instead of writing the sheet')
    args = ap.parse_args()

    day = args.date or (datetime.now(IST) - timedelta(days=1)).strftime('%F')
    prev = (datetime.strptime(day, '%Y-%m-%d') - timedelta(days=1)).strftime('%F')
    finals_all = json.loads(Path(args.finals).read_text()) \
        if Path(args.finals).exists() else {}

    import gspread
    gc = gspread.service_account(filename=args.sa)
    sh = gc.open_by_key(SHEET_ID)

    camps = day_campaigns(args.snap_db, day)
    if not camps:
        sys.exit(f'FATAL: no snapshots for {day} — nothing to report')
    rows = build_rows(
        day, camps,
        shopify_split(args.ntn_db, day),
        finals_all.get(day, {}), finals_all.get(prev, {}),
        load_core_config(sh, args.snap_db, day),
        day_campaigns(args.snap_db, prev))

    if args.dry_run:
        for r in rows:
            print(' | '.join(str(c) for c in r))
        return

    tab = f'📋 {datetime.strptime(day, "%Y-%m-%d"):%-d %b}'
    for ws in sh.worksheets():
        if ws.title == tab:
            sh.del_worksheet(ws)
    ws = sh.add_worksheet(title=tab, rows=len(rows) + 20, cols=10)
    ws.update(values=[[str(c) for c in r] for r in rows], range_name='A1')
    # newest report tab right after the config tab at the front
    order = [w for w in sh.worksheets() if w.title == tab] + \
            [w for w in sh.worksheets() if w.title != tab]
    sh.reorder_worksheets(order)
    print(f'wrote {tab}: {len(rows)} rows')


if __name__ == '__main__':
    main()
