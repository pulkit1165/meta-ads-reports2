#!/usr/bin/env bash
# Point the bot at a newly-provisioned WhatsApp number.
#
#   ./connect_number.sh <PHONE_NUMBER_ID> <WABA_ID>
#
# Checks the number is reachable with our token, verifies our app can send from it,
# rewrites .env, restarts the bot, and re-points Meta's webhook at this Mac.
set -euo pipefail
cd "$(dirname "$0")"

PHONE_ID="${1:?usage: ./connect_number.sh <PHONE_NUMBER_ID> <WABA_ID>}"
WABA_ID="${2:?usage: ./connect_number.sh <PHONE_NUMBER_ID> <WABA_ID>}"
PYBIN=$( [ -x ./.venv/bin/python ] && echo ./.venv/bin/python || echo python3 )
eval "$($PYBIN _load_env.py)"
GV="${WA_GRAPH_VERSION:-v21.0}"

echo "① checking the number is visible to our token…"
INFO=$(curl -s "https://graph.facebook.com/$GV/$PHONE_ID?fields=display_phone_number,verified_name,code_verification_status,quality_rating,status" \
  -H "Authorization: Bearer $WA_ACCESS_TOKEN")
case "$INFO" in *'"error"'*) echo "   ❌ $INFO"; echo
  echo "   The system user cannot see this number. In Business Manager, assign the WABA"
  echo "   to the 'Antriksh Bot' system user with Full Control, then re-run."; exit 1;; esac
echo "   $INFO"

echo "② checking our app is subscribed to the WABA…"
SUBS=$(curl -s "https://graph.facebook.com/$GV/$WABA_ID/subscribed_apps" -H "Authorization: Bearer $WA_ACCESS_TOKEN")
if ! echo "$SUBS" | grep -q "1651989532773658"; then
  echo "   app not subscribed — subscribing now…"
  RES=$(curl -s -X POST "https://graph.facebook.com/$GV/$WABA_ID/subscribed_apps" -H "Authorization: Bearer $WA_ACCESS_TOKEN")
  echo "   $RES"
  case "$RES" in *'"success":true'*) ;; *) echo "   ❌ could not subscribe the app"; exit 1;; esac
else
  echo "   already subscribed ✓"
fi

echo "③ rewriting .env…"
cp .env .env.bak.$(date +%s)
python3 - "$PHONE_ID" "$WABA_ID" <<'PY'
import re, sys
pid, waba = sys.argv[1], sys.argv[2]
s = open('.env').read()
s = re.sub(r'^WA_PHONE_NUMBER_ID=.*$',      f'WA_PHONE_NUMBER_ID={pid}',   s, flags=re.M)
s = re.sub(r'^WA_BUSINESS_ACCOUNT_ID=.*$',  f'WA_BUSINESS_ACCOUNT_ID={waba}', s, flags=re.M)
open('.env','w').write(s)
print("   WA_PHONE_NUMBER_ID / WA_BUSINESS_ACCOUNT_ID updated (backup kept)")
PY

echo "④ restarting the bot…"
pkill -f "astro-bot/server.py" 2>/dev/null || true
sleep 1
nohup ./run.sh > server.out 2>&1 &
sleep 4
curl -s -m 5 "http://localhost:${PORT:-8090}/healthz" && echo

echo "⑤ re-pointing the webhook at this Mac…"
./tunnel.sh

echo
echo "✅ connected. Send a WhatsApp message to the new number to test."
echo "   If nothing arrives, check that the number's display name is approved and"
echo "   that the WABA has a payment method attached."
