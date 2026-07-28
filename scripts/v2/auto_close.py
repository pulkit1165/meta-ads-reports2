#!/usr/bin/env python3
"""
Auto-close — pauses campaigns that hit the kill rule. LIVE (writes to Meta API).

Kill rule (per operator, backed by ROAS kill-point analysis):
  spend >= 40% of daily budget  AND  today's 1d_click ROAS <= 0.4

Guardrails:
  - only the 6 ROAS-dashboard accounts
  - spend floor ₹500 (small numbers are noise)
  - campaigns must be live ≥2h (lets purchase attribution land; fresh launches
    that bleed all morning are still caught)
  - each campaign is paused at most once per day (state/auto_close_kills.json);
    manual re-enable in Ads Manager is respected for the rest of the day
  - every pause is logged to the '🔴 Auto-Closed' sheet tab

Run twice hourly at :30 and :59 IST, 24h, via .github/workflows/auto-close.yml.
DRY_RUN=1 env → log + sheet only, no pause calls.
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

KILL_SPEND_PCT = 0.40   # spent >= 40% of daily budget
KILL_ROAS      = 0.40   # and 1d ROAS <= 0.4
MIN_SPEND      = 500    # ₹ floor so tiny campaigns don't trigger on noise

STATE_FILE = STATE_DIR / 'auto_close_kills.json'
TAB        = '🔴 Auto-Closed'

# Same 6 accounts as the ROAS dashboard / products report
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


def load_kills():
    try:
        if STATE_FILE.exists():
            return json.loads(STATE_FILE.read_text())
    except: pass
    return {}


def save_kills(kills):
    STATE_FILE.write_text(json.dumps(kills, indent=1))


def pause_campaign(cid):
    r = requests.post(f"{GRAPH}/{cid}",
                      data={'status': 'PAUSED', 'access_token': TOKEN}, timeout=30)
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
                           'Budget ₹', 'Spend ₹', 'Spend %', '1D ROAS', 'Rule', 'Result'])
        ws.append_rows(rows, value_input_option='USER_ENTERED')
        print(f"  📝 {len(rows)} row(s) logged to '{TAB}'")
    except Exception as e:
        print(f"  ⚠️  Sheet log failed: {e}")


def main():
    now      = datetime.now(IST)
    date_str = now.strftime('%Y-%m-%d')
    stamp    = now.strftime('%d %b %I:%M %p')
    mode     = 'DRY RUN' if DRY_RUN else 'LIVE'
    print(f"\n✂️  Auto-close [{mode}] — {stamp} IST")
    print(f"   Rule: spend ≥ {KILL_SPEND_PCT:.0%} of budget AND 1D ROAS ≤ {KILL_ROAS} (min spend ₹{MIN_SPEND})")

    kills = load_kills()
    today_kills = set(kills.get(date_str, []))
    sheet_rows, newly_killed = [], []

    for acct_name, account_id, portal in ACCOUNTS:
        rows_1d = paginate(f"{account_id}/insights", {
            'level': 'campaign',
            'fields': 'campaign_id,campaign_name,spend,purchase_roas',
            'action_attribution_windows': json.dumps(['1d_click']),
            'time_range': json.dumps({'since': date_str, 'until': date_str}),
            'filtering': json.dumps([{'field': 'spend', 'operator': 'GREATER_THAN', 'value': '0'}]),
            'limit': 500,
        })
        camps_raw = paginate(f"{account_id}/campaigns", {
            'fields': 'id,name,start_time,created_time,effective_status,daily_budget,adsets{daily_budget}',
            'effective_status': '["ACTIVE"]',
            'limit': 500,
        })
        camp_map = {c['id']: c for c in camps_raw}
        checked = triggered = 0

        for r in rows_1d:
            cid = r.get('campaign_id', '')
            camp = camp_map.get(cid)
            if not cid or not camp:            continue   # not ACTIVE → nothing to pause
            if cid in today_kills:             continue   # already killed today (or manually revived)

            spend   = safe_float(r.get('spend', 0))
            roas_1d = extract_roas(r.get('purchase_roas'))

            braw = camp.get('daily_budget', '')
            if not braw or braw == '0':
                adsets = camp.get('adsets', {}).get('data', [])
                total = sum(safe_float(a.get('daily_budget', 0)) for a in adsets)
                braw = str(int(total)) if total else '0'
            budget = safe_float(braw) / 100
            if budget <= 0:                    continue   # lifetime-budget camps: no daily % to measure
            too_young = False
            try:
                raw_st = camp.get('start_time') or camp.get('created_time')
                st = datetime.strptime(raw_st, '%Y-%m-%dT%H:%M:%S%z')
                too_young = (now - st).total_seconds() < 2 * 3600
            except Exception:
                pass

            checked += 1
            spend_pct = spend / budget
            if spend < MIN_SPEND:              continue
            if too_young:                      continue
            if spend_pct < KILL_SPEND_PCT:     continue
            if roas_1d > KILL_ROAS:            continue

            triggered += 1
            name = r.get('campaign_name', camp.get('name', ''))
            rule = f"spend {spend_pct:.0%} ≥ 40% & ROAS {roas_1d} ≤ 0.4"

            if DRY_RUN:
                result = 'DRY RUN — would pause'
                ok = True
            else:
                ok, err = pause_campaign(cid)
                result = '✅ PAUSED' if ok else f'❌ FAILED: {err}'

            print(f"  ✂️  {acct_name} | {name[:55]} | ₹{spend:,.0f}/{budget:,.0f} ({spend_pct:.0%}) | ROAS {roas_1d} → {result}")
            sheet_rows.append([stamp, acct_name, portal, name, cid,
                               int(budget), int(spend), f"{spend_pct:.0%}", roas_1d, rule, result])
            if ok and not DRY_RUN:
                newly_killed.append(cid)

        print(f"  {acct_name}: {len(rows_1d)} spending, {checked} checked, {triggered} triggered")

    if newly_killed:
        kills.setdefault(date_str, []).extend(newly_killed)
        # keep only last 14 days of history
        for k in sorted(kills)[:-14]:
            del kills[k]
        save_kills(kills)

    log_to_sheet(sheet_rows)
    print(f"\n✅ Done — {len(sheet_rows)} campaign(s) {'flagged' if DRY_RUN else 'paused'} this run")


if __name__ == '__main__':
    main()
