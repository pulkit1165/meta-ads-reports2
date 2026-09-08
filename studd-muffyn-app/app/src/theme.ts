// Design system for whichever brand this binary ships as. Palettes live in
// src/config/brands.ts, extracted from each store's own CSS variables, so the
// app mirrors its site rather than hard-coding one brand's colours.
import { Dimensions, Platform } from 'react-native';
import { BRAND } from './config/brand';

// On web the app renders inside a centered phone-width frame, so all
// width math must use the frame width, not the browser window width.
export const SCREEN_W = Platform.OS === 'web'
  ? Math.min(Dimensions.get('window').width, 430)
  : Dimensions.get('window').width;

export const colors = BRAND.colors as unknown as {
  bg: string;
  surface: string;
  surfaceHi: string;
  card: string;
  header: string;
  line: string;
  text: string;
  textDim: string;
  textFaint: string;
  gold: string;
  goldSoft: string;
  goldDeep: string;
  cream: string;
  sale: string;
  saleBadge: string;
  danger: string;
  success: string;
  overlay: string;
  chip: string;
};

export const goldGradient = [BRAND.colors.goldSoft, BRAND.colors.gold, BRAND.colors.goldDeep] as const;
export const darkGradient = ['rgba(0,0,0,0)', 'rgba(0,0,0,0.65)'] as const;

export const radius = { sm: 10, md: 16, lg: 22, xl: 30, pill: 999 };

export const spacing = (n: number) => n * 4;

export const type = {
  // Site pairs a classic serif for headings ("New York"/Baskerville stack)
  // with a clean sans body — Georgia is the closest built-in match.
  display: { fontFamily: 'Georgia', letterSpacing: 0.2 },
  body: { fontFamily: 'System' },
};

export const shadow = {
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  glow: {
    shadowColor: colors.gold,
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
};

export const INR = (v: number | string) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (Number.isNaN(n)) return '';
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
};

export const pctOff = (price: number, compareAt?: number | null) => {
  if (!compareAt || compareAt <= price) return 0;
  return Math.round(((compareAt - price) / compareAt) * 100);
};
