#!/usr/bin/env python3
"""Archive-then-delete old daily tabs from the Meta Ads Reports (GHA) sheet.

The sheet accumulates ~7 tabs/day; at 700+ tabs the nightly pipeline dies in
Sheets read-quota 429s (28 Jul tabs went missing exactly this way). This:
  1. exports the ENTIRE spreadsheet as .xlsx (full recoverable archive)
  2. deletes tabs whose parsed date is older than --keep-days (default 45)
     in one batched request (no per-tab API calls)
Tabs without a parseable date (Sheet5, Cumulative Closures, ...) are kept.

Run nightly from daily.yml (incremental: deletes ~7 tabs/night) or manually:
  python3 scripts/v2/sheet_archive_cleanup.py --dry-run
"""
import argparse, gzip, os, re, shutil
from datetime import datetime, timedelta, timezone

import gspread

IST = timezone(timedelta(hours=5, minutes=30))
SHEET_ID = os.environ.get('REPORTS_SHEET_ID') or '1hJ3IS2VDtTAEyyJIV__jvts9CMQdYhyxKAfWKtrkUH4'
MONTHS = {m: i + 1 for i, m in enumerate(
    ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'])}


def tab_date(title):
    """Parse '... 28 JUL 26' / '📋 28 Jul' style titles → date or None."""
    t = title.upper()
    m = re.search(r'(\d{1,2})\s+([A-Z]{3})\s+(\d{2})\b', t)
    if m and m.group(2) in MONTHS:
        return datetime(2000 + int(m.group(3)), MONTHS[m.group(2)], int(m.group(1)), tzinfo=IST)
    m = re.search(r'(\d{1,2})\s+([A-Z]{3})\s*$', t)   # '📋 28 JUL' (no year → assume current)
    if m and m.group(2) in MONTHS:
        now = datetime.now(IST)
        d = datetime(now.year, MONTHS[m.group(2)], int(m.group(1)), tzinfo=IST)
        if d > now + timedelta(days=2):               # future → belongs to last year
            d = d.replace(year=now.year - 1)
        return d
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--keep-days', type=int, default=45)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--archive-dir', default='sheet-archives')
    ap.add_argument('--sa', default=os.environ.get('GOOGLE_SERVICE_ACCOUNT_FILE',
                                                   'google-service-account.json'))
    args = ap.parse_args()

    gc = gspread.service_account(filename=args.sa)
    sh = gc.open_by_key(SHEET_ID)
    cutoff = datetime.now(IST) - timedelta(days=args.keep_days)

    doomed, kept_dated, undated = [], 0, 0
    for ws in sh.worksheets():
        d = tab_date(ws.title)
        if d is None:
            undated += 1
        elif d < cutoff:
            doomed.append(ws)
        else:
            kept_dated += 1
    print(f'{len(doomed)} tabs older than {cutoff:%d %b %Y} · keeping {kept_dated} dated + {undated} undated')
    if not doomed:
        return
    if args.dry_run:
        for ws in doomed[:10]:
            print('  would delete:', ws.title)
        print(f'  ... and {max(0, len(doomed) - 10)} more')
        return

    # 1. full xlsx export (one Drive call — complete archive of every tab)
    os.makedirs(args.archive_dir, exist_ok=True)
    stamp = datetime.now(IST).strftime('%Y-%m-%d')
    out = os.path.join(args.archive_dir, f'meta-ads-reports-{stamp}.xlsx')
    import requests as rq
    from google.oauth2.service_account import Credentials
    from google.auth.transport.requests import Request as GReq
    creds = Credentials.from_service_account_file(
        args.sa, scopes=['https://www.googleapis.com/auth/drive.readonly'])
    creds.refresh(GReq())
    r = rq.get(f'https://www.googleapis.com/drive/v3/files/{SHEET_ID}/export'
               '?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
               headers={'Authorization': f'Bearer {creds.token}'}, timeout=300)
    r.raise_for_status()
    with open(out, 'wb') as f:
        f.write(r.content)
    with open(out, 'rb') as fi, gzip.open(out + '.gz', 'wb') as fo:
        shutil.copyfileobj(fi, fo)
    os.remove(out)
    print(f'archived full sheet → {out}.gz ({os.path.getsize(out + ".gz")//1024} KB)')

    # 2. batched delete (one API call per 100 tabs)
    reqs = [{'deleteSheet': {'sheetId': ws.id}} for ws in doomed]
    for i in range(0, len(reqs), 100):
        sh.batch_update({'requests': reqs[i:i + 100]})
    print(f'deleted {len(doomed)} old tabs')


if __name__ == '__main__':
    main()
