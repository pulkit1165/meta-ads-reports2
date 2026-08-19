# Working on the app from another laptop

Everything in this folder is in git **except secrets and generated files**.
Follow these steps once on the new machine.

## 1. Clone and install

```bash
git clone https://github.com/pulkit1165/meta-ads-reports2.git
cd meta-ads-reports2/studd-muffyn-app/app
npm install --legacy-peer-deps      # peer conflicts are expected; this flag is required
```

Node 20+ required (this machine uses Node 22).

## 2. Run it

```bash
npx expo start          # then scan the QR with Expo Go on your phone
npx expo start --web    # or preview in a browser
```

That's enough for **UI work** — the app pulls catalog, homepage layout and
product content live from the internet, so no secrets are needed just to
develop and preview.

## 3. Secrets — needed only for deploying/publishing

These are deliberately **not** in git. Copy them from the original Mac
(`~/meta-ads-reports/studd-muffyn-app/app/`) via AirDrop/USB, or recreate them:

| File | What it is | How to recreate |
|---|---|---|
| `.eas-token` | Expo access token (cloud builds) | expo.dev → avatar → Account settings → Access tokens → Create |
| `credentials/AuthKey_485W9438M3.p8` | Apple App Store Connect API key | App Store Connect → Users and Access → Integrations → App Store Connect API (a key can only be downloaded once — copy the file rather than regenerating unless lost) |
| `.vercel-link-backup/` | Vercel project link | already in git; needs `vercel login` on the new machine |

Key IDs (not secret, already in `eas.json` / `tools/asc.mjs`):
- ASC Key ID `485W9438M3`, Issuer `0e0ce657-801b-4c95-b81f-aa982d5a505f`
- Apple Team `KG3A2XWWGT`, iOS bundle `com.StuddMuffyn.ShopifyApp`, App ID `1597059141`
- Expo project `studd-muffyn` (account `nature-touch-nutritiom`)

## 4. Common tasks

```bash
# deploy the web demo + app config/extras endpoints
bash data/deploy_web.sh

# refresh catalog + product extras manually (normally runs nightly on the main Mac)
cd data && node refresh_products.mjs && node build_catalog.mjs \
  && node scrape_extras.mjs && node scrape_card_links.mjs && node build_index.mjs

# push a JS-only update to installed apps (no store review)
cd app && export EXPO_TOKEN=$(cat .eas-token) && npx eas-cli update --branch production

# new store build (needs the secrets above)
export EXPO_TOKEN=$(cat .eas-token) EXPO_NO_CAPABILITY_SYNC=1
npx eas-cli build --platform ios --profile production
npx eas-cli submit --platform ios --latest

# check App Store review status
cd tools && node -e "import('./asc.mjs').then(async ({api,VERSION_ID}) => {
  const v = await api('GET','/v1/appStoreVersions/'+VERSION_ID);
  console.log(v.data.attributes.versionString, v.data.attributes.appStoreState); })"
```

## 5. Important: the nightly refresh runs only on the original Mac

`com.studdmuffyn.app-refresh` (LaunchAgent, 10:00 daily) lives on the first
machine. Don't set it up on both — two machines deploying the same Vercel
project would race each other.
