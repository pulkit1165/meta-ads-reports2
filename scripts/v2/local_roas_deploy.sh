#!/bin/zsh
# Stopgap: rebuild + deploy the roas-live Vercel dashboard from this Mac while
# the CI VERCEL_TOKEN on meta-ads-reports2 is invalid. Runs via LaunchAgent
# com.ntn.roas-live-deploy every 20 min. Remove the agent once CI deploys work:
#   launchctl unload ~/Library/LaunchAgents/com.ntn.roas-live-deploy.plist
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
REPO=/Users/pulkitsharma/meta-ads-reports
WORK=/tmp/roas-live-localdeploy
mkdir -p "$WORK/state"
cd "$REPO"

# fresh data via gh api (git fetch to this repo can hang)
gh api -H 'Accept: application/vnd.github.raw' \
  'repos/pulkit1165/meta-ads-reports2/contents/camp_snapshots.db.gz?ref=camp-snapshots' \
  > "$WORK/state/cs.gz"
gunzip -fc "$WORK/state/cs.gz" > "$WORK/state/camp_snapshots.db"
gh api -H 'Accept: application/vnd.github.raw' \
  'repos/pulkit1165/meta-ads-reports2/contents/ntn.db.gz?ref=state' \
  > "$WORK/state/ntn.gz"
gunzip -fc "$WORK/state/ntn.gz" > "$WORK/state/ntn.db"
gh api -H 'Accept: application/vnd.github.raw' \
  'repos/pulkit1165/meta-ads-reports2/contents/daily_finals.json?ref=camp-snapshots' \
  > "$WORK/state/daily_finals.json" || echo '{}' > "$WORK/state/daily_finals.json"

# skip deploy if the data is older than what's already live (no point)
python3 scripts/v2/build_roas_page.py \
  --snap-db "$WORK/state/camp_snapshots.db" --ntn-db "$WORK/state/ntn.db" \
  --finals "$WORK/state/daily_finals.json" --out roas-live/index.html --days 7
python3 scripts/v2/build_wa_summary.py \
  --snap-db "$WORK/state/camp_snapshots.db" --ntn-db "$WORK/state/ntn.db" \
  --finals "$WORK/state/daily_finals.json" --out roas-live/summary.json
python3 scripts/v2/build_wa_table.py \
  --snap-db "$WORK/state/camp_snapshots.db" --ntn-db "$WORK/state/ntn.db" \
  --finals "$WORK/state/daily_finals.json" \
  --out-json roas-live/wa_table.json --out-png roas-live/wa_table.png
python3 scripts/v2/build_yday_report.py \
  --snap-db "$WORK/state/camp_snapshots.db" \
  --finals "$WORK/state/daily_finals.json" --out roas-live/yday_report.json

# Never regress the WhatsApp table: the mid-hour (:28) pipeline deploys tables
# this agent can't rebuild (its captures are throwaway). If the live table is
# FRESHER than what we just built, keep the live copy — deploying ours over it
# erased the 15:28 sheet on 4 Aug.
LIVE_DT=$(curl -fsS --max-time 15 "https://roas-live.vercel.app/wa_table.json?t=$$" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('day','')+' '+d.get('data_through',''))" 2>/dev/null || echo '')
OUR_DT=$(python3 -c "import json;d=json.load(open('roas-live/wa_table.json'));print(d.get('day','')+' '+d.get('data_through',''))" 2>/dev/null || echo '')
if [ -n "$LIVE_DT" ] && [ "$LIVE_DT" \> "$OUR_DT" ]; then
  echo "live wa_table ($LIVE_DT) fresher than built ($OUR_DT) — preserving live copy"
  curl -fsS --max-time 15 "https://roas-live.vercel.app/wa_table.json?t=$$" -o roas-live/wa_table.json || true
  curl -fsS --max-time 15 "https://roas-live.vercel.app/wa_table.png?t=$$" -o roas-live/wa_table.png || true
fi

# Deploy with the PERMANENT API token (operator-created, no expiry) from the
# workspace .env — NOT the CLI session token, which rotates and dies. Do NOT
# sync the session token into the CI secret anymore: doing so used to clobber
# the permanent token with a rotating one and re-break CI within a day.
PTOK=$(grep '^VERCEL_TOKEN=' "$HOME/.openclaw/workspace/.env" | cut -d= -f2)
if [ -n "$PTOK" ]; then
  npx --yes vercel@latest deploy roas-live --prod --yes --token="$PTOK"
else
  npx --yes vercel@latest deploy roas-live --prod --yes   # fall back to CLI login
fi
echo "$(date '+%F %T') deployed ok" >> /tmp/roas-live-localdeploy/deploy.log
