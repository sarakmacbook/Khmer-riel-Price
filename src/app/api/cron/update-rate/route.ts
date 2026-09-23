import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { fetchWingBankQuote } from '@/lib/scraper';
import { getLatestTick, saveTick, storeBackend } from '@/lib/history-store';
import { ensurePostgresSchema } from '@/lib/ensure-schema';
import { sendTelegramWebhookAlert } from '@/lib/telegram';

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

    let notified = 0;
    if (bidChanged || !previous) {
      // Telegram alert delivery requires Postgres-backed subscriber storage;
      // on other store types this is skipped gracefully.
      try {
        const { telegramAlerts } = await import('@/db/schema');
        const { eq } = await import('drizzle-orm');
        const activeAlerts = await db.query.telegramAlerts.findMany({
          where: eq(telegramAlerts.active, true),
        });

        for (const alert of activeAlerts) {
          let shouldNotify = alert.condition === 'change' || !alert.condition;
          if (alert.condition === 'above' && alert.targetRate) {
            shouldNotify = quote.bid >= parseFloat(alert.targetRate);
          } else if (alert.condition === 'below' && alert.targetRate) {
            shouldNotify = quote.bid <= parseFloat(alert.targetRate);
          }
          if (!shouldNotify) continue;

          const diff = prevBid ? quote.bid - prevBid : 0;
          const arrow = diff > 0 ? '🟢 ↗' : diff < 0 ? '🔴 ↘' : '⚪ ➔';
          const msg =
            `📢 <b>Wing Bank Exchange Rate Update</b>\n\n` +
            `• <b>Bank Buys (Bid):</b> ${quote.bid.toLocaleString()} KHR ${prevBid ? `(${arrow} ${diff >= 0 ? '+' : ''}${diff})` : ''}\n` +
            `• <b>Bank Sells (Ask):</b> ${quote.ask.toLocaleString()} KHR\n` +
            `• <b>Time:</b> ${new Date().toLocaleTimeString()}\n\n` +
            `🔗 <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://wingrate.app'}">Open WingRate Live Chart</a>`;

          const res = await sendTelegramWebhookAlert({
            webhookUrl: alert.webhookUrl,
            botToken: alert.botToken,
            chatId: alert.chatId,
            text: msg,
          });
          if (res.success) notified += 1;

          try {
            await db.update(telegramAlerts).set({ lastAlertAt: new Date() }).where(eq(telegramAlerts.id, alert.id));
          } catch {
            /* ignore */
          }
        }
      } catch (err) {
        // No Postgres for alert storage — fine on Turso/Upstash/memory.
        if (storeBackend() === 'postgres') console.error('telegram alerts skipped:', err);
      }
    }

    return NextResponse.json({
      success: true,
      ...quote,
      previousBid: prevBid,
      changed: bidChanged,
      notified,
      store: storeBackend(),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
