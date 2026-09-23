import { NextRequest, NextResponse } from 'next/server';
import { getStore, type Point } from '@/lib/store';
import { DAY_MS, errMsg } from '@/lib/store/types';

export const dynamic = 'force-dynamic';

const RANGE_MS: Record<string, number> = { day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS, year: 365 * DAY_MS };

export async function GET(req: NextRequest) {
  let store;
  try {
    store = await getStore();
  } catch {
    store = null;
  }
  if (!store || !store.persistent) {
    // History needs a database; the UI explains this instead of erroring
    return NextResponse.json([], { headers: { 'Cache-Control': 'public, s-maxage=300', 'X-WingRate-Storage': 'memory' } });
  }

  try {
    const range = req.nextUrl.searchParams.get('range') ?? 'day';
    const now = Date.now();
    const since = range === 'all' ? null : now - (RANGE_MS[range] ?? DAY_MS);
    let points: Point[];

    if (range === 'day' && since !== null) {
      // Price changes in the last 24h + the price that was active at the window start
      const [inWindow, prior] = await Promise.all([store.range(since), store.before(since)]);
      points = prior ? [{ ...prior, t: since }, ...inWindow] : inWindow;
    } else {
      points = await store.daily(since); // last price of each local day
    }

    // Extend the line to "now" with the current price
    const last = points[points.length - 1];
    if (last && now - last.t > 60_000) points.push({ ...last, t: now });

    return NextResponse.json(points, {
      headers: {
        'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
        'X-WingRate-Storage': store.kind,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: errMsg(error), storage: store.kind }, { status: 500 });
  }
}
