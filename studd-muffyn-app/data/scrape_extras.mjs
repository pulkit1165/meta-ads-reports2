// Scrape per-product "extras" the public JSON API doesn't expose:
// Judge.me reviews, Pairs-well-with, and theme-rendered detail sections
// (Product Description / Key Highlights / Hero Ingredients / Product Benefits…).
// Runs with a real browser (Playwright) because plain fetches get bot-blocked.
//
//   node scrape_extras.mjs            # all products, resumable (skips existing)
//   node scrape_extras.mjs --limit 50 # first 50 missing
//   node scrape_extras.mjs --force    # re-scrape everything
//
// Output: data/extras/<handle>.json + data/extras-index.json

import fs from 'fs';
import path from 'path';
import { chromium, devices } from 'playwright';

const DATA = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DATA, 'extras');
const CATALOG = JSON.parse(fs.readFileSync(path.join(DATA, '..', 'app', 'src', 'data', 'catalog.json')));
const HOME = JSON.parse(fs.readFileSync(path.join(DATA, '..', 'app', 'src', 'config', 'home.json')));
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const FORCE = process.argv.includes('--force');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? +process.argv[i + 1] : Infinity; })();

fs.mkdirSync(OUT, { recursive: true });

// priority: products featured on the home config first
const priority = new Set();
for (const sec of HOME.sections || []) {
  if (sec.handle) for (const h of CATALOG.collectionProducts[sec.handle] || []) priority.add(h);
}
const handles = [...CATALOG.products.map((p) => p.handle)].sort(
  (a, b) => (priority.has(b) ? 1 : 0) - (priority.has(a) ? 1 : 0)
);

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
    out.push({ url: `${base}?${v ? `v=${v}&` : ''}width=1000`, aspect: w && hh ? Math.round((w / hh) * 100) / 100 : null });
  }
  return out;
}

function firstHeading(seg) {
  const m = seg.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/);
  return m ? strip(m[1]).slice(0, 80) : '';
}

function parseExtras(html, handle) {
  // reviews (whole page — widget position varies)
  const reviews = [];
  const revRe = /<div class="jdgm-rev jdgm[^"]*"([\s\S]{0,6000}?)(?=<div class="jdgm-rev jdgm|jdgm-rev-widg__footer|$)/g;
  let m;
  while ((m = revRe.exec(html)) && reviews.length < 12) {
    const b = m[1];
    const score = +((b.match(/data-score="(\d)"/) || [])[1] || 0);
    const author = strip((b.match(/jdgm-rev__author">([^<]*)</) || [, ''])[1]);
    const date = ((b.match(/jdgm-rev__timestamp[^>]*data-content="([^"]+)"/) || [])[1] || '').slice(0, 10);
    const title = strip((b.match(/jdgm-rev__title">([\s\S]*?)<\/b>/) || [, ''])[1] || '');
    const body = strip((b.match(/jdgm-rev__body">([\s\S]*?)<\/div>/) || [, ''])[1] || '');
    if (score && (body || title)) reviews.push({ score, author, date, title, body: body.slice(0, 600) });
  }
  let rating = +((html.match(/data-average-rating="([\d.]+)"/) || [])[1] || 0);
  let reviewCount = +((html.match(/data-number-of-reviews="(\d+)"/) || [])[1] || 0);
  if (!rating && reviews.length) rating = +(reviews.reduce((s, r) => s + r.score, 0) / reviews.length).toFixed(2);
  if (!reviewCount) reviewCount = reviews.length;

  // pairs well with
  let pairsWith = [];
  const pi = html.indexOf('Pairs well with');
  if (pi > -1) {
    const seg = html.slice(pi, pi + 40000);
    pairsWith = [...new Set([...seg.matchAll(/\/products\/([a-z0-9-]+)/g)].map((x) => x[1]))]
      .filter((h) => h !== handle)
      .slice(0, 6);
  }

  // ---- full PDP template mirror: every section, in page order ----
  const pdpSections = [];
  const parts = html.split(/(?=<[a-z-]+[^>]+id="shopify-section-template--\d+__)/).slice(1);
  for (const p of parts) {
    const name = (p.match(/id="shopify-section-template--\d+__([a-zA-Z0-9_-]+)"/) || [])[1] || '';
    const cut = p.indexOf('jdgm-widget');
    const seg = cut > -1 ? p.slice(0, cut) : p;
    if (name === 'main' || name.startsWith('tracking_order')) continue;

    if (name.startsWith('collapsible_row_list')) {
      const items = [];
      const chunks = seg.split(/(?=collapsible-row-list-item__label)/).slice(1);
      for (const c of chunks) {
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
      // unknown custom section: keep whatever meaningful content it has
      const heading = firstHeading(seg);
      const text = sectionText(seg, heading);
      const imgs = sectionImages(seg, 6);
      if (text.length > 60) pdpSections.push({ type: 'textBlock', heading: heading || '', text });
      else if (imgs.length >= 2) pdpSections.push({ type: 'imageStrip', heading, images: imgs });
    }
  }

  // legacy flat sections (kept for backwards compatibility with older app builds)
  const sections = [];
  for (const s of pdpSections) {
    if (s.type === 'accordions') for (const it of s.items) sections.push(it);
    else if ((s.type === 'textBlock' || s.type === 'mediaBlock') && s.text && s.heading)
      sections.push({ heading: s.heading, text: s.text });
  }

  // marketplace links are extracted in-page (DOM) by the worker — see below.
  const marketplaces = {};

  return { handle, rating, reviewCount, reviews, pairsWith, sections, pdpSections, marketplaces, scrapedAt: new Date().toISOString() };
}

const todo = handles.filter((h) => FORCE || !fs.existsSync(path.join(OUT, h + '.json'))).slice(0, LIMIT);
console.log(`scraping ${todo.length} of ${handles.length} products`);

const browser = await chromium.launch({ executablePath: EXEC });
const CONCURRENCY = 3;
let done = 0, fail = 0;

async function worker(queue) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    return ['image', 'media', 'font'].includes(t) ? route.abort() : route.continue();
  });
  let h;
  while ((h = queue.shift())) {
    try {
      await page.goto(`https://studdmuffyn.com/products/${h}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // nudge lazy widgets (reviews, marketplace buttons) into rendering
      await page.mouse.wheel(0, 4000).catch(() => {});
      await page.waitForSelector('div.jdgm-rev', { timeout: 6000 }).catch(() => {});
      await page.waitForSelector('text=Also Available On', { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(800);
      const html = await page.content();
      const extras = parseExtras(html, h);
      // marketplace links via DOM: only from THIS product's own
      // "Also Available On" block (never a recommendation card's)
      extras.marketplaces = await page.evaluate((selfHandle) => {
        const out = {};
        const leaves = [...document.querySelectorAll('span,div,p,h1,h2,h3,h4,strong,b')].filter(
          (el) => el.children.length === 0 && /also available on/i.test(el.textContent || '')
        );
        for (const leaf of leaves) {
          // the product's own block lives in the MAIN product section —
          // recommendation cards live in featured_collection sections
          const sec = leaf.closest('[id*="shopify-section-template"]');
          if (!sec || !/__main\b/.test(sec.id || '')) continue;
          let c = leaf;
          for (let i = 0; i < 6 && c; i++) {
            const links = [...c.querySelectorAll('a[href*="amazon."],a[href*="flipkart.com"],a[href*="myntra.com"]')];
            if (links.length) {
              const foreign = [...c.querySelectorAll('a[href*="/products/"]')].some((a) => {
                const m = (a.getAttribute('href') || '').match(/\/products\/([a-z0-9-]+)/);
                return m && m[1] !== selfHandle;
              });
              if (!foreign) {
                for (const a of links) {
                  const u = a.href;
                  if (/amazon\./i.test(u) && !out.amazon) out.amazon = u;
                  else if (/flipkart\.com/i.test(u) && !out.flipkart) out.flipkart = u;
                  else if (/myntra\.com/i.test(u) && !out.myntra) out.myntra = u;
                }
                return out;
              }
              break; // container is another product's card — try next leaf
            }
            c = c.parentElement;
          }
        }
        return out;
      }, h).catch(() => ({}));
      fs.writeFileSync(path.join(OUT, h + '.json'), JSON.stringify(extras));
      done++;
      if (done % 20 === 0) console.log(`progress ${done}/${todo.length} (fail ${fail})`);
    } catch (e) {
      fail++;
      console.log('FAIL', h, String(e).slice(0, 80));
    }
    await page.waitForTimeout(300);
  }
  await ctx.close();
}

const queue = [...todo];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
await browser.close();

// index: rating + count per handle (for product cards)
const index = {};
for (const f of fs.readdirSync(OUT)) {
  if (!f.endsWith('.json')) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f)));
    const e = {};
    if (j.reviewCount) { e.r = j.rating; e.n = j.reviewCount; }
    const mk = j.marketplaces || {};
    if (mk.amazon) e.a = mk.amazon;
    if (mk.flipkart) e.f = mk.flipkart;
    if (mk.myntra) e.m = mk.myntra;
    if (Object.keys(e).length) index[j.handle] = e;
  } catch {}
}
fs.writeFileSync(path.join(DATA, 'extras-index.json'), JSON.stringify(index));
console.log(`DONE scraped=${done} failed=${fail} indexed=${Object.keys(index).length}`);
