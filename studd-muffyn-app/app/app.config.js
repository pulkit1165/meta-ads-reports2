// Per-brand app config. `app.json` stays the Studd Muffyn baseline; this file
// layers a brand on top when APP_BRAND is set, so:
//
//   APP_BRAND=sml eas build --platform ios --profile production
//
// With APP_BRAND unset the output is byte-identical to the SM config that is
// already in review — new brands must not disturb the shipping app.
const base = require('./app.json').expo;

const BRANDS = {
  sm: {
    brand: 'sm',
    name: 'Studd Muffyn',
    slug: 'studd-muffyn',
    scheme: 'studdmuffyn',
    bundleIdentifier: 'com.StuddMuffyn.ShopifyApp',
    ascAppId: '1597059141',
    easProjectId: '9cc32f92-0f1c-4b0d-b532-a28bdab9aab8',
    icon: './assets/icon.png',
    splashImage: './assets/splash-logo.png',
    splashBackground: '#0B0B0D',
  },
  sml: {
    brand: 'sml',
    name: 'Studd Muffyn Life',
    slug: 'studd-muffyn-life',
    scheme: 'studdmuffynlife',
    bundleIdentifier: 'com.StuddMuffynLife',
    ascAppId: '6771284915',
    // filled in by `eas init` for the SML app — see SETUP-NEW-BRAND.md
    easProjectId: process.env.EAS_PROJECT_ID_SML || null,
    icon: './assets/sml/icon.png',
    splashImage: './assets/sml/splash-logo.png',
    splashBackground: '#ffffff',
    version: '2.2.0',
    buildNumber: '2.2.0',
  },
};

const key = process.env.APP_BRAND || 'sm';
const b = BRANDS[key];
if (!b) throw new Error(`unknown APP_BRAND "${key}" — expected one of ${Object.keys(BRANDS).join(', ')}`);

module.exports = () => ({
  ...base,
  name: b.name,
  slug: b.slug,
  scheme: b.scheme,
  version: b.version || base.version,
  icon: b.icon,
  splash: { ...base.splash, image: b.splashImage, backgroundColor: b.splashBackground },
  ios: {
    ...base.ios,
    bundleIdentifier: b.bundleIdentifier,
    buildNumber: b.buildNumber || base.ios.buildNumber,
  },
  extra: {
    ...base.extra,
    brand: b.brand,
    eas: { ...(base.extra && base.extra.eas), projectId: b.easProjectId },
  },
});
