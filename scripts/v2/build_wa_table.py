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


def render_png(rows, out_png, stamp, hour_slice=None, data_through=None):
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

    def draw_table(y0, hdrs, wds, datarows, vals_fn):
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
                if hname == 'ROAS':
                    rv = r['roas']
                    roas_chip(x + w - 8 * SC, ymid, rv)
                else:
                    anc = 'lm' if hname == 'Website' else 'rm'
                    tx = x if hname == 'Website' else x + w - 8 * SC
                    d.text((tx, ymid), str(val), font=(f_cb if bold else f_c),
                           fill=INK, anchor=anc)
                x += w
            y += rowh
        return y + P

    y_end = draw_table(top_band, headers, widths, rows, cellvals)

    if hour_slice:
        y2 = y_end + 14 * SC
        mheads = ['Website', 'Sales', 'Orders', 'Spend', 'ROAS']
        def mvals(r):
            return [r['website'], f"Rs {r['sales']:,.0f}", f"{r['orders']}",
                    f"Rs {r['spend']:,.0f}", r['roas']]
        mw = []
        for i, h in enumerate(mheads):
            w = probe.textlength(h, font=f_h)
            for r in hour_slice:
                w = max(w, probe.textlength(str(mvals(r)[i]), font=f_cb))
            mw.append(int(w) + pad)
        # stretch mini table to full width for symmetry
        stretch = (table_w - sum(mw)) // len(mw)
        mw = [w + stretch for w in mw]
        d.text((M + P, y2 + 12 * SC), f'LAST HOUR  ·  window ending {data_through} IST',
               font=sans(13, True), fill=GOLD_D, anchor='lm')
        draw_table(y2 + 26 * SC, mheads, mw, hour_slice, mvals)

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
    args = ap.parse_args()

    now = datetime.now(IST)
    day = now.strftime('%Y-%m-%d')
    yday = (now - timedelta(days=1)).strftime('%Y-%m-%d')
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
    if len(snap_hours) >= 2:
        cur, prev = snap_hours[-1], snap_hours[-2]
        prev_ts, = scon.execute(
            "SELECT MAX(ts) FROM campaign_hourly_snapshots WHERE hour_slot=?", (prev,)).fetchone()
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
        sc, sp_ = spend_at(cur), spend_at(prev)
        ncon = _sq.connect(args.ntn_db)
        w_start = prev_ts[11:16] if prev_ts else prev[-5:]
        w_end = max_ts[11:16] if max_ts else cur[-5:]
        sales_h, orders_h = {}, {}
        for pcode, sal, orr in ncon.execute(
                "SELECT portal, COALESCE(SUM(total_price),0), COUNT(*) FROM shopify_orders "
                "WHERE substr(created_at,1,10)=? AND substr(created_at,12,5)>=? AND substr(created_at,12,5)<? "
                "AND cancelled_at IS NULL AND COALESCE(source_name,'') != 'Matrixify App' GROUP BY portal",
                (day, w_start, w_end)):
            sales_h[pcode] = sal; orders_h[pcode] = orr
        ncon.close()
        tot_s = tot_sp = tot_o = 0
        for pcode in ('SM', 'SML', 'NBP'):
            sal = sales_h.get(pcode, 0); orr = orders_h.get(pcode, 0)
            spd = max(0, sc.get(pcode, 0) - sp_.get(pcode, 0))
            tot_s += sal; tot_sp += spd; tot_o += orr
            hour_slice.append({'website': PORTAL_NAMES[pcode], 'sales': round(sal),
                'orders': orr, 'spend': round(spd),
                'roas': round(sal / spd, 2) if spd else None})
        hour_slice.append({'website': 'All', 'sales': round(tot_s), 'orders': tot_o,
            'spend': round(tot_sp), 'roas': round(tot_s / tot_sp, 2) if tot_sp else None})
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
    stamp = (f'{now.strftime("%d %b")} · data through {data_through} IST'
             if data_through else now.strftime('%d %b, %H:%M IST'))
    json.dump({'built_at': now.isoformat(timespec='seconds'), 'stamp': stamp,
               'day': day, 'data_through': data_through,
               'hour_slice': hour_slice, 'rows': out_rows},
              open(args.out_json, 'w'), indent=1)
    render_png(out_rows, args.out_png, stamp, hour_slice, data_through)
    print(f'wrote {args.out_json} + {args.out_png} — ALL roas {out_rows[-1]["roas"]}')


if __name__ == '__main__':
    main()
