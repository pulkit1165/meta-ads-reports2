// Which brand this binary is. Set per build in app.config.js via APP_BRAND;
// defaults to Studd Muffyn so existing builds and the web preview are unchanged.
import Constants from 'expo-constants';
import { BRANDS, type Brand, type BrandKey } from './brands';

const fromConfig = (Constants.expoConfig?.extra as any)?.brand as BrandKey | undefined;
const key: BrandKey = fromConfig && BRANDS[fromConfig] ? fromConfig : 'sm';

export const BRAND: Brand = BRANDS[key];
export const BRAND_KEY = key;
export const SITE = BRAND.site;
export const SHOP = BRAND.shop;
export const APP_API = BRAND.apiBase;
