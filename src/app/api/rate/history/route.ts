import { NextRequest, NextResponse } from 'next/server';
import { loadTicks, seedHistoryIfEmpty, storeBackend, type Tick } from '@/lib/history-store';

export const dynamic = 'force-dynamic';

const RANGE_MS: Record<string, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

/**
 * Price history — served from whichever free-tier store is configured
 * (Postgres / Turso / Upstash) with daily-snapshot bucketing for
 * week/month/year/all ranges.
 */
export async function GET(req: NextRequest) {
  try {
    // Tables/keys are created on first use by the active store, then a brand-new
    // (empty) database is seeded with daily snapshots so this first request
    // already returns a useful chart. Works for every backend, including a
    // database connected from the Telegram 🗄 menu.
    await seedHistoryIfEmpty();

    const range = req.nextUrl.searchParams.get('range') ?? 'day';
    const isAll = range === 'all';
    const windowMs = isAll ? null : (RANGE_MS[range] ?? RANGE_MS.day);

    // Newest-first ticks from the active backend
    const rows = await loadTicks(windowMs, 3000);

    // Chronological order (oldest -> newest)
    const chronological = [...rows].reverse();

    const toPoint = (r: Tick) => {
      const bankBuys = Number.isFinite(r.bid) ? r.bid : r.rate;
      const bankSells = Number.isFinite(r.ask) ? r.ask : bankBuys + 8;
      return {
        rate: bankBuys,
        bid: bankBuys, // Bank buys USD
        ask: bankSells, // Bank sells USD
        timestamp: r.timestamp,
      };
    };

    let points;
    if (range === 'day') {
      // Intra-day points for the day view
      points = chronological.map(toPoint);
    } else {
      // Daily snapshot: 1 snapshot per calendar day (last record of that day)
      const dailyMap = new Map<string, Tick>();
      for (const r of chronological) {
        const dayKey = new Date(r.timestamp).toISOString().slice(0, 10);
        dailyMap.set(dayKey, r);
      }
      points = Array.from(dailyMap.values()).map(toPoint);
    }

    return NextResponse.json(points, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        'x-store': storeBackend(),
      },
    });
  } catch (error: any) {
    // No store configured / tables not created yet (fresh deploy on a DB
    // type that is not set up): return an empty chart series instead of
    // breaking the page with a 500.
    console.error('history unavailable:', error);
    return NextResponse.json([], {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  }
}
