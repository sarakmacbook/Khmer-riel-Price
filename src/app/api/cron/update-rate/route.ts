import { NextRequest, NextResponse } from 'next/server';
import { fetchWingBankQuote } from '@/lib/scraper';
import { saveTick, storeBackend } from '@/lib/history-store';
import { notifyRateChange } from '@/lib/alerts';
import { runLinkMaintenance } from '@/lib/link-jobs';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // Basic security check for Vercel Cron Jobs
  if (process.env.CRON_SECRET && req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // The active store creates its own schema/keys on first use (Postgres,
    // Turso, MongoDB, Redis, Blob) — including a database connected at runtime.
    const quote = await fetchWingBankQuote();

    // `record()` returns the actual previous quote atomically. The live-rate
    // endpoint also records ticks, so a separate `latest()` read here could
    // observe the new quote and make the cron incorrectly conclude nothing moved.
    const recorded = await saveTick({ rate: quote.bid, bid: quote.bid, ask: quote.ask });
    const previous = recorded?.prev ?? null;
    const prevBid = previous?.bid ?? null;
    const bidChanged = previous !== null && recorded?.changed === true && prevBid !== quote.bid;
    const priceMoved = previous !== null && recorded?.changed === true;

    // Automatic Telegram delivery — only the request that atomically recorded
    // an actual move sends alerts. The live-rate endpoint uses the same result,
    // so visitor traffic cannot consume a rate change before the cron sees it.
    let notified = 0;
    let matched = 0;
    let alertError: string | undefined;
    if (priceMoved) {
      const res = await notifyRateChange(previous, quote).catch((e: unknown) => {
        console.error('[cron] telegram alerts failed:', e instanceof Error ? e.message : String(e));
        return { matched: 0, delivered: 0, error: e instanceof Error ? e.message : String(e) };
      });
      matched = res.matched;
      notified = res.delivered;
      alertError = res.error;
    }

    // Backup database: finish any pending re-sync / repair a lagging mirror.
    // Cheap when everything is in sync (two lightweight probe reads).
    const link = await runLinkMaintenance().catch((e: unknown) => ({
      ran: false,
      reason: undefined as string | undefined,
      error: e instanceof Error ? e.message : String(e),
      actions: [] as Awaited<ReturnType<typeof runLinkMaintenance>>['actions'],
    }));

    return NextResponse.json({
      success: true,
      ...quote,
      previousBid: prevBid,
      changed: bidChanged,
      moved: priceMoved,
      matched,
      notified,
      alertError,
      store: storeBackend(),
      link: {
        ran: link.ran,
        reason: link.reason ?? null,
        error: link.error ?? null,
        copied: link.actions.reduce((n, a) => n + (a.history?.copied ?? 0) + (a.alerts?.copied ?? 0), 0),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
