// The three storefronts, and the credentials each needs. Tokens stay
// server-side — every Shopify call happens in a route handler, never
// in the browser.
export interface Store {
  key: 'SM' | 'SML' | 'NBP';
  name: string;
  site: string;
  urlEnv: string;
  tokenEnv: string;
}

export const STORES: Store[] = [
  { key: 'SM',  name: 'Studd Muffyn',      site: 'https://studdmuffyn.com',     urlEnv: 'SHOPIFY_STORE_URL',     tokenEnv: 'SHOPIFY_ACCESS_TOKEN' },
  { key: 'SML', name: 'Studd Muffyn Life', site: 'https://studdmuffynlife.com', urlEnv: 'SHOPIFY_STORE_URL_SML', tokenEnv: 'SHOPIFY_ACCESS_TOKEN_SML' },
  { key: 'NBP', name: 'Nuskhe By Paras',   site: 'https://nuskhebyparas.com',   urlEnv: 'SHOPIFY_STORE_URL_NBP', tokenEnv: 'SHOPIFY_ACCESS_TOKEN_NBP' },
];

export function credsFor(s: Store) {
  const url = (process.env[s.urlEnv] || '').replace('https://', '').replace(/\/$/, '');
  const token = process.env[s.tokenEnv] || '';
  return { url, token, ok: Boolean(url && token) };
}
