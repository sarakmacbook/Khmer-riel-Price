import { NextRequest, NextResponse } from 'next/server';
import { fetchWingBankQuote } from '@/lib/scraper';
import { getLatestTick, saveTick, storeBackend } from '@/lib/history-store';
import { ensurePostgresSchema } from '@/lib/ensure-schema';
import { notifyRateChange } from '@/lib/alerts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // Basic security check for Vercel Cron Jobs
  if (process.env.CRON_SECRET && req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    if (storeBackend() === 'postgres') await ensurePostgresSchema();
    const previous = await getLatestTick().catch(() => null);
    const quote = await fetchWingBankQuote();

    await saveTick({ rate: quote.bid, bid: quote.bid, ask: quote.ask });

    const prevBid = previous?.bid ?? null;
    const bidChanged = prevBid !== null && prevBid !== quote.bid;

    // Automatic Telegram delivery. Goes through the RateStore abstraction, so
    // subscribers are honoured on Postgres, Turso, MongoDB, Upstash/Redis,
    // Vercel Blob and memory alike (it used to require Postgres and silently
    // skip on everything else).
    let notified = 0;
    let matched = 0;
    let alertError: string | undefined;
    if (bidChanged || !previous) {
      const res = await notifyRateChange(prevBid, quote).catch((e: unknown) => {
        console.error('[cron] telegram alerts failed:', e instanceof Error ? e.message : String(e));
        return { matched: 0, delivered: 0, error: e instanceof Error ? e.message : String(e) };
      });
      matched = res.matched;
      notified = res.delivered;
      alertError = res.error;
    }

    return NextResponse.json({
      success: true,
      ...quote,
      previousBid: prevBid,
      changed: bidChanged,
      matched,
      notified,
      alertError,
      store: storeBackend(),
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
