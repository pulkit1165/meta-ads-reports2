// Brand definitions. One codebase, one app per store.
//
// Palettes were extracted from each store's live CSS custom properties with
// tools/extract_brand_theme.mjs, so a brand's app matches its own site rather
// than inheriting Studd Muffyn's gold. Re-run that script and paste here when
// a store restyles; changes ship over-the-air, no App Store review.
export type BrandKey = 'sm' | 'sml';

export interface Brand {
  key: BrandKey;
  name: string;
  site: string;          // storefront the app mirrors
  shop: string;          // *.myshopify.com, for Admin-API backed endpoints
  apiBase: string;       // Vercel deployment serving /api/*
  colors: Record<string, string>;
}

export const BRANDS: Record<BrandKey, Brand> = {
  sm: {
    key: 'sm',
    name: 'Studd Muffyn',
    site: 'https://studdmuffyn.com',
    shop: 'studd-muffyn.myshopify.com',
    apiBase: 'https://studd-muffyn-app.vercel.app',
    colors: {
        bg: "#ffffff",
        surface: "#f7f7f7",
        surfaceHi: "#eaeaea",
        card: "#ffffff",
        header: "#fcf4ee",
        line: "#e4ddd9",
        text: "#121212",
        textDim: "rgba(18,18,18,0.65)",
        textFaint: "rgba(18,18,18,0.42)",
        gold: "#c79353",
        goldSoft: "#ba823c",
        goldDeep: "#9b7341",
        cream: "#fcf4ee",
        sale: "#de0f2b",
        saleBadge: "#e40e47",
        danger: "#D02F2E",
        success: "#0d944b",
        overlay: "rgba(0,0,0,0.8)",
        chip: "rgba(199,147,83,0.12)"
    },
  },
  sml: {
    key: 'sml',
    name: 'Studd Muffyn Life',
    site: 'https://studdmuffynlife.com',
    shop: 'studdmuffynlife.myshopify.com',
    apiBase: 'https://studd-muffyn-app.vercel.app',
    colors: {
        bg: "#ffffff",
        surface: "#f8f8f8",
        surfaceHi: "#ececec",
        card: "#ffffff",
        header: "#ffffff",
        line: "#bfbfbf",
        text: "#2b2c2d",
        textDim: "rgba(43,44,45,0.65)",
        textFaint: "rgba(43,44,45,0.42)",
        gold: "#b7aca2",
        goldSoft: "#a1978f",
        goldDeep: "#8f867e",
        cream: "#262626",
        sale: "#de0f2b",
        saleBadge: "#de0f2b",
        danger: "#D02F2E",
        success: "#0d944b",
        overlay: "rgba(0,0,0,0.8)",
        chip: "rgba(183,172,162,0.12)"
    },
  },
};
