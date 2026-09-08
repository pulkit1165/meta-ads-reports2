// Shared brand registry for the serverless endpoints. Underscore-prefixed so
// Vercel treats it as a helper, not a route.
//
// Every endpoint takes ?brand=sm|sml and defaults to sm, so existing app
// builds (which send no brand param) keep working exactly as before.
const BRANDS = {
  sm: {
    key: 'sm',
    name: 'Studd Muffyn',
    site: 'https://studdmuffyn.com',
    shop: 'studd-muffyn.myshopify.com',
    tokenEnv: 'SHOPIFY_ACCESS_TOKEN',
    fastrrKeyEnv: 'FASTRR_API_KEY',
    fastrrSecretEnv: 'FASTRR_API_SECRET',
  },
  sml: {
    key: 'sml',
    name: 'Studd Muffyn Life',
    site: 'https://studdmuffynlife.com',
    shop: 'studdmuffynlife.myshopify.com',
    tokenEnv: 'SHOPIFY_ACCESS_TOKEN_SML',
    fastrrKeyEnv: 'FASTRR_API_KEY_SML',
    fastrrSecretEnv: 'FASTRR_API_SECRET_SML',
  },
};

function brandOf(req) {
  const q = (req && req.query && req.query.brand) ||
            (req && req.url && (req.url.match(/[?&]brand=([a-z]+)/) || [])[1]);
  return BRANDS[String(q || '').toLowerCase()] || BRANDS.sm;
}

module.exports = { BRANDS, brandOf };
