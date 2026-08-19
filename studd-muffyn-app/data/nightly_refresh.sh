#!/bin/bash
# Daily app refresh: new products + collection order + product extras + deploy.
# Sundays run a full extras re-scrape (reviews refresh); other days only
# scrape products that don't have extras yet (new launches).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")"
exec >> refresh.log 2>&1
echo "=== refresh started $(date)"

node refresh_products.mjs || { echo "refresh_products failed, aborting"; exit 1; }
node build_catalog.mjs

if [ "$(date +%u)" = "7" ]; then
  echo "(sunday: full extras re-scrape)"
  node scrape_extras.mjs --force
else
  node scrape_extras.mjs
fi

node scrape_card_links.mjs || true
node build_index.mjs

bash deploy_web.sh
echo "=== refresh done $(date)"
