import { STORES, credsFor, type Store } from './stores';

export interface Order {
  store: Store['key'];
  storeName: string;
  name: string;
  createdAt: string;
  total: number;
  currency: string;
  financialStatus: string;
  fulfillmentStatus: string | null;
  customer: string;
  city: string;
  items: { title: string; qty: number }[];
  channel: 'app' | 'web';
  cancelled: boolean;
  adminUrl: string;
}

// The app appends utm_medium=mobile_app to every cart permalink it opens, so
// that marker — not the store domain — is what identifies an app order. It
// works for any brand's app without needing a per-brand rule.
const APP_MARKER = /utm_medium=mobile_app/i;

// Mirrors the reporting pipeline's SALES_FILTER: bulk re-imports are not sales.
const EXCLUDED_SOURCES = new Set(['Matrixify App']);

function classify(o: any): 'app' | 'web' {
  const hay = `${o.landing_site || ''} ${o.referring_site || ''} ${o.note_attributes
    ?.map((a: any) => `${a.name}=${a.value}`).join(' ') || ''}`;
  return APP_MARKER.test(hay) ? 'app' : 'web';
}

async function fetchStore(s: Store, sinceISO: string): Promise<Order[]> {
  const { url, token, ok } = credsFor(s);
  if (!ok) return [];
  const params = new URLSearchParams({
    limit: '250',
    status: 'any',
    created_at_min: sinceISO,
    fields: 'id,name,created_at,cancelled_at,source_name,landing_site,referring_site,' +
            'note_attributes,total_price,currency,financial_status,fulfillment_status,' +
            'customer,shipping_address,line_items',
  });
  const out: Order[] = [];
  let next: string | null = `https://${url}/admin/api/2024-10/orders.json?${params}`;
  for (let page = 0; next && page < 8; page++) {
    const r: Response = await fetch(next, {
      headers: { 'X-Shopify-Access-Token': token },
      cache: 'no-store',
    });
    if (!r.ok) break;
    const body: any = await r.json();
    for (const o of body.orders || []) {
      if (EXCLUDED_SOURCES.has(o.source_name)) continue;
      const addr = o.shipping_address || {};
      const cust = o.customer || {};
      out.push({
        store: s.key,
        storeName: s.name,
        name: o.name,
        createdAt: o.created_at,
        total: Number(o.total_price || 0),
        currency: o.currency || 'INR',
        financialStatus: o.financial_status || '',
        fulfillmentStatus: o.fulfillment_status,
        customer: (addr.name || `${cust.first_name || ''} ${cust.last_name || ''}`).trim(),
        city: addr.city || '',
        items: (o.line_items || []).map((l: any) => ({ title: l.title, qty: l.quantity })),
        channel: classify(o),
        cancelled: Boolean(o.cancelled_at),
        adminUrl: `https://${url}/admin/orders/${o.id}`,
      });
    }
    const link = r.headers.get('link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;
  }
  return out;
}

export async function getOrders(hours = 24) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const per = await Promise.all(STORES.map((s) => fetchStore(s, since).catch(() => [])));
  const orders = per.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const live = orders.filter((o) => !o.cancelled);
  const sum = (list: Order[]) => list.reduce((a, o) => a + o.total, 0);
  const app = live.filter((o) => o.channel === 'app');

  return {
    generatedAt: new Date().toISOString(),
    windowHours: hours,
    totals: {
      orders: live.length,
      revenue: Math.round(sum(live)),
      appOrders: app.length,
      appRevenue: Math.round(sum(app)),
      aov: live.length ? Math.round(sum(live) / live.length) : 0,
      appAov: app.length ? Math.round(sum(app) / app.length) : 0,
    },
    byStore: STORES.map((s) => {
      const mine = live.filter((o) => o.store === s.key);
      const mineApp = mine.filter((o) => o.channel === 'app');
      return {
        key: s.key,
        name: s.name,
        configured: credsFor(s).ok,
        orders: mine.length,
        revenue: Math.round(sum(mine)),
        appOrders: mineApp.length,
        appRevenue: Math.round(sum(mineApp)),
      };
    }),
    // The table shows the most recent 300, but every app order is kept
    // regardless of age — otherwise the "app only" view would disagree with
    // the app-orders stat above it.
    orders: [
      ...new Map(
        [...orders.slice(0, 300), ...orders.filter((o) => o.channel === 'app')]
          .map((o) => [`${o.store}${o.name}`, o])
      ).values(),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}
