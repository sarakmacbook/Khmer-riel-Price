import { NextResponse } from 'next/server';
import { getLatestRate } from '@/lib/rates';
import { ScrapeError } from '@/lib/scraper';
import { detectStore } from '@/lib/store/env';

export const dynamic = 'force-dynamic';
// Allow time for a slow Wing Bank response on the very first request
export const maxDuration = 60;

export async function GET() {
  try {
    const latest = await getLatestRate();
    // With a shared database every instance sees the same value → short CDN cache.
    // Without one, cache longer so cold instances rarely need to scrape.
    const cache =
      latest.storage !== 'memory'
        ? 'public, max-age=0, s-maxage=5, stale-while-revalidate=55'
        : 'public, max-age=0, s-maxage=30, stale-while-revalidate=300';
    return NextResponse.json(latest, { headers: { 'Cache-Control': cache } });
  } catch (error) {
    const err = error as Error;
    const kind = err instanceof ScrapeError ? err.kind : 'unknown';
    const hint =
      kind === 'blocked'
        ? "Wing Bank's firewall is blocking this server's IP. Set WINGBANK_URL to a proxy, or self-host with install.sh."
        : kind === 'timeout'
          ? 'Wing Bank is responding slowly. It will retry automatically.'
          : 'Open /api/status?check=1 for diagnostics.';
    let storage = 'unknown';
    try {
      storage = detectStore().kind;
    } catch {}
    return NextResponse.json(
      { error: err.message, kind, hint, storage },
      // Cache errors briefly so polling browsers don't trigger a scrape every 5s
      { status: 503, headers: { 'Cache-Control': 'public, max-age=0, s-maxage=15' } },
    );
  }
}
