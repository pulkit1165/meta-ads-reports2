// Per-product extras scraped from the website's own product pages:
// Judge.me review data, Pairs-well-with, and theme detail sections.
// Served as static JSON from the app's Vercel deployment.
import { useEffect, useState } from 'react';

const APP_API = 'https://studd-muffyn-app.vercel.app';
const EXTRAS_BASE = `${APP_API}/extras`;
// Live endpoint reads the real product page on demand; the static snapshot
// under /extras is the offline/last-resort fallback.
const LIVE_EXTRAS = `${APP_API}/api/extras`;

export interface Review {
  score: number;
  author: string;
  date: string;
  title: string;
  body: string;
}

export interface PdpImage {
  url: string;
  aspect: number | null;
}

export interface PdpSection {
  type: 'accordions' | 'textBlock' | 'mediaBlock' | 'imageStrip' | 'rail';
  heading?: string;
  text?: string;
  items?: { heading: string; text: string }[];
  image?: PdpImage | null;
  images?: PdpImage[];
  collection?: string | null;
  products?: string[];
}

export interface ProductExtras {
  handle: string;
  rating: number;
  reviewCount: number;
  reviews: Review[];
  pairsWith: string[];
  sections: { heading: string; text: string }[];
  pdpSections?: PdpSection[];
  marketplaces?: { amazon?: string; flipkart?: string; myntra?: string };
}

const cache = new Map<string, ProductExtras | null>();

export function useProductExtras(handle?: string): ProductExtras | null {
  const [extras, setExtras] = useState<ProductExtras | null>(
    handle && cache.has(handle) ? cache.get(handle)! : null
  );

  useEffect(() => {
    if (!handle) return;
    if (cache.has(handle)) {
      setExtras(cache.get(handle)!);
      return;
    }
    let alive = true;
    (async () => {
      const load = async (url: string, ms: number) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), ms);
        try {
          const r = await fetch(url, { signal: ctrl.signal });
          if (!r.ok) return null;
          return (await r.json()) as ProductExtras;
        } catch {
          return null;
        } finally {
          clearTimeout(t);
        }
      };
      // live first (always current), static snapshot as fallback
      const j =
        (await load(`${LIVE_EXTRAS}?handle=${encodeURIComponent(handle)}`, 9000)) ??
        (await load(`${EXTRAS_BASE}/${handle}.json`, 7000));
      cache.set(handle, j);
      if (alive && j) setExtras(j);
    })();
    return () => {
      alive = false;
    };
  }, [handle]);

  return extras;
}

// ---- compact index: rating + marketplace links per handle (one fetch) ------
export interface IndexEntry {
  r?: number; // rating
  n?: number; // review count
  a?: string; // amazon url
  f?: string; // flipkart url
  m?: string; // myntra url
}

let indexCache: Record<string, IndexEntry> | null = null;
let indexPromise: Promise<void> | null = null;
const indexListeners = new Set<() => void>();

function loadIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      try {
        const r = await fetch(`${EXTRAS_BASE}/index.json`);
        if (r.ok) indexCache = await r.json();
      } catch {}
      indexListeners.forEach((l) => l());
    })();
  }
}

export function useExtrasIndex(): Record<string, IndexEntry> | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (indexCache) return;
    loadIndex();
    const l = () => force((x) => x + 1);
    indexListeners.add(l);
    return () => {
      indexListeners.delete(l);
    };
  }, []);
  return indexCache;
}
