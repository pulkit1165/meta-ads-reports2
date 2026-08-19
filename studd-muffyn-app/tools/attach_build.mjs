// Waits for build 5.0.3 to finish Apple processing, then attaches it to
// version 5.0.0 and writes review notes describing the account-deletion flow.
import { api, APP_ID, VERSION_ID } from './asc.mjs';

const TARGET = '5.0.3';

async function findBuild() {
  const r = await api('GET', `/v1/builds?filter[app]=${APP_ID}&filter[version]=${TARGET}&limit=1&fields[builds]=version,processingState`);
  return r.data?.[0] || null;
}

let build = null;
for (let i = 0; i < 60; i++) {
  build = await findBuild();
  if (build && build.attributes.processingState === 'VALID') break;
  console.log(`waiting… ${build ? build.attributes.processingState : 'not visible yet'} (${i + 1})`);
  build = null;
  await new Promise((s) => setTimeout(s, 60000));
}
if (!build) {
  console.log('TIMEOUT: build never became VALID');
  process.exit(1);
}
console.log('build VALID:', build.id);

await api('PATCH', `/v1/appStoreVersions/${VERSION_ID}/relationships/build`, {
  data: { type: 'builds', id: build.id },
});
console.log('attached build', TARGET, 'to version 5.0.0');

const NOTES = `ACCOUNT DELETION (Guideline 5.1.1(v)):
The app does not create accounts itself — "Login / My Account" opens our Shopify customer account page. To fully comply, this build adds a direct account-deletion path:
  Profile tab (bottom right) -> "Delete Account"
This opens https://studdmuffyn.com/pages/delete-account, where the user submits a request with their registered email/phone; the account and personal data are permanently deleted within 30 days with email confirmation. No phone call or customer-service call-back is required.

TRACKING / PRIVACY (Guideline 5.1.2(i)):
This build performs NO user tracking. It contains no advertising or analytics SDKs and no NSUserTrackingUsageDescription key (verified across every property list in the bundle). Data collected is limited to checkout contact information and purchase history, used solely for app functionality.
The previous "Advertising Data / tracking" entry in our App Privacy responses is a legacy declaration from version 2.5, which was built by a third-party app platform and is fully replaced by this update. We have removed those entries; where App Store Connect blocked the change, we have explained this in Resolution Center.

NOTES:
- No login is required to browse or purchase.
- Checkout is completed on the web (physical goods), as required for physical products.`;

const rd = await api('GET', `/v1/appStoreVersions/${VERSION_ID}/appStoreReviewDetail`).catch(() => null);
const attrs = {
  contactFirstName: 'Pulkit', contactLastName: 'Sharma',
  contactPhone: '+919815610890', contactEmail: 'care.studdmuffyn@gmail.com',
  demoAccountRequired: false, notes: NOTES,
};
if (rd?.data?.id) {
  await api('PATCH', '/v1/appStoreReviewDetails/' + rd.data.id, { data: { type: 'appStoreReviewDetails', id: rd.data.id, attributes: attrs } });
} else {
  await api('POST', '/v1/appStoreReviewDetails', { data: { type: 'appStoreReviewDetails', attributes: attrs, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: VERSION_ID } } } } });
}
console.log('review notes written');
console.log('READY TO RESUBMIT');
