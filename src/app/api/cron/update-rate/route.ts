import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { exchangeRates, telegramAlerts } from '@/db/schema';
import { fetchWingBankQuote } from '@/lib/scraper';
import { sendTelegramWebhookAlert } from '@/lib/telegram';
import { desc, eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Basic security check for Vercel Cron Jobs
  if (process.env.CRON_SECRET && req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const previous = await db.query.exchangeRates.findFirst({
      orderBy: [desc(exchangeRates.timestamp)],
    });

    const quote = await fetchWingBankQuote();

    await db.insert(exchangeRates).values({
      rate: quote.rate.toString(),
      bid: quote.bid.toString(),
      ask: quote.ask.toString(),
    });

    // Check if rate changed and notify active telegram alerts
    const prevBid = previous?.bid ? parseFloat(previous.bid) : (previous ? parseFloat(previous.rate) : null);
    const prevAsk = previous?.ask ? parseFloat(previous.ask) : null;
    const bidChanged = prevBid !== null && prevBid !== quote.bid;
    const askChanged = prevAsk !== null && prevAsk !== quote.ask;

    if (bidChanged || askChanged || !previous) {
      const activeAlerts = await db.query.telegramAlerts.findMany({
        where: eq(telegramAlerts.active, true),
      });

      for (const alert of activeAlerts) {
        let shouldNotify = false;
        if (alert.condition === 'change' || !alert.condition) {
          shouldNotify = true;
        } else if (alert.condition === 'above' && alert.targetRate) {
          shouldNotify = quote.bid >= parseFloat(alert.targetRate);
        } else if (alert.condition === 'below' && alert.targetRate) {
          shouldNotify = quote.bid <= parseFloat(alert.targetRate);
        }

        if (shouldNotify) {
          const diffBid = prevBid ? quote.bid - prevBid : 0;
          const arrow = diffBid > 0 ? '🟢 ↗' : diffBid < 0 ? '🔴 ↘' : '⚪ ➔';
          const alertMsg = `📢 <b>Wing Bank Exchange Rate Update</b>\n\n` +
            `• <b>Bank Buys (Bid):</b> ${quote.bid.toLocaleString()} KHR ${prevBid ? `(${arrow} ${diffBid >= 0 ? '+' : ''}${diffBid})` : ''}\n` +
            `• <b>Bank Sells (Ask):</b> ${quote.ask.toLocaleString()} KHR\n` +
            `• <b>Time:</b> ${new Date().toLocaleTimeString()}\n\n` +
            `🔗 <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://wingrate.app'}">Open WingRate Live Chart</a>`;

          await sendTelegramWebhookAlert({
            webhookUrl: alert.webhookUrl,
            botToken: alert.botToken,
            chatId: alert.chatId,
            text: alertMsg,
          });

          await db.update(telegramAlerts)
            .set({ lastAlertAt: new Date() })
            .where(eq(telegramAlerts.id, alert.id));
        }
      }
    }

    return NextResponse.json({ success: true, ...quote });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
