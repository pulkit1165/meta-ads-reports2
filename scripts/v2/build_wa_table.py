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
    from PIL import Image, ImageDraw, ImageFont
    SC = 1.6  # supersample so WhatsApp compression still reads crisply
    def font(sz, bold=False):
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

    f_head, f_cell, f_cellb = font(19, True), font(20), font(20, True)
    probe = ImageDraw.Draw(Image.new('RGB', (10, 10)))

    headers = ['Website', 'Sales', 'Orders', 'Spend', 'ROAS', 'Yday', 'Budget live',
               'Budget left', 'Left %', 'Active %', 'Day %', 'Closed', 'Products']
    aligns = ['l'] + ['r'] * 12
    def cellvals(r):
        return [r['website'], f"Rs {r['sales']:,.0f}", f"{r['orders']}",
                f"Rs {r['spend']:,.0f}", f"{r['roas'] or '-'}", f"{r['yday'] or '-'}",
                f"Rs {r['budget_live']:,.0f}", f"Rs {r['budget_left']:,.0f}",
                f"{r['left_pct']:.0f}%", f"{r['active_pct']:.0f}%",
                f"{r['day_pct']:.0f}%", f"Rs {r['closed']:,.0f}", f"{r['products']}"]
    # auto width: widest of header/cells + padding (font metrics differ per OS)
    pad = int(30 * SC)
    widths = []
    for i, h in enumerate(headers):
        w = probe.textlength(h, font=f_head)
        for r in rows:
            w = max(w, probe.textlength(cellvals(r)[i], font=f_cellb))
        widths.append(int(w) + pad)

    W = sum(widths) + int(40 * SC)
    rowh, headh, toph = int(52 * SC), int(56 * SC), int(64 * SC)
    extra = (headh + rowh * len(hour_slice) + int(46 * SC)) if hour_slice else 0
    H = toph + headh + rowh * len(rows) + int(28 * SC) + extra
    img = Image.new('RGB', (W, H), '#ffffff')
    d = ImageDraw.Draw(img)
    d.text((int(20 * SC), int(18 * SC)), f'NTN — Today by Website · {stamp}',
           font=font(24, True), fill='#1a1c22')
    y = toph
    d.rectangle([int(12 * SC), y, W - int(12 * SC), y + headh], fill='#eef1f6')
    x = int(20 * SC)
    for hname, w, al in zip(headers, widths, aligns):
        tx = x + (w - int(14 * SC) if al == 'r' else 0)
        d.text((tx, y + int(34 * SC)), hname, font=f_head, fill='#5a6070',
               anchor='rs' if al == 'r' else 'ls')
        x += w
    y += headh
    for i, r in enumerate(rows):
        if r['website'] == 'All':
            d.rectangle([int(12 * SC), y, W - int(12 * SC), y + rowh], fill='#f3f0e8')
        elif i % 2:
            d.rectangle([int(12 * SC), y, W - int(12 * SC), y + rowh], fill='#fafbfc')
        bold = r['website'] == 'All'
        rc = ('#0f7a38' if (r['roas'] or 0) >= 1.6 else
              '#9a6a00' if (r['roas'] or 0) >= 1.0 else '#c43c3b')
        x = int(20 * SC)
        for (hname, w, al), val in zip(zip(headers, widths, aligns), cellvals(r)):
            tx = x + (w - int(14 * SC) if al == 'r' else 0)
            d.text((tx, y + int(34 * SC)), str(val),
                   font=(f_cellb if (bold or hname == 'ROAS') else f_cell),
                   fill=rc if hname == 'ROAS' else '#22252c',
                   anchor='rs' if al == 'r' else 'ls')
            x += w
        y += rowh
    if hour_slice:
        label = f'Last hour · window ending {data_through} IST'
        y += int(18 * SC)
        d.text((int(20 * SC), y + int(4 * SC)), label, font=font(21, True), fill='#1a1c22')
        y += int(34 * SC)
        mheads = ['Website', 'Sales', 'Orders', 'Spend', 'ROAS']
        def mvals(r):
            return [r['website'], f"Rs {r['sales']:,.0f}", f"{r['orders']}",
                    f"Rs {r['spend']:,.0f}", f"{r['roas'] or '-'}"]
        mw = []
        for i, h in enumerate(mheads):
            w = probe.textlength(h, font=f_head)
            for r in hour_slice:
                w = max(w, probe.textlength(mvals(r)[i], font=f_cellb))
            mw.append(int(w) + pad)
        tot_w = sum(mw) + int(16 * SC)
        d.rectangle([int(12 * SC), y, int(12 * SC) + tot_w, y + int(40 * SC)], fill='#eef1f6')
        x = int(20 * SC)
        for hname, w in zip(mheads, mw):
            tx = x + (w - int(14 * SC) if hname != 'Website' else 0)
            d.text((tx, y + int(27 * SC)), hname, font=f_head, fill='#5a6070',
                   anchor='rs' if hname != 'Website' else 'ls')
            x += w
        y += int(40 * SC)
        for r in hour_slice:
            bold = r['website'] == 'All'
            if bold:
                d.rectangle([int(12 * SC), y, int(12 * SC) + tot_w, y + rowh - int(8 * SC)],
                            fill='#f3f0e8')
            rc = ('#0f7a38' if (r['roas'] or 0) >= 1.6 else
                  '#9a6a00' if (r['roas'] or 0) >= 1.0 else '#c43c3b')
            x = int(20 * SC)
            for hname, w, val in zip(mheads, mw, mvals(r)):
                tx = x + (w - int(14 * SC) if hname != 'Website' else 0)
                d.text((tx, y + int(28 * SC)), str(val),
                       font=(f_cellb if (bold or hname == 'ROAS') else f_cell),
                       fill=rc if hname == 'ROAS' else '#22252c',
                       anchor='rs' if hname != 'Website' else 'ls')
                x += w
            y += rowh - int(8 * SC)
    d.text((int(20 * SC), H - int(24 * SC)),
           'Sales = Shopify (cancelled excluded) · Spend = Meta · full-hour aligned · auto-generated',
           font=font(15), fill='#8b8d99')
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
            out = {}
            for name, sp in scon.execute(
                    "SELECT account_name, SUM(spend) FROM campaign_hourly_snapshots WHERE hour_slot=? GROUP BY account_name", (slot,)):
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
                "AND cancelled_at IS NULL GROUP BY portal",
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
