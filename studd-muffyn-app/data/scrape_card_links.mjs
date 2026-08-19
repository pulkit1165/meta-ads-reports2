// Read Amazon/Flipkart/Myntra links straight from the site's collection-page
// product cards — each card pairs one product with its own buttons, so the
// mapping is unambiguous. Crawls /collections/all with pagination.
import fs from 'fs';
import path from 'path';
import { chromium, devices } from 'playwright';

const DATA = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DATA, 'extras');
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const browser = await chromium.launch({ executablePath: EXEC });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();

const map = {}; // handle -> {amazon?, flipkart?, myntra?}
let pageNo = 1;
while (pageNo <= 60) {
  await page.goto(`https://studdmuffyn.com/collections/all?page=${pageNo}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('text=Also Available On', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const cards = await page.evaluate(() => {
    const out = [];
    const leaves = [...document.querySelectorAll('span,div,p,strong,b,h3,h4')].filter(
      (el) => el.children.length === 0 && /also available on/i.test(el.textContent || '')
    );
    for (const leaf of leaves) {
      let c = leaf;
      for (let i = 0; i < 10 && c; i++) {
        const prod = c.querySelector('a[href*="/products/"]');
        const links = [...c.querySelectorAll('a[href*="amazon."],a[href*="flipkart.com"],a[href*="myntra.com"]')];
        if (prod && links.length) {
          const m = (prod.getAttribute('href') || '').match(/\/products\/([a-z0-9-]+)/);
          if (m) {
            const e = { handle: m[1] };
            for (const a of links) {
              const u = a.href;
              if (/amazon\./i.test(u) && !e.amazon) e.amazon = u;
              else if (/flipkart\.com/i.test(u) && !e.flipkart) e.flipkart = u;
              else if (/myntra\.com/i.test(u) && !e.myntra) e.myntra = u;
            }
            out.push(e);
          }
          break;
        }
        c = c.parentElement;
      }
    }
    // page product count for pagination stop
    const prodCount = new Set([...document.querySelectorAll('a[href*="/products/"]')].map((a) => a.getAttribute('href'))).size;
    return { cards: out, prodCount };
  });
  for (const c of cards.cards) {
    const { handle, ...links } = c;
    if (Object.keys(links).length) map[handle] = { ...map[handle], ...links };
  }
  console.log(`page ${pageNo}: ${cards.cards.length} carded, total mapped ${Object.keys(map).length}`);
  if (cards.prodCount < 3) break;
  pageNo++;
  await page.waitForTimeout(400);
}
await browser.close();

// merge into extras files
let updated = 0;
for (const [handle, links] of Object.entries(map)) {
  const f = path.join(OUT, handle + '.json');
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f));
  j.marketplaces = { ...(j.marketplaces || {}), ...links };
  fs.writeFileSync(f, JSON.stringify(j));
  updated++;
}
fs.writeFileSync(path.join(DATA, 'card-links.json'), JSON.stringify(map, null, 1));
console.log(`DONE mapped=${Object.keys(map).length} merged=${updated}`);
