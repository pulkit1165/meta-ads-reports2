// Read a Shopify storefront's CSS custom properties and emit the app's colour
// palette, so a brand's app mirrors its site instead of us eyeballing hex codes.
// Handles both dialects we ship against: the SM theme (--color-button-primary-*,
// hex values) and Dawn (--color-button, "r,g,b" triplets).
//
//   node tools/extract_brand_theme.mjs https://studdmuffynlife.com [--json]
const site = process.argv[2];
const asJson = process.argv.includes('--json');
if (!site) { console.error('usage: extract_brand_theme.mjs <site> [--json]'); process.exit(1); }

const html = await (await fetch(site, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
let css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).join('\n');
for (const href of [...html.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"/gi)].map(m => m[1]).slice(0, 8)) {
  const u = href.startsWith('http') ? href : href.startsWith('//') ? 'https:' + href : new URL(href, site).href;
  try { css += '\n' + await (await fetch(u)).text(); } catch {}
}
const vars = {};
for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+)/gi)) {
  const k = m[1].trim(), v = m[2].trim();
  if (!(k in vars)) vars[k] = v;
}

const hex = (v) => {
  if (!v) return null;
  const t = v.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(t)) return t.length === 4
    ? '#' + [...t.slice(1)].map(c => c + c).join('') : t.toLowerCase();
  const n = t.match(/^(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})$/);
  if (n) return '#' + [n[1], n[2], n[3]].map(x => (+x).toString(16).padStart(2, '0')).join('');
  const rgb = t.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (rgb) return '#' + [rgb[1], rgb[2], rgb[3]].map(x => (+x).toString(16).padStart(2, '0')).join('');
  return null;
};
const pick = (...names) => { for (const n of names) { const h = hex(vars[n]); if (h) return h; } return null; };

// mix a hex toward white/black — used where a theme declares no explicit tint
const mix = (a, b, t) => {
  const p = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  return '#' + [r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]
    .map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
};
const rgba = (h, a) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
};

const bg     = pick('--color-background', '--color-base-background-1') || '#ffffff';
const text   = pick('--color-text', '--color-foreground', '--color-base-text') || '#121212';
const accent = pick('--color-button-primary-background', '--color-button', '--color-base-accent-1', '--color-accent') || '#c79353';
const accentText = pick('--color-button-primary-text', '--color-button-text') || '#ffffff';
const header = pick('--color-background-header') || bg;
const border = pick('--color-border', '--color-background-contrast', '--color-base-border') || mix(bg, text, 0.14);
const sale   = pick('--color-products-sale-price', '--color-sale-price') || '#de0f2b';

const theme = {
  bg,
  surface:   mix(bg, text, 0.035),
  surfaceHi: mix(bg, text, 0.09),
  card:      bg,
  header,
  line:      border,
  text,
  textDim:   rgba(text, 0.65),
  textFaint: rgba(text, 0.42),
  gold:      accent,
  goldSoft:  pick('--color-button-primary-background-hover', '--color-base-accent-2') || mix(accent, '#000000', 0.12),
  goldDeep:  mix(accent, '#000000', 0.22),
  cream:     accentText,
  sale,
  saleBadge: pick('--color-background-sale-badge') || sale,
  danger:    '#D02F2E',
  success:   '#0d944b',
  overlay:   'rgba(0,0,0,0.8)',
  chip:      rgba(accent, 0.12),
};

if (asJson) { console.log(JSON.stringify(theme, null, 2)); }
else {
  console.log(site, `(${Object.keys(vars).length} css vars)`);
  for (const [k, v] of Object.entries(theme)) console.log('  ' + k.padEnd(10), v);
}
