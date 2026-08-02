#!/usr/bin/env python3
"""
Auto-reactivate — revives closed campaigns whose ROAS recovered. LIVE (writes to Meta API).

Revive rule (per operator, 2 Aug 2026):
  campaign is PAUSED  AND  spent > 0 today  AND  today's 1d_click ROAS >= 1.7

Why: campaigns get closed through the day (auto-close + hourly ops closing),
but purchase attribution keeps landing AFTER the pause. A camp closed at ROAS
1.2 can be a 1.7+ winner two hours later — this puts it back to work.

Guardrails (mirrors auto_close.py):
  - only the 6 ROAS-dashboard accounts
  - spend floor ₹500 today (ROAS on tiny spend is noise)
  - each campaign is revived at most ONCE per day (state/auto_reactivate_revives.json);
    if it gets closed again after that, the close wins for the rest of the day
  - never revives a campaign that did not spend today (old paused camps stay paused)
  - every revive is logged to the '🟢 Auto-Reactivated' sheet tab
  - hysteresis vs auto-close is wide (close at <=0.4, revive at >=1.7) — no flapping

Run hourly at :45 IST via EC2 crontab (primary) / auto-close.yml (backup).
DRY_RUN=1 env → log + sheet only, no API writes.
"""

import os, json, requests, time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import gspread
from google.oauth2.service_account import Credentials
from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
STATE_DIR  = Path(os.environ.get('META_REPORTS_STATE_DIR') or (_REPO_ROOT / 'state'))
STATE_DIR.mkdir(parents=True, exist_ok=True)
load_dotenv(_REPO_ROOT / '.env')

TOKEN    = os.getenv('META_ACCESS_TOKEN')
SA_FILE  = os.environ.get('GOOGLE_SERVICE_ACCOUNT_FILE') or str(_REPO_ROOT / 'google-service-account.json')
SHEET_ID = os.environ.get('REPORTS_SHEET_ID') or '1hJ3IS2VDtTAEyyJIV__jvts9CMQdYhyxKAfWKtrkUH4'
GRAPH    = 'https://graph.facebook.com/v21.0'
IST      = ZoneInfo('Asia/Kolkata')
DRY_RUN  = os.environ.get('DRY_RUN', '') == '1'

REVIVE_ROAS = 1.70   # today's 1d_click ROAS at/above this → reactivate
MIN_SPEND   = 500    # ₹ floor so tiny campaigns don't trigger on noise

STATE_FILE = STATE_DIR / 'auto_reactivate_revives.json'
TAB        = '🟢 Auto-Reactivated'

# Same 6 accounts as auto_close.py / the ROAS dashboard
ACCOUNTS = [
    ('SM Fragrance',     'act_466922745634023',   'SM'),
    ('SM Crystals',      'act_1181596092752041',  'SM'),
    ('NBP Hair/Perfume', 'act_1501832634098072',  'NBP'),
    ('NBP Skin',         'act_1505319823511657',  'NBP'),
    ('SML Skin',         'act_918587349998103',   'SML'),
    ('SML Hair',         'act_1229831035065328',  'SML'),
]


def safe_float(v):
    try: return float(str(v).replace(',', '').strip())
    except: return 0.0


def paginate(endpoint, params, retries=3):
    params = dict(params)
    params['access_token'] = TOKEN
    results = []
    for attempt in range(retries):
        try:
            r = requests.get(f"{GRAPH}/{endpoint}", params=params, timeout=30)
            data = r.json()
            if 'error' in data:
                if data['error'].get('code') == 17:
                    print("  ⏳ Rate limit — waiting 60s..."); time.sleep(60); continue
                print(f"  ⚠️  API error: {data['error'].get('message')}")
                return results
            results.extend(data.get('data', []))
            while 'paging' in data and 'next' in data.get('paging', {}):
                r2 = requests.get(data['paging']['next'], timeout=30)
                data = r2.json()
                results.extend(data.get('data', []))
            return results
        except Exception as e:
            print(f"  ⚠️  Request error (attempt {attempt+1}): {e}")
            time.sleep(5)
    return results


def extract_roas(raw, key='1d_click'):
    if not raw: return 0.0
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                try:
                    return round(float(item.get(key) or item.get('value', 0) or 0), 2)
                except: continue
    return 0.0


def load_state():
    try:
        if STATE_FILE.exists():
            return json.loads(STATE_FILE.read_text())
    except: pass
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=1))


def activate_campaign(cid):
    r = requests.post(f"{GRAPH}/{cid}",
                      data={'status': 'ACTIVE', 'access_token': TOKEN}, timeout=30)
    data = r.json()
    if data.get('success'):
        return True, ''
    return False, str(data.get('error', {}).get('message', data))[:200]


def log_to_sheet(rows):
    if not rows: return
    try:
        creds = Credentials.from_service_account_file(
            SA_FILE, scopes=['https://www.googleapis.com/auth/spreadsheets'])
        sh = gspread.authorize(creds).open_by_key(SHEET_ID)
        try:
            ws = sh.worksheet(TAB)
        except gspread.WorksheetNotFound:
            ws = sh.add_worksheet(title=TAB, rows=2000, cols=12)
            ws.append_row(['Time (IST)', 'Account', 'Portal', 'Campaign', 'Campaign ID',
                           'Spend today ₹', '1D ROAS', 'Rule', 'Result'])
        ws.append_rows(rows, value_input_option='USER_ENTERED')
        print(f"  📝 {len(rows)} row(s) logged to '{TAB}'")
    except Exception as e:
        print(f"  ⚠️  Sheet log failed: {e}")


def main():
    now      = datetime.now(IST)
    date_str = now.strftime('%Y-%m-%d')
    stamp    = now.strftime('%d %b %I:%M %p')
    mode     = 'DRY RUN' if DRY_RUN else 'LIVE'
    print(f"\n🟢 Auto-reactivate [{mode}] — {stamp} IST")
    print(f"   Rule: PAUSED + spent today AND 1D ROAS ≥ {REVIVE_ROAS} (min spend ₹{MIN_SPEND})")

    state = load_state()
    today_revived = set(state.get(date_str, []))
    sheet_rows, newly_revived = [], []

    for acct_name, account_id, portal in ACCOUNTS:
        rows_1d = paginate(f"{account_id}/insights", {
            'level': 'campaign',
            'fields': 'campaign_id,campaign_name,spend,purchase_roas',
            'action_attribution_windows': json.dumps(['1d_click']),
            'time_range': json.dumps({'since': date_str, 'until': date_str}),
            'filtering': json.dumps([{'field': 'spend', 'operator': 'GREATER_THAN', 'value': '0'}]),
            'limit': 500,
        })
        # PAUSED campaigns only — a camp the operator re-opened is already fine,
        # and ACTIVE camps are none of our business here.
        camps_raw = paginate(f"{account_id}/campaigns", {
            'fields': 'id,name,effective_status',
            'effective_status': '["PAUSED"]',
            'limit': 500,
        })
        paused = {c['id']: c for c in camps_raw}
        checked = revived = 0

        for r in rows_1d:
            cid = r.get('campaign_id', '')
            if not cid or cid not in paused:   continue   # still running / not ours
            if cid in today_revived:           continue   # one revive per day max

            spend = safe_float(r.get('spend', 0))
            roas  = extract_roas(r.get('purchase_roas'))
            if spend < MIN_SPEND:              continue
            checked += 1
            if roas < REVIVE_ROAS:             continue

            name = r.get('campaign_name', paused[cid].get('name', cid))
            if DRY_RUN:
                ok, err = True, '(dry run)'
            else:
                ok, err = activate_campaign(cid)
            result = 'REACTIVATED' if ok and not DRY_RUN else ('DRY RUN' if DRY_RUN else f'FAILED: {err}')
            print(f"  {'🟢' if ok else '❌'} {portal} {name[:60]}  spend ₹{spend:,.0f}  ROAS {roas}  → {result}")
            sheet_rows.append([stamp, acct_name, portal, name, cid,
                               round(spend), roas, f'ROAS ≥ {REVIVE_ROAS}', result])
            if ok and not DRY_RUN:
                today_revived.add(cid); revived += 1
                newly_revived.append(f'{portal} {name[:40]} (R{roas})')

        print(f"  {acct_name}: {checked} paused-with-spend checked, {revived} revived")

    state[date_str] = sorted(today_revived)
    for k in sorted(state)[:-7]:   # keep only the last 7 days of state
        del state[k]
    save_state(state)
    log_to_sheet(sheet_rows)
    print(f"\nDone — {len(newly_revived)} campaign(s) reactivated." +
          (('\n  ' + '\n  '.join(newly_revived)) if newly_revived else ''))


if __name__ == '__main__':
    main()
