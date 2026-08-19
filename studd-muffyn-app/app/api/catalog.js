// Live slim catalog. Pulls the full product list straight from Shopify's
// public JSON so newly launched products are searchable in the app
// immediately — no rebuild, no machine.
//
// GET /api/catalog  ->  { count, generatedAt, products: [...] }
//
// Fields are kept minimal (search + card rendering only); full product
// detail is always fetched live per product page.

const SITE = 'https://studdmuffyn.com';
const CACHE_SECONDS = 600; // 10 min at the CDN
const MAX_PAGES = 12;

async function page(n) {
  const r = await fetch(`${SITE}/products.json?limit=250&page=${n}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 StuddMuffynApp' },
  });
  if (!r.ok) throw new Error(`products page ${n}: ${r.status}`);
  const j = await r.json();
  return j.products || [];
}

function slim(p) {
  const v0 = (p.variants && p.variants[0]) || {};
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    vendor: p.vendor,
    productType: p.product_type,
    tags: Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(', ').filter(Boolean),
    price: parseFloat(v0.price || '0'),
    compareAt: v0.compare_at_price ? parseFloat(v0.compare_at_price) : null,
    images: (p.images || []).slice(0, 2).map((i) => i.src),
    variants: (p.variants || []).map((v) => ({
      id: v.id,
      title: v.title,
      price: parseFloat(v.price),
      compareAt: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
      available: v.available !== false,
      option1: v.option1,
      option2: v.option2,
    })),
    options: (p.options || []).map((o) => ({ name: o.name, values: o.values })),
    createdAt: p.created_at || '',
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    // fetch pages in parallel, stop at the first empty one
    const batches = await Promise.all(
      Array.from({ length: MAX_PAGES }, (_, i) => page(i + 1).catch(() => []))
    );
    const products = [];
    for (const b of batches) products.push(...b);
    if (products.length < 50) throw new Error('catalog looks truncated');

    const seen = new Set();
    const out = [];
    for (const p of products) {
      if (seen.has(p.handle)) continue;
      seen.add(p.handle);
      out.push(slim(p));
    }

    res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`);
    return res.status(200).json({
      count: out.length,
      generatedAt: new Date().toISOString(),
      products: out,
    });
  } catch (e) {
    // app keeps using its bundled snapshot
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(503).json({ error: String((e && e.message) || e) });
  }
};
