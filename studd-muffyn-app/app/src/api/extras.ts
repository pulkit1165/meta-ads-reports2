// Per-product extras scraped from the website's own product pages:
// Judge.me review data, Pairs-well-with, and theme detail sections.
// Served as static JSON from the app's Vercel deployment.
import { useEffect, useState } from 'react';

const EXTRAS_BASE = 'https://studd-muffyn-app.vercel.app/extras';

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
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 7000);
        const r = await fetch(`${EXTRAS_BASE}/${handle}.json`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) {
          cache.set(handle, null);
          return;
        }
        const j = (await r.json()) as ProductExtras;
        cache.set(handle, j);
        if (alive) setExtras(j);
      } catch {
        cache.set(handle, null);
      }
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
