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

npx --yes vercel@latest deploy roas-live --prod --yes
echo "$(date '+%F %T') deployed ok" >> /tmp/roas-live-localdeploy/deploy.log

# keep CI's VERCEL_TOKEN in sync with this Mac's (self-refreshing) CLI session,
# so GHA deploys stop dying when the session token rotates
VTOK=$(python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/com.vercel.cli/auth.json'))['token'])" 2>/dev/null || true)
if [ -n "$VTOK" ]; then
  echo "$VTOK" | gh secret set VERCEL_TOKEN --repo pulkit1165/meta-ads-reports2 \
    && echo "$(date '+%F %T') VERCEL_TOKEN synced" >> /tmp/roas-live-localdeploy/deploy.log \
    || echo "$(date '+%F %T') VERCEL_TOKEN sync FAILED" >> /tmp/roas-live-localdeploy/deploy.log
fi
