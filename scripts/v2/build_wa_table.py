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


def render_png(rows, out_png, stamp):
    from PIL import Image, ImageDraw, ImageFont
    def font(sz, bold=False):
        try:
            p = ('/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold
                 else '/System/Library/Fonts/Supplemental/Arial.ttf')
            return ImageFont.truetype(p, sz)
        except Exception:
            try:
                p = ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold
                     else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
                return ImageFont.truetype(p, sz)
            except Exception:
                return ImageFont.load_default()

    cols = [('Website', 190, 'l'), ('Sales', 110, 'r'), ('Orders', 75, 'r'),
            ('Spend', 110, 'r'), ('ROAS', 70, 'r'), ('Yday', 65, 'r'),
            ('Budget live', 115, 'r'), ('Budget left', 115, 'r'), ('Left %', 85, 'r'),
            ('Active %', 100, 'r'), ('Day %', 85, 'r'), ('Closed', 115, 'r'),
            ('Products', 100, 'r')]
    W = sum(c[1] for c in cols) + 40
    rowh, headh, toph = 52, 56, 64
    H = toph + headh + rowh * len(rows) + 28
    img = Image.new('RGB', (W, H), '#ffffff')
    d = ImageDraw.Draw(img)
    d.text((20, 18), f'NTN — Today by Website · {stamp}', font=font(24, True), fill='#1a1c22')
    y = toph
    d.rectangle([12, y, W - 12, y + headh], fill='#eef1f6')
    x = 20
    for name, w, al in cols:
        tx = x + (w - 14 if al == 'r' else 0)
        d.text((tx, y + 17), name, font=font(19, True), fill='#5a6070',
               anchor='rs' if al == 'r' else 'ls')
        x += w
    y += headh
    for i, r in enumerate(rows):
        if r['website'] == 'All':
            d.rectangle([12, y, W - 12, y + rowh], fill='#f3f0e8')
        elif i % 2:
            d.rectangle([12, y, W - 12, y + rowh], fill='#fafbfc')
        x = 20
        bold = r['website'] == 'All'
        roas_col = ('#0f7a38' if (r['roas'] or 0) >= 1.6 else
                    '#9a6a00' if (r['roas'] or 0) >= 1.0 else '#c43c3b')
        cells = [r['website'], f"Rs {r['sales']:,.0f}", f"{r['orders']}",
                 f"Rs {r['spend']:,.0f}", f"{r['roas'] or '-'}", f"{r['yday'] or '-'}",
                 f"Rs {r['budget_live']:,.0f}", f"Rs {r['budget_left']:,.0f}",
                 f"{r['left_pct']:.0f}%", f"{r['active_pct']:.0f}%",
                 f"{r['day_pct']:.0f}%", f"Rs {r['closed']:,.0f}", f"{r['products']}"]
        for (name, w, al), val in zip(cols, cells):
            color = roas_col if name == 'ROAS' else '#22252c'
            tx = x + (w - 14 if al == 'r' else 0)
            d.text((tx, y + 15), str(val), font=font(20, bold or name == 'ROAS'),
                   fill=color, anchor='rs' if al == 'r' else 'ls')
            x += w
        y += rowh
    d.text((20, H - 24), 'Sales = Shopify (cancelled excluded) · Spend = Meta · auto-generated',
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
    stamp = now.strftime('%d %b, %H:%M IST')
    json.dump({'built_at': now.isoformat(timespec='seconds'), 'stamp': stamp,
               'day': day, 'rows': out_rows}, open(args.out_json, 'w'), indent=1)
    render_png(out_rows, args.out_png, stamp)
    print(f'wrote {args.out_json} + {args.out_png} — ALL roas {out_rows[-1]["roas"]}')


if __name__ == '__main__':
    main()
