import { NextRequest, NextResponse } from 'next/server';
import { fetchWingBankQuote } from '@/lib/scraper';
import { getLatestTick, saveTick, storeBackend } from '@/lib/history-store';
import { notifyRateChange } from '@/lib/alerts';

export const dynamic = 'force-dynamic';
// Give the Wing Bank scrape room to finish on a cold start without being
// killed by the serverless function limit.
export const maxDuration = 30;

// Keep the edge cache short so active clients notice bank rate changes quickly.
// The scraper has its own short cache to avoid hammering Wing Bank.
const CDN_CACHE = {
  'Cache-Control': 'public, s-maxage=2, max-age=0',
};
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Live rate endpoint — works with ANY free-tier store (or none at all):
 *   1. scrape Wing Bank live (10s server cache, 9.5s timeout, dual URL race)
 *   2. fall back to the latest stored tick (Postgres / Turso / Upstash / memory)
 *   3. 503 only if BOTH are unavailable
 */
export async function GET(req: NextRequest) {
  const forceRefresh = req.nextUrl.searchParams.get('refresh') === '1';
  let quote = null;
  try {
    quote = await fetchWingBankQuote({ force: forceRefresh });
  } catch (error) {
    console.error('live scrape failed, falling back to stored tick:', error);
  }

  let latest = null;
  try {
    latest = await getLatestTick();
  } catch (error) {
    console.error('stored tick unavailable:', error);
  }

  const rate = quote ? quote.bid : latest?.rate ?? null;
  const bid = quote ? quote.bid : latest?.bid ?? rate;
  const ask = quote ? quote.ask : latest?.ask ?? rate;

  if (rate === null) {
    return NextResponse.json(
      { error: 'Rate source unreachable and no stored tick available' },
      { status: 503, headers: NO_STORE },
    );
  }

  const timestamp = quote
    ? new Date().toISOString()
    : latest?.timestamp ?? new Date().toISOString();

  // Best-effort: persist a tick (visitor traffic keeps history flowing even
  // if the cron has not run yet). Use the atomic record result to alert on a
  // move here too; otherwise this endpoint could save the new price first and
  // leave the cron seeing no change. Send immediately after recording it.
  if (quote) {
    const recorded = await saveTick({ rate: quote.bid, bid: quote.bid, ask: quote.ask });
    if (recorded?.changed && recorded.prev) {
      const previous = { bid: recorded.prev.bid, ask: recorded.prev.ask };
      try {
        const result = await notifyRateChange(previous, quote);
        if (result.error) console.error('[rate] telegram alert failed:', result.error);
      } catch (error) {
        // Telegram must never make the live-rate endpoint fail.
        console.error('[rate] telegram alerts failed:', error instanceof Error ? error.message : String(error));
      }
    }
  }

  const store = storeBackend();

  return NextResponse.json(
    {
      rate,
      bid, // bank buys USD  -> baseline for your P2P SELL
      ask, // bank sells USD  -> baseline for your P2P BUY
      timestamp,
      source: quote ? 'live' : 'stored',
      store, // postgres | turso | upstash | memory
      database: store !== 'memory',
    },
    { headers: !forceRefresh && quote ? CDN_CACHE : NO_STORE },
  );
}
