#!/usr/bin/env python3
"""
build_yday_report.py — portal-wise "yesterday final" WhatsApp report feed.

For yesterday (IST), per portal (SM / SML / NBP) + ALL:
  * sales / orders / spend / ROAS   — from frozen daily_finals.json (Ads-Manager-
    exact spend, full-day Shopify sales; never intra-day approximations)
  * budget allocated                — sum of daily_budget of campaigns that were
    Active at any hourly snapshot yesterday (last-seen budget per campaign)
  * budget closed                   — of that, campaigns already Paused at the
    22:00 IST snapshot ("closed during the day")
  * live after 10 PM                — budget still Active at the 22:00 snapshot
  * vs day-before                   — % change in spend, orders, sales; ROAS delta

Writes --out (default roas-live/yday_report.json). The cron worker formats and
sends it at ~9 AM IST; /test-yday sends on demand.
"""
import argparse
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from portal_hourly import PORTALS, portal_of  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))


def budget_split(snap_db: str, day: str) -> dict:
    """{portal: {'alloc': .., 'closed': .., 'live_10pm': ..}} from hourly snapshots.

    A campaign counts as allocated if it was Active at any snapshot of `day`.
    Its closed/live split comes from its status at the 22:00 slot, falling back
    to its last snapshot of the day (campaign vanished = treat as closed).
    """
    out = {p: {'alloc': 0.0, 'closed': 0.0, 'live_10pm': 0.0} for p in PORTALS}
    con = sqlite3.connect(f'file:{snap_db}?mode=ro', uri=True)
    try:
        rows = con.execute(
            "SELECT campaign_id, account_name, hour_slot, status, COALESCE(daily_budget,0) "
            "FROM campaign_hourly_snapshots WHERE hour_slot LIKE ? || ' %' "
            "ORDER BY campaign_id, hour_slot", (day,)).fetchall()
    finally:
        con.close()
    camps = {}
    for cid, acct, slot, status, budget in rows:
        c = camps.setdefault(cid, {'portal': portal_of(acct), 'ever_active': False,
                                   'budget': 0.0, 'at10': None, 'last': None})
        if status == 'Active':
            c['ever_active'] = True
        if budget:
            c['budget'] = budget
        c['last'] = status
        if slot.endswith(' 22:00'):
            c['at10'] = status
    for c in camps.values():
        p = c['portal']
        if not p or not c['ever_active'] or not c['budget']:
            continue
        out[p]['alloc'] += c['budget']
        if (c['at10'] or c['last']) == 'Active':
            out[p]['live_10pm'] += c['budget']
        else:
            out[p]['closed'] += c['budget']
    return out


def finals_day(finals: dict, day: str) -> dict:
    """{portal: {'sales':., 'orders':., 'spend':., 'roas':.}} for a frozen day."""
    e = finals.get(day, {})
    out = {}
    for p, v in e.items():
        sp = float(v.get('spend') or 0)
        out[p] = {'sales': float(v.get('sales') or 0), 'orders': int(v.get('orders') or 0),
                  'spend': sp, 'roas': round(float(v.get('sales') or 0) / sp, 2) if sp else None}
    return out


def pct(new, old):
    return round((new - old) / old * 100, 1) if old else None


def render_png(out: dict, out_png: str):
    """Branded card in the wa_table style — main table + day-over-day card."""
    from PIL import Image, ImageDraw, ImageFont
    SC = 2
    CREAM, CARD, GOLD, GOLD_D = '#F6F0E4', '#FFFFFF', '#C9964B', '#8a6a33'
    INK, INK2, LINE = '#2A2320', '#7a6f5e', '#e9e0cf'
    OK, WARN, BAD = '#0f7a38', '#9a6a00', '#c43c3b'
    NAMES = {'SM': 'Studd Muffyn', 'SML': 'SM Life', 'NBP': 'Nuskhe by Paras'}

    def sans(sz, bold=False):
        sz = int(sz * SC)
        for path in (('/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold
                      else '/System/Library/Fonts/Supplemental/Arial.ttf'),
                     ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold
                      else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')):
            try:
                return ImageFont.truetype(path, sz)
            except Exception:
                continue
        return ImageFont.load_default()

    def serif(sz, bold=False):
        sz = int(sz * SC)
        for path in (('/System/Library/Fonts/Supplemental/Georgia Bold.ttf' if bold
                      else '/System/Library/Fonts/Supplemental/Georgia.ttf'),
                     ('/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf' if bold
                      else '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf')):
            try:
                return ImageFont.truetype(path, sz)
            except Exception:
                continue
        return ImageFont.load_default()

    probe = ImageDraw.Draw(Image.new('RGB', (8, 8)))
    f_c, f_cb = sans(16), sans(16, True)

    allrows = out['rows'] + [dict(out['all'], portal='ALL')]
    def label(r):
        return 'All' if r['portal'] == 'ALL' else NAMES.get(r['portal'], r['portal'])

    H1 = ['Website', 'Sales', 'Orders', 'Budget', 'Spend', 'Spent %', 'ROAS', 'Closed', 'Live @10PM']
    def v1(r):
        spct = f"{r['spend'] / r['budget_alloc'] * 100:.0f}%" if r['budget_alloc'] else '-'
        return [label(r), f"Rs {r['sales']:,}", f"{r['orders']}",
                f"Rs {r['budget_alloc']:,}", f"Rs {r['spend']:,}", spct,
                f"{r['roas'] if r['roas'] is not None else '-'}",
                f"Rs {r['budget_closed']:,}", f"Rs {r['live_10pm']:,}"]

    def sgn(v, suff='%'):
        return '–' if v is None else f"{'+' if v > 0 else ''}{v}{suff}"
    H2 = ['Website', 'Sales', 'Orders', 'Spend', 'Spent %', 'ROAS']
    def v2(r):
        v = r['vs_prev']
        sp, spp = r.get('spent_pct'), r.get('spent_pct_prev')
        spent = (f"{spp:.0f}% > {sp:.0f}%" if sp is not None and spp is not None
                 else f"{sp:.0f}%" if sp is not None else '–')
        return [label(r), sgn(v['sales_pct']), sgn(v['orders_pct']),
                sgn(v['spend_pct']), spent, sgn(v['roas_delta'], '')]

    pad = 22 * SC
    def colw(hdrs, vals_fn):
        ws = []
        for i, h in enumerate(hdrs):
            w = probe.textlength(h, font=sans(15, True))
            for r in allrows:
                w = max(w, probe.textlength(vals_fn(r)[i], font=f_cb))
            ws.append(int(w) + pad)
        return ws
    w1, w2 = colw(H1, v1), colw(H2, v2)
    M, P = 18 * SC, 16 * SC
    rowh, headh = 40 * SC, 36 * SC
    table_w = max(sum(w1), sum(w2))
    if sum(w2) < table_w:                      # stretch comparison cols to match
        extra = (table_w - sum(w2)) // len(w2)
        w2 = [w + extra for w in w2]
        w2[-1] += table_w - sum(w2)
    W = table_w + 2 * (M + P)
    top_band = 74 * SC
    card1_h = headh + rowh * len(allrows) + 2 * P
    card2_h = headh + rowh * len(allrows) + 2 * P + 30 * SC
    H = top_band + card1_h + 14 * SC + card2_h + 30 * SC

    img = Image.new('RGB', (W, H), CREAM)
    d = ImageDraw.Draw(img)
    ty, cx = 20 * SC, W // 2
    title = 'NTN  YESTERDAY  FINAL'
    tw = probe.textlength(title, font=serif(21, True))
    d.text((cx, ty + 10 * SC), title, font=serif(21, True), fill=GOLD_D, anchor='mm')
    dia = 4 * SC
    for sx in (cx - tw / 2 - 26 * SC, cx + tw / 2 + 26 * SC):
        d.polygon([(sx, ty + 10 * SC - dia), (sx + dia, ty + 10 * SC),
                   (sx, ty + 10 * SC + dia), (sx - dia, ty + 10 * SC)], fill=GOLD)
        rx = 60 * SC
        x0 = sx - rx - 8 * SC if sx < cx else sx + 8 * SC
        d.rectangle([x0, ty + 10 * SC, x0 + rx, ty + 10 * SC + SC], fill=GOLD)
    dd = datetime.strptime(out['day'], '%Y-%m-%d')
    pd = datetime.strptime(out['prev_day'], '%Y-%m-%d')
    d.text((cx, ty + 34 * SC), f"{dd.strftime('%-d %b')} full day · budgets from hourly snapshots",
           font=sans(13), fill=INK2, anchor='mm')

    def draw_table(y0, hdrs, wds, vals_fn, delta_cols=False, note=None):
        x0 = M
        d.rounded_rectangle([x0, y0, W - M, y0 + headh + rowh * len(allrows) + 2 * P],
                            radius=10 * SC, fill=CARD, outline=GOLD, width=SC)
        y = y0 + P
        x = x0 + P
        for hname, w in zip(hdrs, wds):
            anc = 'lm' if hname == 'Website' else 'rm'
            tx = x if hname == 'Website' else x + w - 8 * SC
            d.text((tx, y + headh // 2), hname.upper(), font=sans(12, True), fill=GOLD_D, anchor=anc)
            x += w
        y += headh
        d.rectangle([x0 + P, y, W - M - P, y + SC], fill=LINE)
        for r in allrows:
            vals = vals_fn(r)
            bold = r['portal'] == 'ALL'
            if bold:
                d.rounded_rectangle([x0 + P // 2, y + 3 * SC, W - M - P // 2, y + rowh],
                                    radius=6 * SC, fill='#F6EFD9')
            x = x0 + P
            ymid = y + rowh // 2 + 2 * SC
            for hname, w, val in zip(hdrs, wds, vals):
                if hname == 'ROAS' and not delta_cols:
                    rv = r['roas']
                    col = OK if (rv or 0) >= 1.6 else WARN if (rv or 0) >= 1.0 else BAD
                    txt = f"{rv}" if rv is not None else '-'
                    tw2 = probe.textlength(txt, font=f_cb)
                    xr = x + w - 8 * SC
                    d.rounded_rectangle([xr - tw2 - 16 * SC, ymid - 11 * SC, xr, ymid + 11 * SC],
                                        radius=11 * SC, fill=col)
                    d.text((xr - 8 * SC, ymid), txt, font=f_cb, fill='#ffffff', anchor='rm')
                else:
                    fill = INK
                    if delta_cols and hname != 'Website':
                        fill = OK if val.startswith('+') else BAD if val.startswith('-') else INK2
                    anc = 'lm' if hname == 'Website' else 'rm'
                    tx = x if hname == 'Website' else x + w - 8 * SC
                    d.text((tx, ymid), str(val), font=(f_cb if bold else f_c), fill=fill, anchor=anc)
                x += w
            y += rowh
        return y + P

    y_end = draw_table(top_band, H1, w1, v1)
    d.text((M + 4 * SC, y_end + 16 * SC),
           f"VS {pd.strftime('%-d %b').upper()}  ·  day over day", font=sans(13, True), fill=GOLD_D, anchor='lm')
    draw_table(y_end + 30 * SC, H2, w2, v2, delta_cols=True)
    d.text((cx, H - 14 * SC), 'Sales: Shopify final  ·  Spend: Meta final (Ads Manager)  ·  frozen at 1 AM',
           font=sans(11), fill=INK2, anchor='mm')
    img.save(out_png)
    print(f'wrote {out_png}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--snap-db', default='state/camp_snapshots.db')
    ap.add_argument('--finals', default='state/daily_finals.json')
    ap.add_argument('--out', default='roas-live/yday_report.json')
    ap.add_argument('--day', default=None, help='override "yesterday" (YYYY-MM-DD)')
    args = ap.parse_args()

    now = datetime.now(IST)
    yday = args.day or (now - timedelta(days=1)).strftime('%Y-%m-%d')
    prev = (datetime.strptime(yday, '%Y-%m-%d') - timedelta(days=1)).strftime('%Y-%m-%d')

    finals = json.load(open(args.finals))
    fy, fp = finals_day(finals, yday), finals_day(finals, prev)
    if not fy:
        print(f'yday_report: {yday} not frozen yet — skipping')
        return
    budgets = budget_split(args.snap_db, yday)
    budgets_prev = budget_split(args.snap_db, prev)

    def spent_pct(spend, alloc):
        return round(spend / alloc * 100, 1) if alloc else None

    rows = []
    tot = {'sales': 0.0, 'orders': 0, 'spend': 0.0, 'alloc': 0.0, 'closed': 0.0, 'live_10pm': 0.0}
    ptot = {'sales': 0.0, 'orders': 0, 'spend': 0.0}
    for p in PORTALS:
        y = fy.get(p)
        if not y:
            continue
        b = budgets.get(p, {'alloc': 0, 'closed': 0, 'live_10pm': 0})
        bp = budgets_prev.get(p, {'alloc': 0})
        pv = fp.get(p, {})
        sp_y = spent_pct(y['spend'], b['alloc'])
        sp_p = spent_pct(pv.get('spend') or 0, bp['alloc'])
        rows.append({
            'portal': p,
            'sales': round(y['sales']), 'orders': y['orders'],
            'spend': round(y['spend']), 'roas': y['roas'],
            'budget_alloc': round(b['alloc']), 'budget_closed': round(b['closed']),
            'live_10pm': round(b['live_10pm']),
            'spent_pct': sp_y, 'spent_pct_prev': sp_p,
            'vs_prev': {
                'sales_pct': pct(y['sales'], pv.get('sales') or 0),
                'orders_pct': pct(y['orders'], pv.get('orders') or 0),
                'spend_pct': pct(y['spend'], pv.get('spend') or 0),
                'spent_pct_delta': (round(sp_y - sp_p, 1)
                                    if sp_y is not None and sp_p is not None else None),
                'roas_delta': (round(y['roas'] - pv['roas'], 2)
                               if y['roas'] is not None and pv.get('roas') is not None else None),
            },
        })
        for k in ('sales', 'orders', 'spend'):
            tot[k] += y[k]
        for k in ('alloc', 'closed', 'live_10pm'):
            tot[k] += b[k]
        for k in ('sales', 'orders', 'spend'):
            ptot[k] += pv.get(k) or 0
        ptot['alloc'] = ptot.get('alloc', 0) + bp['alloc']
    all_roas = round(tot['sales'] / tot['spend'], 2) if tot['spend'] else None
    prev_roas = round(ptot['sales'] / ptot['spend'], 2) if ptot['spend'] else None
    all_sp = spent_pct(tot['spend'], tot['alloc'])
    prev_sp = spent_pct(ptot['spend'], ptot.get('alloc', 0))
    out = {
        'day': yday, 'prev_day': prev,
        'built_at': now.isoformat(timespec='seconds'),
        'rows': rows,
        'all': {'sales': round(tot['sales']), 'orders': int(tot['orders']),
                'spend': round(tot['spend']), 'roas': all_roas,
                'budget_alloc': round(tot['alloc']), 'budget_closed': round(tot['closed']),
                'live_10pm': round(tot['live_10pm']),
                'spent_pct': all_sp, 'spent_pct_prev': prev_sp,
                'vs_prev': {'sales_pct': pct(tot['sales'], ptot['sales']),
                            'orders_pct': pct(tot['orders'], ptot['orders']),
                            'spend_pct': pct(tot['spend'], ptot['spend']),
                            'spent_pct_delta': (round(all_sp - prev_sp, 1)
                                                if all_sp is not None and prev_sp is not None else None),
                            'roas_delta': (round(all_roas - prev_roas, 2)
                                           if all_roas is not None and prev_roas is not None else None)}},
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=1))
    try:
        render_png(out, str(Path(args.out).with_suffix('.png')))
    except Exception as e:
        print(f'yday_report: PNG render failed ({e}) — JSON still written')
    print(f"wrote {args.out} — {yday} ALL Rs{out['all']['sales']:,}/Rs{out['all']['spend']:,} "
          f"R{out['all']['roas']} alloc Rs{out['all']['budget_alloc']:,} "
          f"closed Rs{out['all']['budget_closed']:,} live@10pm Rs{out['all']['live_10pm']:,}")


if __name__ == '__main__':
    main()
