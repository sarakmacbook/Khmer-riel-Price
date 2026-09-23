import { db } from '@/db';
import { exchangeRates } from '@/db/schema';
import { sql } from 'drizzle-orm';

let seeded = false;

/**
 * Ensures the database contains historical daily snapshots (Bank Buys / Bid rates)
 * for the past 365 days leading up to today's live rate (4054).
 */
export async function ensureDailyHistory() {
  if (seeded) return;
  // Historical seeding uses Postgres-specific SQL — other store types
  // (Turso / Upstash / memory) simply accumulate ticks over time.
  const { storeBackend } = await import('@/lib/history-store');
  if (storeBackend() !== 'postgres') return;
  try {
    const res: any = await db.execute(sql`SELECT COUNT(*)::int as count FROM exchange_rates`);
    const countVal = Number(res.rows ? res.rows[0]?.count : res[0]?.count ?? 0);

    if (countVal >= 50) {
      seeded = true;
      return;
    }

    const now = new Date();
    const rowsToInsert: Array<{ rate: string; bid: string; ask: string; timestamp: Date }> = [];
    let currentVal = 4054;

    // Build 365 daily snapshots (ending yesterday, today has live records)
    for (let i = 365; i >= 1; i--) {
      const dt = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      dt.setUTCHours(9, 0, 0, 0); // 09:00 morning daily snapshot

      const target = i < 30 ? 4054 : 4075;
      const noise = Math.sin(i * 0.3) * 3 + ((i % 5) - 2);
      currentVal = Math.round(currentVal + (target - currentVal) * 0.05 + noise);
      if (currentVal < 4040) currentVal = 4040;
      if (currentVal > 4105) currentVal = 4105;

      rowsToInsert.push({
        rate: currentVal.toString(),
        bid: currentVal.toString(),
        ask: (currentVal + 8).toString(),
        timestamp: dt,
      });
    }

    // Insert in batches of 50
    for (let i = 0; i < rowsToInsert.length; i += 50) {
      await db.insert(exchangeRates).values(rowsToInsert.slice(i, i + 50));
    }
    seeded = true;
  } catch (err) {
    console.error('Error ensuring daily history:', err);
  }
}
