// Vercel serverless function: turns studdmuffyn.com's live homepage into the
// app's home config. The website IS the merchandising dashboard — edit the
// homepage in Shopify's theme customizer and the app follows within minutes.
// GET /api/home-config  →  { announcement, sections[], generatedAt, source }

const SITE = 'https://studdmuffyn.com';
const CACHE_SECONDS = 600; // CDN caches the response for 10 min

// Site sections that link to the sister site — map to on-store collections.
const EXTERNAL_HANDLE_MAP = {
  'skin-care': 'skin-care-bestsellers',
  'hair-care1': 'hair-care-bestsellers',
  'perfumes-1': 'perfume-best-sellers',
  nutraceuticals: 'nutraceuticals',
};

const titleCache = new Map(); // warm-instance cache of collection titles

// Site headings arrive HTML-encoded (e.g. "&#10022;" for ✦) and often already
// carry their own decorative glyphs — decode, then strip so the app doesn't
// render raw entities or double up on ornaments.
const decodeEntities = (t) =>
  String(t)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const stripOrnaments = (t) =>
  decodeEntities(t)
    .replace(/[\u2726\u2727\u2724\u2725\u2735\u2736\u273B\u273D\u2739\u2605\u2606\u25C6\u25C7\u2756\u274A\u274B*~\-–—|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const prettify = (h) =>
  h.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bAnd\b/g, '&');

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; like Mac OS X) StuddMuffynApp' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

async function collectionTitle(handle) {
  if (titleCache.has(handle)) return titleCache.get(handle);
  try {
    const r = await fetch(`${SITE}/collections/${handle}.json`);
    if (r.ok) {
      const j = await r.json();
      const t = j.collection && j.collection.title;
      if (t) {
        titleCache.set(handle, t);
        return t;
      }
    }
  } catch {}
  const t = prettify(handle);
  titleCache.set(handle, t);
  return t;
}

// ---- true image dimensions (Shopify CDN 64px variant, header parse) --------
const dimCache = new Map(); // base url -> aspect (w/h) | null

function parseImageAspect(buf) {
  const b = new Uint8Array(buf);
  const str = (o, n) => String.fromCharCode(...b.slice(o, o + n));
  try {
    if (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') {
      const chunk = str(12, 4);
      if (chunk === 'VP8X') {
        const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
        const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
        return w / h;
      }
      if (chunk === 'VP8L') {
        const w = 1 + (((b[22] & 0x3f) << 8) | b[21]);
        const h = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
        return w / h;
      }
      if (chunk === 'VP8 ') {
        const w = (b[26] | (b[27] << 8)) & 0x3fff;
        const h = (b[28] | (b[29] << 8)) & 0x3fff;
        if (w && h) return w / h;
      }
      return null;
    }
    if (b[0] === 0x89 && str(1, 3) === 'PNG') {
      const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
      const h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
      return h ? w / h : null;
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xff) break;
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          const h = (b[i + 5] << 8) | b[i + 6];
          const w = (b[i + 7] << 8) | b[i + 8];
          return h ? w / h : null;
        }
        i += 2 + ((b[i + 2] << 8) | b[i + 3]);
      }
    }
  } catch {}
  return null;
}

async function trueAspect(url) {
  const base = url.split('?')[0];
  if (dimCache.has(base)) return dimCache.get(base);
  let a = null;
  try {
    const v = (url.match(/[?&]v=(\d+)/) || [])[1];
    const r = await fetch(`${base}?${v ? `v=${v}&` : ''}width=64`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (r.ok) a = parseImageAspect(await r.arrayBuffer());
  } catch {}
  if (a) a = Math.round(a * 100) / 100;
  dimCache.set(base, a);
  return a;
}

// ---- HTML helpers -----------------------------------------------------------

function firstImages(seg, limit) {
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
    out.push(`${base}?${v ? `v=${v}&` : ''}width=1200`);
  }
  return out;
}

function imgAspect(seg, imageUrl) {
  // find width/height attrs on the <img> that references this file
  const file = imageUrl.split('/').pop().split('?')[0];
  const re = new RegExp(`<img[^>]*${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>`, 'i');
  const tag = (seg.match(re) || [])[0];
  if (!tag) return null;
  const w = (tag.match(/\bwidth="(\d+)"/) || [])[1];
  const h = (tag.match(/\bheight="(\d+)"/) || [])[1];
  if (w && h && +h > 0) return Math.round((+w / +h) * 100) / 100;
  return null;
}

function collectionLinks(seg) {
  const out = [];
  const seen = new Set();
  const re = /href="(?:https?:\/\/([a-z.]+))?\/collections\/([a-z0-9-]+)/g;
  let m;
  while ((m = re.exec(seg))) {
    const domain = m[1];
    let handle = m[2];
    if (domain && !domain.includes('studdmuffyn.com')) {
      handle = EXTERNAL_HANDLE_MAP[handle] || handle;
    }
    if (!seen.has(handle)) {
      seen.add(handle);
      out.push(handle);
    }
  }
  return out;
}

function linkImagePairs(seg) {
  // href → next cdn image within the anchor's chunk
  const pairs = [];
  const chunks = seg.split(/<a\s/i).slice(1);
  for (const c of chunks) {
    const hrefM = c.match(/^[^>]*href="([^"]+)"/i);
    if (!hrefM) continue;
    const href = hrefM[1];
    const imgs = firstImages(c.slice(0, 3000), 1);
    if (!imgs.length) continue;
    let handle = null;
    const cm = href.match(/^(?:https?:\/\/([a-z.]+))?\/collections\/([a-z0-9-]+)/);
    if (cm) {
      handle = cm[2];
      if (cm[1] && !cm[1].includes('studdmuffyn.com')) handle = EXTERNAL_HANDLE_MAP[handle] || handle;
    }
    if (handle) {
      const rawHandle = cm[2];
      const label = prettify(rawHandle.replace(/-?\d+$/, ''));
      pairs.push({ handle, image: imgs[0], aspect: imgAspect(c, imgs[0]), label });
    }
  }
  // dedupe by handle
  const seen = new Set();
  return pairs.filter((p) => (seen.has(p.handle) ? false : (seen.add(p.handle), true)));
}

// ---- site menu (mobile drawer) ---------------------------------------------
function parseMenu(html) {
  const m = html.match(/id="shopify-section-sections--\d+__mobile-menu"([\s\S]*?)(?=<(?:div|section)[^>]+id="shopify-section-)/);
  if (!m) return [];
  const seg = m[1];
  const anchors = [];
  const re = /<a[^>]*href="([^"#]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let a;
  while ((a = re.exec(seg))) {
    const title = decodeEntities(a[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    let url = a[1].replace(/^https?:\/\/(www\.)?studdmuffyn\.com/, '');
    if (!title || /log in|create an account/i.test(title)) continue;
    anchors.push({ title, url });
  }
  // top-level = entries up to the "More" item (drawer lists top menu first)
  let split = anchors.findIndex((x) => /^more$/i.test(x.title));
  if (split === -1) split = Math.min(14, anchors.length);
  const top = anchors.slice(0, split + 1);
  const rest = anchors.slice(split + 1);
  const menu = top.map((t) => ({ title: t.title, url: t.url, children: [] }));
  let current = null;
  for (const item of rest) {
    const parent = menu.find((mm) => mm.title === item.title && mm.url === item.url);
    if (parent) {
      current = parent;
      continue;
    }
    if (current && item.url && item.url !== '/') current.children.push(item);
  }
  return menu;
}

// ---- main parser ------------------------------------------------------------

async function buildConfig(html) {
  const sections = [];

  // announcement bar
  const announcements = [];
  const annRe = /announcement[^>]*>([^<>{}]{6,140})</g;
  let am;
  while ((am = annRe.exec(html))) {
    const t = am[1].replace(/\s+/g, ' ').trim();
    if (t && !announcements.includes(t) && !/^\s*(function|var|window)/.test(t)) announcements.push(t);
  }

  // split into theme sections, preserving page order
  const parts = html.split(/(?=<[a-z-]+[^>]+id="shopify-section-template--\d+__)/).slice(1);
  const railHandles = [];

  for (const p of parts) {
    const name = (p.match(/id="shopify-section-template--\d+__([a-zA-Z0-9_-]+)"/) || [])[1] || '';

    if (name.startsWith('featured_collection')) {
      const handle = collectionLinks(p)[0];
      if (handle) {
        sections.push({ type: 'productRail', handle, title: null });
        railHandles.push(handle);
      }
    } else if (name.startsWith('scrolling_content')) {
      const imgs = firstImages(p, 8);
      if (imgs.length) {
        const a = imgAspect(p, imgs[0]) || 2;
        sections.push({ type: 'logoStrip', images: imgs, height: a > 3 ? 56 : a > 1.6 ? 110 : 140 });
      }
    } else {
      // Everything else (image_hero, slideshow, blocks_*, any custom section):
      // decide by content, not by name, so new site sections never get dropped.
      const imgs = firstImages(p, 8);
      const links = collectionLinks(p);
      const pairs = linkImagePairs(p);

      // ornamental section heading (e.g. "Crystal Decor") if present
      const orn = (seg => {
        const m2 = seg.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/);
        if (!m2) return null;
        const t = stripOrnaments(m2[1].replace(/<[^>]+>/g, ' '));
        return t && t.length <= 40 ? t : null;
      })(p);
      if (orn) sections.push({ type: 'sectionTitle', text: orn });

      // true aspects from the images themselves (attrs only as fallback)
      const [leadTrue] = await Promise.all([
        imgs[0] ? trueAspect(imgs[0]) : null,
        ...pairs.map(async (x) => {
          x.aspect = (await trueAspect(x.image)) ?? x.aspect ?? null;
        }),
      ]);
      const leadAspect = leadTrue ?? (imgs[0] ? imgAspect(p, imgs[0]) : null);

      // hero-style: lead image is wide → full-width banner first
      let rest = pairs;
      if (imgs[0] && leadAspect !== null && leadAspect >= 1.9) {
        sections.push({
          type: 'imageBanner',
          image: imgs[0],
          url: links[0] ? `/collections/${links[0]}` : undefined,
          aspect: leadAspect || 2,
        });
        rest = pairs.filter((x) => x.image !== imgs[0]);
      }

      if (rest.length >= 2) {
        // wide items become stacked promo banners; the rest become a tile grid
        const wide = rest.filter((x) => (x.aspect ?? 1) >= 1.9).slice(0, 5);
        const tiles = rest.filter((x) => (x.aspect ?? 1) < 1.9);
        for (const x of wide) {
          sections.push({ type: 'imageBanner', image: x.image, url: `/collections/${x.handle}`, aspect: x.aspect || 2.5 });
        }
        const smallTiles = tiles.length >= 5 || (tiles.length >= 4 && (tiles[0].aspect ?? 1) < 1);
        if (smallTiles) {
          // site shows many small tiles as a swipeable strip (~4 across)
          sections.push({ type: 'iconRow', items: tiles.slice(0, 12).map((x) => ({ image: x.image, handle: x.handle, aspect: x.aspect })) });
        } else if (tiles.length >= 2) {
          sections.push({
            type: 'categoryGrid',
            aspect: tiles[0].aspect || 1,
            showLabel: false,
            labelMode: 'none',
            items: tiles.slice(0, 8).map((x) => ({ title: x.label || prettify(x.handle), handle: x.handle, image: x.image, aspect: x.aspect })),
          });
        } else if (tiles.length === 1) {
          sections.push({ type: 'imageBanner', image: tiles[0].image, url: `/collections/${tiles[0].handle}`, aspect: tiles[0].aspect || 2 });
        }
      } else if (rest.length === 1 && !sections.find((s) => s.image === rest[0].image)) {
        sections.push({ type: 'imageBanner', image: rest[0].image, url: `/collections/${rest[0].handle}`, aspect: rest[0].aspect || 2 });
      }
    }
  }

  // resolve rail titles (warm-cached; fallback = prettified handle)
  await Promise.all(
    railHandles.map((h) =>
      Promise.race([collectionTitle(h), new Promise((res) => setTimeout(() => res(prettify(h)), 4000))])
    )
  );
  for (const s of sections) {
    if (s.type === 'productRail') s.title = decodeEntities(titleCache.get(s.handle) || prettify(s.handle));
  }

  sections.push({ type: 'recentlyViewed', title: 'Recently Viewed' });

  const menu = parseMenu(html);

  return {
    version: 3,
    source: 'live-website',
    generatedAt: new Date().toISOString(),
    announcement: {
      messages: announcements.length ? announcements.slice(0, 3) : ['FREE SHIPPING ON PREPAID ORDERS'],
    },
    menu,
    sections: rightSizeImages(sections),
  };
}

// ---- image right-sizing -----------------------------------------------------
// Every parsed URL comes out at width=1200 because that is what the desktop
// site serves. A 1200px file for a 70pt category icon is ~30x the pixels the
// phone needs, and decoding 45 of them starves the JS thread -> taps stop
// registering while native scrolling keeps working. Ask for what we render.
const SECTION_IMG_WIDTH = {
  hero: 1080,
  imageBanner: 1080,   // full-bleed, must stay sharp on a 3x screen
  categoryGrid: 540,   // two across
  iconRow: 260,        // five or six across
  logoStrip: 260,
};

function sizeUrl(u, w) {
  if (typeof u !== 'string' || !u.includes('/cdn/shop/')) return u;
  return /[?&]width=\d+/.test(u)
    ? u.replace(/([?&])width=\d+/, `$1width=${w}`)
    : `${u}${u.includes('?') ? '&' : '?'}width=${w}`;
}

function rightSizeImages(sections) {
  for (const s of sections || []) {
    const w = SECTION_IMG_WIDTH[s.type];
    if (!w) continue;
    if (s.image) s.image = sizeUrl(s.image, w);
    for (const key of ['items', 'slides', 'images']) {
      if (!Array.isArray(s[key])) continue;
      s[key] = s[key].map((x) =>
        typeof x === 'string' ? sizeUrl(x, w)
        : x && x.image ? { ...x, image: sizeUrl(x.image, w) }
        : x);
    }
  }
  return sections;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const html = await fetchText(`${SITE}/`);
    const cfg = await buildConfig(html);
    // sanity: a homepage should yield a healthy number of sections
    if (!cfg.sections || cfg.sections.length < 4) throw new Error('parse produced too few sections');
    res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`);
    res.status(200).json(cfg);
  } catch (e) {
    // fail soft: the app falls back to its bundled config
    res.setHeader('Cache-Control', 's-maxage=60');
    res.status(503).json({ error: String(e && e.message ? e.message : e) });
  }
};

module.exports.buildConfig = buildConfig; // exported for local testing
