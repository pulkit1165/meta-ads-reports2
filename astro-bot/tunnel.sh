#!/usr/bin/env bash
# Start (or restart) the public tunnel and re-point Meta's webhook at the new URL.
# Quick-tunnel hostnames rotate on every restart, so Meta must be told each time.
set -euo pipefail
cd "$(dirname "$0")"
PYBIN=$( [ -x ./.venv/bin/python ] && echo ./.venv/bin/python || echo python3 )
eval "$($PYBIN _load_env.py)"

pkill -f "cloudflared tunnel --url http://localhost:${PORT:-8090}" 2>/dev/null || true
sleep 1
nohup cloudflared tunnel --url "http://localhost:${PORT:-8090}" > tunnel.log 2>&1 &

URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" tunnel.log | head -1 || true)
  [ -n "$URL" ] && break
  sleep 2
done
[ -n "$URL" ] || { echo "❌ tunnel did not come up — see tunnel.log"; exit 1; }
echo "$URL" > .tunnel_url
echo "tunnel: $URL"

# Meta performs its verify handshake during this call, so success proves the path end to end.
RESP=$(curl -s -X POST "https://graph.facebook.com/${WA_GRAPH_VERSION:-v21.0}/${WA_BUSINESS_ACCOUNT_ID}/subscribed_apps" \
  -H "Authorization: Bearer ${WA_ACCESS_TOKEN}" -H "Content-Type: application/json" \
  -d "{\"override_callback_uri\":\"${URL}/webhook\",\"verify_token\":\"${WA_VERIFY_TOKEN}\"}")
echo "meta: $RESP"
case "$RESP" in *'"success":true'*) echo "✅ webhook points at this Mac — message the number now";;
                                 *) echo "❌ Meta rejected the webhook"; exit 1;; esac
