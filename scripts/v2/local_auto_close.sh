#!/bin/zsh
# Local runner for auto_close.py — LaunchAgent every 30 min.
# Primary scheduler (GitHub Actions cron is throttled/unreliable); safe to
# overlap with GHA runs — pausing an already-paused campaign is a no-op.
set -euo pipefail

cd /Users/pulkitsharma/meta-ads-reports
export $(grep -E "^META_ACCESS_TOKEN=" /Users/pulkitsharma/.openclaw/workspace/.env)
export GOOGLE_SERVICE_ACCOUNT_FILE=/Users/pulkitsharma/.openclaw/workspace/google-service-account.json

/usr/bin/env python3 scripts/v2/auto_close.py >> /tmp/auto_close_local.log 2>&1
