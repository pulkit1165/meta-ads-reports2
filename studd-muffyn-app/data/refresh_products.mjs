// Nightly catalog freshener: re-crawls all products and clears the cached
// product lists for every collection the app UI currently references
// (bundled config + live remote home config), so build_catalog refetches
// them in the site's current merchandised order.
import fs from 'fs';
import path from 'path';

const DATA = path.dirname(new URL(import.meta.url).pathname);

async function getJSON(url) {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 4000 + i * 2000)); continue; }
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } catch {
      await new Promise((s) => setTimeout(s, 3000));
    }
  }
  return null;
}

// 1. full product re-crawl
const products = [];
for (let page = 1; page <= 40; page++) {
  const j = await getJSON(`https://studdmuffyn.com/products.json?limit=250&page=${page}`);
  if (!j || !j.products.length) break;
  products.push(...j.products);
  await new Promise((s) => setTimeout(s, 500));
}
if (products.length < 100) {
  console.error('product crawl looks broken, keeping existing snapshot');
  process.exit(1);
}
fs.writeFileSync(path.join(DATA, 'products.json'), JSON.stringify(products));
console.log('products:', products.length);

// 2. collect UI-referenced collection handles
const needed = new Set();
for (const f of [path.join(DATA, '..', 'app', 'src', 'config', 'home.json'), path.join(DATA, '..', 'app', 'app', '(tabs)', 'categories.tsx')]) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\/collections\/([a-z0-9-]+)/g)) needed.add(m[1]);
  for (const m of src.matchAll(/"handle":\s*"([a-z0-9-]+)"/g)) needed.add(m[1]);
}
const remote = await getJSON('https://studd-muffyn-app.vercel.app/api/home-config');
for (const s of remote?.sections ?? []) {
  if (s.handle) needed.add(s.handle);
  if (s.collection) needed.add(s.collection);
  for (const it of s.items ?? []) if (it.handle) needed.add(it.handle);
}

// 3. clear their cached lists so build_catalog refetches fresh order
const collFile = path.join(DATA, 'collections.json');
const c = JSON.parse(fs.readFileSync(collFile));
let cleared = 0;
for (const h of needed) if (c.collectionProducts[h]) { delete c.collectionProducts[h]; cleared++; }
fs.writeFileSync(collFile, JSON.stringify(c));
console.log('cleared', cleared, 'collection lists for refresh');
