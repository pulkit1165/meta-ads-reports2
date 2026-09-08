#!/usr/bin/env python3
"""Build the hourly 'Today by Website' WhatsApp report: wa_table.json +
wa_table.png (a clean table image, the 'excel screenshot' the operator asked
for). Reuses portal_hourly's dashboard math so numbers always match the page.
"""
import argparse, json, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import portal_hourly as ph  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
PORTAL_NAMES = {'SM': 'Studd Muffyn', 'SML': 'SM Life', 'NBP': 'Nuskhe by Paras', 'ALL': 'All'}


def yesterday_roas(finals_path, yday):
    try:
        f = json.load(open(finals_path)).get(yday, {})
        out = {}
        for p, v in f.items():
            out[p] = round(v['sales'] / v['spend'], 2) if v.get('spend') else None
        if f:
            ts = sum(v.get('sales', 0) for v in f.values())
            tp = sum(v.get('spend', 0) for v in f.values())
            out['ALL'] = round(ts / tp, 2) if tp else None
        return out
    except Exception:
        return {}


def render_png(rows, out_png, stamp, hour_slice=None, data_through=None, window_label=None):
    """Branded report card — Studd Muffyn cream/gold. Template drawn in code,
    numbers overlaid each hour (pixel-exact, no AI drift)."""
    from PIL import Image, ImageDraw, ImageFont
    SC = 2
    CREAM, CARD, GOLD, GOLD_D = '#F6F0E4', '#FFFFFF', '#C9964B', '#8a6a33'
    INK, INK2, LINE = '#2A2320', '#7a6f5e', '#e9e0cf'
    OK, WARN, BAD = '#0f7a38', '#9a6a00', '#c43c3b'

    def font(sz, bold=False):
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

    probe = ImageDraw.Draw(Image.new('RGB', (8, 8)))
    f_h, f_c, f_cb = sans(15, True), sans(16), sans(16, True)
    f_d = sans(12, True)     # up/down % chip

    headers = ['Website', 'Sales', 'Orders', 'Spend', 'ROAS', 'Yday', 'Budget live',
               'Budget left', 'Left %', 'Active %', 'Day %', 'Closed', 'Products']
    def cellvals(r):
        return [r['website'], f"Rs {r['sales']:,.0f}", f"{r['orders']}",
                f"Rs {r['spend']:,.0f}", f"{r['roas'] if r['roas'] is not None else '-'}",
                f"{r['yday'] if r['yday'] is not None else '-'}",
                f"Rs {r['budget_live']:,.0f}", f"Rs {r['budget_left']:,.0f}",
                f"{r['left_pct']:.0f}%", f"{r['active_pct']:.0f}%",
                f"{r['day_pct']:.0f}%", f"Rs {r['closed']:,.0f}", f"{r['products']}"]
    pad = 22 * SC
    widths = []
    for i, h in enumerate(headers):
        w = probe.textlength(h, font=f_h)
        for r in rows:
            w = max(w, probe.textlength(cellvals(r)[i], font=f_cb))
        widths.append(int(w) + pad)

    M = 18 * SC                      # outer margin
    P = 16 * SC                      # card padding
    table_w = sum(widths)
    W = table_w + 2 * (M + P)
    rowh, headh = 40 * SC, 36 * SC
    top_band = 74 * SC
    card1_h = headh + rowh * len(rows) + 2 * P
    card2_h = (headh + (rowh) * len(hour_slice) + 2 * P + 30 * SC) if hour_slice else 0
    H = top_band + card1_h + (14 * SC + card2_h if hour_slice else 0) + 30 * SC

    img = Image.new('RGB', (W, H), CREAM)
    d = ImageDraw.Draw(img)

    # ── header band: gold rule + serif title, like the site headings ──
    ty = 20 * SC
    title = 'NTN  LIVE  REPORT'
    tw = probe.textlength(title, font=font(21, True))
    cx = W // 2
    d.text((cx, ty + 10 * SC), title, font=font(21, True), fill=GOLD_D, anchor='mm')
    dia = 4 * SC
    for sx in (cx - tw / 2 - 26 * SC, cx + tw / 2 + 26 * SC):
        d.polygon([(sx, ty + 10 * SC - dia), (sx + dia, ty + 10 * SC),
                   (sx, ty + 10 * SC + dia), (sx - dia, ty + 10 * SC)], fill=GOLD)
        rx = 60 * SC
        x0 = sx - rx - 8 * SC if sx < cx else sx + 8 * SC
        d.rectangle([x0, ty + 10 * SC, x0 + rx, ty + 10 * SC + SC], fill=GOLD)
    d.text((cx, ty + 34 * SC), stamp, font=sans(13), fill=INK2, anchor='mm')

    def card(x0, y0, x1, y1):
        d.rounded_rectangle([x0, y0, x1, y1], radius=10 * SC, fill=CARD,
                            outline=GOLD, width=SC)

    def roas_chip(x_right, ymid, val):
        col = OK if (val or 0) >= 1.6 else WARN if (val or 0) >= 1.0 else BAD
        txt = f"{val}" if val is not None else '-'
        tw = probe.textlength(txt, font=f_cb)
        d.rounded_rectangle([x_right - tw - 16 * SC, ymid - 11 * SC, x_right, ymid + 11 * SC],
                            radius=11 * SC, fill=col)
        d.text((x_right - 8 * SC, ymid), txt, font=f_cb, fill='#ffffff', anchor='rm')

    # up/down chip drawn to the right of a value: green ▲ / red ▼ / grey =
    DELTA_KEY = {'Sales': 'sales', 'Orders': 'orders', 'Spend': 'spend',
                 'ROAS': 'roas', 'Budget': 'budget'}

    def delta_text(r, hname):
        d = (r.get('delta') or {}).get(DELTA_KEY.get(hname, ''))
        if d is None:
            return None, None
        if d > 0:
            return f'\u25b2{d}%', OK
        if d < 0:
            return f'\u25bc{abs(d)}%', BAD
        return '=', INK2

    def draw_table(y0, hdrs, wds, datarows, vals_fn, deltas=False):
        x0 = M
        card(x0, y0, W - M, y0 + headh + rowh * len(datarows) + 2 * P)
        y = y0 + P
        x = x0 + P
        for hname, w in zip(hdrs, wds):
            anc = 'lm' if hname == 'Website' else 'rm'
            tx = x if hname == 'Website' else x + w - 8 * SC
            d.text((tx, y + headh // 2), hname.upper(), font=sans(12, True),
                   fill=GOLD_D, anchor=anc)
            x += w
        y += headh
        d.rectangle([x0 + P, y, W - M - P, y + SC], fill=LINE)
        for r in datarows:
            vals = vals_fn(r)
            bold = r['website'] == 'All'
            if bold:
                d.rounded_rectangle([x0 + P // 2, y + 3 * SC, W - M - P // 2, y + rowh - 0],
                                    radius=6 * SC, fill='#F6EFD9')
            x = x0 + P
            ymid = y + rowh // 2 + 2 * SC
            for hname, w, val in zip(hdrs, wds, vals):
                dtxt, dcol = delta_text(r, hname) if deltas else (None, None)
                dw = (probe.textlength(dtxt, font=f_d) + 7 * SC) if dtxt else 0
                if dtxt:
                    d.text((x + w - 8 * SC, ymid), dtxt, font=f_d, fill=dcol, anchor='rm')
                if hname == 'ROAS':
                    roas_chip(x + w - 8 * SC - dw, ymid, r['roas'])
                else:
                    anc = 'lm' if hname == 'Website' else 'rm'
                    tx = x if hname == 'Website' else x + w - 8 * SC - dw
                    d.text((tx, ymid), str(val), font=(f_cb if bold else f_c),
                           fill=INK, anchor=anc)
                x += w
            y += rowh
        return y + P

    y_end = draw_table(top_band, headers, widths, rows, cellvals)

    if hour_slice:
        y2 = y_end + 14 * SC
        mheads = ['Website', 'Sales', 'Orders', 'Spend', 'ROAS', 'Budget']
        def mvals(r):
            return [r['website'], f"Rs {r['sales']:,.0f}", f"{r['orders']}",
                    f"Rs {r['spend']:,.0f}", r['roas'],
                    f"Rs {r.get('budget', 0):,.0f}"]
        mw = []
        for i, h in enumerate(mheads):
            w = probe.textlength(h, font=f_h)
            for r in hour_slice:
                w = max(w, probe.textlength(str(mvals(r)[i]), font=f_cb))
                dt, _ = delta_text(r, h)
                if dt:
                    w = max(w, probe.textlength(str(mvals(r)[i]), font=f_cb)
                            + probe.textlength(dt, font=f_d) + 7 * SC)
            mw.append(int(w) + pad)
        # stretch mini table to full width for symmetry
        stretch = (table_w - sum(mw)) // len(mw)
        mw = [w + stretch for w in mw]
        d.text((M + P, y2 + 12 * SC), window_label or f'LAST HOUR  ·  window ending {data_through} IST',
               font=sans(13, True), fill=GOLD_D, anchor='lm')
        draw_table(y2 + 26 * SC, mheads, mw, hour_slice, mvals, deltas=True)

    d.text((cx, H - 14 * SC),
           'Sales: Shopify (cancelled excluded)  ·  Spend: Meta  ·  full-hour aligned',
           font=sans(11), fill=INK2, anchor='mm')
    img.save(out_png)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--snap-db', required=True)
    ap.add_argument('--ntn-db', required=True)
    ap.add_argument('--finals', required=True)
    ap.add_argument('--out-json', default='roas-live/wa_table.json')
    ap.add_argument('--out-png', default='roas-live/wa_table.png')
    ap.add_argument('--day', help='YYYY-MM-DD override (testing/backfill; default today IST)')
    args = ap.parse_args()

    now = datetime.now(IST)
    day = args.day or now.strftime('%Y-%m-%d')
    yday = (datetime.strptime(day, '%Y-%m-%d') - timedelta(days=1)).strftime('%Y-%m-%d')
    rows = ph.build_rows(args.snap_db, args.ntn_db, day)
    tot = ph.summarise(rows)
    yd = yesterday_roas(args.finals, yday)

    # Last COMPLETE hour slice, computed from raw tables so buckets align:
    # spend = cum-spend delta between the H:00 and (H-1):00 snapshots;
    # sales = Shopify orders created inside [(H-1):00, (H-1):59].
    import sqlite3 as _sq
    scon = _sq.connect(args.snap_db)
    snap_hours = [h for (h,) in scon.execute(
        "SELECT DISTINCT hour_slot FROM campaign_hourly_snapshots WHERE hour_slot LIKE ? ORDER BY hour_slot",
        (day + '%',))]
    max_ts, = scon.execute(
        "SELECT MAX(ts) FROM campaign_hourly_snapshots WHERE hour_slot LIKE ?",
        (day + '%',)).fetchone()
    data_through = max_ts[11:16] if max_ts else None
    hour_slice = []
    prev_slice = []
    w_start = w_end = None
    if len(snap_hours) >= 2:
        cur = snap_hours[-1]
        # Baseline = the capture CLOSEST to one hour back (min 25 min away so a
        # near-duplicate capture can't make a 4-minute window — 17 Aug).
        # "Newest slot >=50 min old" was wrong: with a missing snapshot (22 Aug
        # had no 09:00) an 11:28 mid-run rejected the 30-min-old 10:58 capture
        # and reached back to 08:58, reporting 2.5 hours as "last hour".
        slot_ts = dict(scon.execute(
            "SELECT hour_slot, MAX(ts) FROM campaign_hourly_snapshots "
            "WHERE hour_slot LIKE ? GROUP BY hour_slot", (day + '%',)).fetchall())
        cur_dt = datetime.fromisoformat(slot_ts[cur])
        def _age(c):
            return (cur_dt - datetime.fromisoformat(slot_ts[c])).total_seconds() / 60.0
        cands = [c for c in snap_hours[:-1] if _age(c) >= 25]
        prev = min(cands, key=lambda c: abs(_age(c) - 60)) if cands else snap_hours[-2]
        prev_ts = slot_ts[prev]
        window_min = int(round(_age(prev)))
        def spend_at(slot):
            # Carry-forward cumulative: a campaign paused mid-day drops out of
            # later snapshots, but its day-spend must stay in the baseline —
            # summing only the slot's rows made the next hour's delta absorb the
            # whole account (6 Aug: SML "last hour" showed ₹50k of a ₹53k day).
            # MAX(spend) per campaign across all slots up to `slot` == the same
            # `running` logic portal_hourly uses for the dashboard.
            out = {}
            for name, sp in scon.execute(
                    "SELECT account_name, MAX(COALESCE(spend,0)) AS sp "
                    "FROM campaign_hourly_snapshots WHERE hour_slot LIKE ? AND hour_slot <= ? "
                    "GROUP BY campaign_id, account_name", (day + '%', slot)):
                pcode = ph.portal_of(name)
                if pcode: out[pcode] = out.get(pcode, 0) + (sp or 0)
            return out
        # Point-in-time live budget per portal, so budget can be compared
        # hour-over-hour like the flow metrics (spend/sales are cumulative).
        def active_budget_at(slot):
            out = {}
            for name, bud in scon.execute(
                    "SELECT account_name, COALESCE(SUM(daily_budget),0) "
                    "FROM campaign_hourly_snapshots WHERE hour_slot=? AND status='Active' "
                    "GROUP BY account_name", (slot,)):
                pcode = ph.portal_of(name)
                if pcode:
                    out[pcode] = out.get(pcode, 0) + (bud or 0)
            return out

        ncon = _sq.connect(args.ntn_db)

        def window_rows(slot_a, slot_b, ts_a, ts_b):
            """Sales/orders/spend per portal for the window (slot_a → slot_b]."""
            spend_a, spend_b = spend_at(slot_a), spend_at(slot_b)
            t0 = ts_a[11:16] if ts_a else slot_a[-5:]
            t1 = ts_b[11:16] if ts_b else slot_b[-5:]
            sal_m, ord_m = {}, {}
            for pcode, sal, orr in ncon.execute(
                    "SELECT portal, COALESCE(SUM(total_price),0), COUNT(*) FROM shopify_orders "
                    "WHERE substr(created_at,1,10)=? AND substr(created_at,12,5)>=? "
                    "AND substr(created_at,12,5)<? AND cancelled_at IS NULL "
                    "AND COALESCE(source_name,'') != 'Matrixify App' GROUP BY portal",
                    (day, t0, t1)):
                sal_m[pcode] = sal; ord_m[pcode] = orr
            rows_ = []
            ts_, tsp_, to_ = 0, 0, 0
            for pcode in ('SM', 'SML', 'NBP'):
                sal = sal_m.get(pcode, 0); orr = ord_m.get(pcode, 0)
                spd = max(0, spend_b.get(pcode, 0) - spend_a.get(pcode, 0))
                ts_ += sal; tsp_ += spd; to_ += orr
                rows_.append({'website': PORTAL_NAMES[pcode], 'sales': round(sal),
                              'orders': orr, 'spend': round(spd),
                              'roas': round(sal / spd, 2) if spd else None,
                              'budget': round(active_budget_at(slot_b).get(pcode, 0))})
            rows_.append({'website': 'All', 'sales': round(ts_), 'orders': to_,
                          'spend': round(tsp_),
                          'roas': round(ts_ / tsp_, 2) if tsp_ else None,
                          'budget': round(sum(active_budget_at(slot_b).values()))})
            return rows_

        hour_slice = window_rows(prev, cur, prev_ts, max_ts)

        # ── same-length window immediately before, for the up/down comparison ──
        prev_slice = []
        cands2 = [c for c in snap_hours if slot_ts[c] < prev_ts and
                  (datetime.fromisoformat(prev_ts) -
                   datetime.fromisoformat(slot_ts[c])).total_seconds() / 60.0 >= 25]
        if cands2:
            def _age2(c):
                return (datetime.fromisoformat(prev_ts) -
                        datetime.fromisoformat(slot_ts[c])).total_seconds() / 60.0
            prev2 = min(cands2, key=lambda c: abs(_age2(c) - window_min))
            prev_slice = window_rows(prev2, prev, slot_ts[prev2], prev_ts)
        ncon.close()

        # attach % change vs the previous window onto each current row
        if prev_slice:
            pmap = {r['website']: r for r in prev_slice}
            for r in hour_slice:
                b = pmap.get(r['website'])
                if not b:
                    continue
                d = {}
                for k in ('sales', 'orders', 'spend', 'roas', 'budget'):
                    curv, prevv = r.get(k), b.get(k)
                    if curv is None or prevv in (None, 0):
                        continue
                    d[k] = round((curv - prevv) / prevv * 100)
                r['delta'] = d
    scon.close()

    out_rows = []
    for p in ('SM', 'SML', 'NBP', 'ALL'):
        t = tot.get(p, {})
        out_rows.append({
            'website': PORTAL_NAMES[p],
            'sales': round(t.get('rev', 0)), 'orders': t.get('orders', 0),
            'spend': round(t.get('spend', 0)), 'roas': t.get('roas'),
            'yday': yd.get(p),
            'budget_live': round(t.get('active_budget', 0)),
            'budget_left': round(t.get('budget_left', 0)),
            'left_pct': t.get('budget_left_pct', 0) or 0,
            'active_pct': t.get('active_spent_pct', 0) or 0,
            'day_pct': t.get('spent_pct', 0) or 0,
            'closed': round(t.get('closed_budget', 0)),
            'products': t.get('products', 0),
        })
    # The slice card must state the window it actually measured, not assume 1h.
    if hour_slice:
        vs = '   vs previous window' if prev_slice else ''
        if 50 <= window_min <= 75:
            window_label = f'LAST HOUR  ·  window ending {data_through} IST{vs}'
        elif window_min < 50:
            window_label = f'LAST {window_min} MIN  ·  {w_start}–{w_end} IST{vs}'
        else:
            _h, _m = divmod(window_min, 60)
            _d = f'{_h}H {_m}M' if _m else f'{_h}H'
            window_label = f'LAST {_d}  ·  {w_start}–{w_end} IST  (snapshot gap){vs}'
    else:
        window_label = None

    stamp = (f'{now.strftime("%d %b")} · data through {data_through} IST'
             if data_through else now.strftime('%d %b, %H:%M IST'))
    json.dump({'built_at': now.isoformat(timespec='seconds'), 'stamp': stamp,
               'day': day, 'data_through': data_through,
               'window_minutes': (window_min if hour_slice else None),
               'window_label': window_label,
               'hour_slice': hour_slice, 'prev_slice': prev_slice, 'rows': out_rows},
              open(args.out_json, 'w'), indent=1)
    render_png(out_rows, args.out_png, stamp, hour_slice, data_through, window_label)
    print(f'wrote {args.out_json} + {args.out_png} — ALL roas {out_rows[-1]["roas"]}')


if __name__ == '__main__':
    main()
