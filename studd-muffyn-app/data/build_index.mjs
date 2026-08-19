// Rebuild extras/index.json: rating + review count + marketplace links per
// product — powers stars and Also-Available-On buttons on product cards.
import fs from 'fs';
import path from 'path';
const DATA = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DATA, 'extras');
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
console.log('index entries:', Object.keys(index).length,
  '| with marketplace links:', Object.values(index).filter((e) => e.a || e.f || e.m).length);
