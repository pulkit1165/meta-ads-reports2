// Live product-page mirror. Fetches the real product page from
// studdmuffyn.com on demand and returns the same shape the app already
// consumes (reviews, pairs-well-with, full pdpSections, marketplace links).
//
// GET /api/extras?handle=<product-handle>
//
// No machine required: this replaces the local Playwright scrape for
// freshness. The pre-built /extras/<handle>.json files remain as a
// fallback for when the site is unreachable.

const SITE = 'https://studdmuffyn.com';
const CACHE_SECONDS = 300; // 5 min at the CDN, stale-while-revalidate for a day

const SHOP = 'studd-muffyn.myshopify.com';
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const strip = (s) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function sectionText(seg, stripHeading) {
  let t = strip(
    seg
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  );
  if (stripHeading && t.startsWith(stripHeading)) t = t.slice(stripHeading.length).trim();
  return t.slice(0, 4000);
}

function sectionImages(seg, limit = 8) {
  const out = [];
  const seen = new Set();
  const re = /(?:srcset|data-srcset|src|data-src)="([^"]*\/cdn\/shop\/[^"]*)"/g;
  let m;
  while ((m = re.exec(seg)) && out.length < limit) {
    let u = m[1].split(',')[0].trim().split(' ')[0];
    if (u.startsWith('//')) u = 'https:' + u;
    const base = u.split('?')[0];
    if (!/\.(jpe?g|png|webp)$/i.test(base) || seen.has(base)) continue;
    seen.add(base);
    const v = (u.match(/[?&]v=(\d+)/) || [])[1];
    const file = base.split('/').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tag = (seg.match(new RegExp('<img[^>]*' + file + '[^>]*>', 'i')) || [])[0] || '';
    const w = +((tag.match(/\bwidth="(\d+)"/) || [])[1] || 0);
    const hh = +((tag.match(/\bheight="(\d+)"/) || [])[1] || 0);
    out.push({
      url: `${base}?${v ? `v=${v}&` : ''}width=1000`,
      aspect: w && hh ? Math.round((w / hh) * 100) / 100 : null,
    });
  }
  return out;
}

function firstHeading(seg) {
  const m = seg.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/);
  return m ? strip(m[1]).slice(0, 80) : '';
}

function parseReviews(html, limit = 12) {
  const reviews = [];
  const revRe = /<div class=["']jdgm-rev jdgm[^"']*["']([\s\S]{0,6000}?)(?=<div class=["']jdgm-rev jdgm|jdgm-rev-widg__footer|$)/g;
  let m;
  while ((m = revRe.exec(html)) && reviews.length < limit) {
    const b = m[1];
    const score = +((b.match(/data-score=["'](\d)["']/) || [])[1] || 0);
    const author = strip((b.match(/jdgm-rev__author["'][^>]*>([^<]*)</) || [, ''])[1]);
    const date = ((b.match(/jdgm-rev__timestamp[^>]*?data-content=["']([^"']+)/) || [])[1] || '').slice(0, 10);
    const title = strip((b.match(/jdgm-rev__title["'][^>]*>([\s\S]*?)<\/b>/) || [, ''])[1] || '');
    const body = strip((b.match(/jdgm-rev__body["'][^>]*>([\s\S]*?)<\/div>/) || [, ''])[1] || '');
    if (score && (body || title)) reviews.push({ score, author, date, title, body: body.slice(0, 600) });
  }
  return reviews;
}

/** Rating average and marketplace links are injected by JavaScript on the
 * real page, so they can't be read from raw HTML. The pre-built snapshot
 * (refreshed periodically in CI) supplies them. */
async function staticSnapshot(handle, origin) {
  try {
    const r = await fetch(`${origin}/extras/${handle}.json`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Judge.me renders reviews client-side, so the raw product HTML has none.
 * Their public widget endpoint returns the same markup server-side. */
async function fetchJudgeMeReviews(productId) {
  try {
    const u = `https://judge.me/reviews/reviews_for_widget?url=${SHOP}&shop_domain=${SHOP}&platform=shopify&product_id=${productId}&page=1`;
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const j = await r.json();
    const html = j.html || '';
    const reviews = parseReviews(html);
    const total = +(j.total_count || 0) || reviews.length;
    const rating = reviews.length
      ? +(reviews.reduce((s, x) => s + x.score, 0) / reviews.length).toFixed(2)
      : 0;
    return { reviews, reviewCount: total, rating };
  } catch {
    return null;
  }
}

function parseExtras(html, handle) {
  const reviews = parseReviews(html);
  let rating = +((html.match(/data-average-rating="([\d.]+)"/) || [])[1] || 0);
  let reviewCount = +((html.match(/data-number-of-reviews="(\d+)"/) || [])[1] || 0);
  if (!rating && reviews.length) rating = +(reviews.reduce((s, r) => s + r.score, 0) / reviews.length).toFixed(2);
  if (!reviewCount) reviewCount = reviews.length;

  // ---- pairs well with ----
  let pairsWith = [];
  const pi = html.indexOf('Pairs well with');
  if (pi > -1) {
    const seg = html.slice(pi, pi + 40000);
    pairsWith = [...new Set([...seg.matchAll(/\/products\/([a-z0-9-]+)/g)].map((x) => x[1]))]
      .filter((h) => h !== handle)
      .slice(0, 6);
  }

  // ---- full template mirror, section by section, in page order ----
  const pdpSections = [];
  const parts = html.split(/(?=<[a-z-]+[^>]+id="shopify-section-template--\d+__)/).slice(1);
  let mainSeg = '';
  for (const p of parts) {
    const name = (p.match(/id="shopify-section-template--\d+__([a-zA-Z0-9_-]+)"/) || [])[1] || '';
    const cut = p.indexOf('jdgm-widget');
    const seg = cut > -1 ? p.slice(0, cut) : p;
    if (name === 'main') {
      mainSeg = seg;
      continue;
    }
    if (name.startsWith('tracking_order')) continue;

    if (name.startsWith('collapsible_row_list')) {
      const items = [];
      for (const c of seg.split(/(?=collapsible-row-list-item__label)/).slice(1)) {
        const heading = strip((c.match(/collapsible-row-list-item__heading[^>]*>\s*([\s\S]*?)<\/span>/) || [, ''])[1]);
        if (!heading) continue;
        const text = sectionText(c, heading);
        if (text.length > 20) items.push({ heading, text });
      }
      if (items.length) pdpSections.push({ type: 'accordions', items });
    } else if (name.startsWith('multi_column')) {
      const heading = firstHeading(seg);
      const text = sectionText(seg, heading);
      if (text.length > 30) pdpSections.push({ type: 'textBlock', heading: heading || 'Details', text });
    } else if (name.startsWith('media_with_content')) {
      const heading = firstHeading(seg);
      const text = sectionText(seg, heading);
      const imgs = sectionImages(seg, 2);
      if (text.length > 30 || imgs.length)
        pdpSections.push({ type: 'mediaBlock', heading: heading || '', text, image: imgs[0] || null });
    } else if (name.startsWith('promotion_grid') || name.startsWith('scrolling_content')) {
      const heading = firstHeading(seg);
      const imgs = sectionImages(seg, 8);
      if (imgs.length) pdpSections.push({ type: 'imageStrip', heading, images: imgs });
    } else if (name.startsWith('featured_collection')) {
      const heading = firstHeading(seg) || 'You may also like';
      const coll = (seg.match(/href="[^"]*\/collections\/([a-z0-9-]+)/) || [])[1] || null;
      const prods = [...new Set([...seg.matchAll(/\/products\/([a-z0-9-]+)/g)].map((x) => x[1]))]
        .filter((h) => h !== handle)
        .slice(0, 10);
      if (coll || prods.length) pdpSections.push({ type: 'rail', heading, collection: coll, products: prods });
    } else {
      const heading = firstHeading(seg);
      const text = sectionText(seg, heading);
      const imgs = sectionImages(seg, 6);
      if (text.length > 60) pdpSections.push({ type: 'textBlock', heading: heading || '', text });
      else if (imgs.length >= 2) pdpSections.push({ type: 'imageStrip', heading, images: imgs });
    }
  }

  // ---- marketplace links: ONLY from this product's own buy box (main
  // section), never from recommendation cards further down the page ----
  const marketplaces = {};
  {
    // cut the page at the first recommendation rail — anything before it
    // belongs to THIS product, so no other product's links can leak in
    const railAt = html.search(/id="shopify-section-template--\d+__featured_collection/);
    const own = railAt > -1 ? html.slice(0, railAt) : html;
    let scope = '';
    const ai = own.indexOf('Also Available On');
    if (ai > -1) scope = own.slice(ai, ai + 4000);
    else if (mainSeg) {
      const mi = mainSeg.indexOf('Also Available On');
      if (mi > -1) scope = mainSeg.slice(mi, mi + 4000);
    }
    if (scope) {
      const a = scope.match(/href="(https?:\/\/(?:www\.)?amazon\.[a-z.]+\/[^"]+)"/i);
      if (a) marketplaces.amazon = a[1];
      const f = scope.match(/href="(https?:\/\/(?:www\.)?flipkart\.com\/[^"]+)"/i);
      if (f) marketplaces.flipkart = f[1];
      const my = scope.match(/href="(https?:\/\/(?:www\.)?myntra\.com\/[^"]+)"/i);
      if (my) marketplaces.myntra = my[1];
    }
  }

  // legacy flat list for older app builds
  const sections = [];
  for (const s of pdpSections) {
    if (s.type === 'accordions') for (const it of s.items) sections.push(it);
    else if ((s.type === 'textBlock' || s.type === 'mediaBlock') && s.text && s.heading)
      sections.push({ heading: s.heading, text: s.text });
  }

  return {
    handle, rating, reviewCount, reviews, pairsWith,
    sections, pdpSections, marketplaces,
    source: 'live', scrapedAt: new Date().toISOString(),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const handle = String((req.query && req.query.handle) || '').trim();
  if (!/^[a-z0-9-]{2,120}$/.test(handle)) {
    return res.status(400).json({ error: 'valid handle required' });
  }
  try {
    const r = await fetch(`${SITE}/products/${handle}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    if (!r.ok) throw new Error('upstream ' + r.status);
    const html = await r.text();
    if (html.length < 50000) throw new Error('page too small (blocked?)');
    const extras = parseExtras(html, handle);
    // reviews live in Judge.me, not in the page HTML — pull them directly
    const pid = (html.match(/<meta[^>]+property="og:id"[^>]+content="(\d+)"/) ||
                 html.match(/"product_id"\s*:\s*(\d+)/) ||
                 html.match(/data-product-id="(\d+)"/) ||
                 html.match(/\bproductId["']?\s*[:=]\s*["']?(\d{10,})/))?.[1];
    const origin = `https://${req.headers.host || 'studd-muffyn-app.vercel.app'}`;
    const [jm, snap] = await Promise.all([
      pid ? fetchJudgeMeReviews(pid) : null,
      staticSnapshot(handle, origin),
    ]);
    if (jm && jm.reviewCount) {
      if (jm.reviews.length) extras.reviews = jm.reviews;
      extras.reviewCount = jm.reviewCount;
      extras.rating = extras.rating || jm.rating;
    }
    if (snap) {
      // JS-rendered bits the raw page can't give us. The snapshot's rating
      // comes from the real rendered badge, so it beats an average computed
      // from only the first page of reviews.
      if (snap.rating) extras.rating = snap.rating;
      if (!extras.reviewCount && snap.reviewCount) extras.reviewCount = snap.reviewCount;
      if (!extras.reviews.length && snap.reviews?.length) extras.reviews = snap.reviews;
      if (!Object.keys(extras.marketplaces).length && snap.marketplaces) {
        extras.marketplaces = snap.marketplaces;
      }
      if (!extras.pairsWith.length && snap.pairsWith?.length) extras.pairsWith = snap.pairsWith;
    }
    // a real product page always yields something; guard against silent junk
    if (!extras.pdpSections.length && !extras.reviewCount) throw new Error('parsed empty');
    res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`);
    return res.status(200).json(extras);
  } catch (e) {
    // app falls back to the pre-built /extras/<handle>.json snapshot
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(503).json({ error: String((e && e.message) || e) });
  }
};
