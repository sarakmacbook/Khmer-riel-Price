import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { exchangeRates } from '@/db/schema';
import { desc, gte } from 'drizzle-orm';
import { ensureDailyHistory } from '@/lib/seed-history';

export const dynamic = 'force-dynamic';

const RANGE_MS: Record<string, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

export async function GET(req: NextRequest) {
  try {
    await ensureDailyHistory();

    const range = req.nextUrl.searchParams.get('range') ?? 'day';
    const isAll = range === 'all';
    const windowMs = isAll ? null : (RANGE_MS[range] ?? RANGE_MS.day);

    let rows;
    if (windowMs) {
      const since = new Date(Date.now() - windowMs);
      rows = await db.query.exchangeRates.findMany({
        where: gte(exchangeRates.timestamp, since),
        orderBy: [desc(exchangeRates.timestamp)],
        limit: 3000,
      });
    } else {
      rows = await db.query.exchangeRates.findMany({
        orderBy: [desc(exchangeRates.timestamp)],
        limit: 3000,
      });
    }

    // Chronological order (oldest -> newest)
    const chronological = rows.reverse();

    let points: Array<{ rate: number; bid: number; ask: number; timestamp: Date | string }>;

    if (range === 'day') {
      // Intra-day points for the day view
      points = chronological.map((r: (typeof rows)[number]) => {
        const bankBuys = r.bid ? parseFloat(r.bid) : parseFloat(r.rate);
        return {
          rate: bankBuys,
          bid: bankBuys, // Bank buys USD
          ask: r.ask ? parseFloat(r.ask) : bankBuys + 8,
          timestamp: r.timestamp,
        };
      });
    } else {
      // Daily snapshot: 1 snapshot per calendar day (last record of that day)
      const dailyMap = new Map<string, typeof rows[number]>();
      for (const r of chronological) {
        const d = new Date(r.timestamp);
        const dayKey = d.toISOString().slice(0, 10); // YYYY-MM-DD
        dailyMap.set(dayKey, r); // latest of each day
      }

      points = Array.from(dailyMap.values()).map((r) => {
        const bankBuys = r.bid ? parseFloat(r.bid) : parseFloat(r.rate);
        return {
          rate: bankBuys,
          bid: bankBuys, // Bank buys USD
          ask: r.ask ? parseFloat(r.ask) : bankBuys + 8,
          timestamp: r.timestamp,
        };
      });
    }

    return NextResponse.json(points);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
