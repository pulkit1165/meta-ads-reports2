import { NextResponse } from 'next/server';
import { getOrders } from '@/lib/orders';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const hours = Math.min(Math.max(Number(url.searchParams.get('hours') || 24), 1), 720);
  try {
    const data = await getOrders(hours);
    return NextResponse.json(data, {
      // Three stores x several pages is ~15s of Shopify calls, so let the edge
      // hold it briefly. The page re-polls every 2 min, well past this window.
      headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=300' },
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
