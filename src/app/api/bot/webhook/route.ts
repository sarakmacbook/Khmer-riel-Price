import { NextRequest, NextResponse } from 'next/server';
import { fetchWingBankQuote } from '@/lib/scraper';
import { db } from '@/db';
import { telegramAlerts } from '@/db/schema';
import { eq } from 'drizzle-orm';

async function sendTelegramMessage(chatId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set');
    return;
  }

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
    }),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const message = body.message;

    if (!message || !message.text) {
      return NextResponse.json({ success: true });
    }

    const chatId = message.chat.id.toString();
    const text = message.text.trim();

    if (text === '/start') {
      await sendTelegramMessage(
        chatId,
        `👋 <b>Welcome to Wing Bank KHR/USD Tracker!</b>\n\n` +
        `• /rate - Get the current live exchange rate\n` +
        `• /alert - Subscribe to automatic rate change notifications\n` +
        `• /stop - Unsubscribe from alerts\n\n` +
        `Your Chat ID is: <code>${chatId}</code>`
      );
    } else if (text === '/rate') {
      try {
        const quote = await fetchWingBankQuote();
        await sendTelegramMessage(
          chatId,
          `🇰🇭 <b>Wing Bank Exchange Rate</b>\n\n` +
          `• <b>Bank Buys (Bid):</b> ${quote.bid.toLocaleString()} KHR\n` +
          `• <b>Bank Sells (Ask):</b> ${quote.ask.toLocaleString()} KHR`
        );
      } catch (error) {
        await sendTelegramMessage(chatId, 'Sorry, I could not fetch the rate right now.');
      }
    } else if (text === '/alert') {
      const existing = await db.query.telegramAlerts.findFirst({
        where: eq(telegramAlerts.chatId, chatId),
      });

      if (existing) {
        await db.update(telegramAlerts)
          .set({ active: true })
          .where(eq(telegramAlerts.id, existing.id));
      } else {
        await db.insert(telegramAlerts).values({
          chatId: chatId,
          condition: 'change',
          active: true,
        });
      }

      await sendTelegramMessage(
        chatId,
        `🔔 <b>Alerts Activated!</b> You will be notified whenever the Wing Bank rate updates.`
      );
    } else if (text === '/stop') {
      const existing = await db.query.telegramAlerts.findFirst({
        where: eq(telegramAlerts.chatId, chatId),
      });

      if (existing) {
        await db.update(telegramAlerts)
          .set({ active: false })
          .where(eq(telegramAlerts.id, existing.id));
      }

      await sendTelegramMessage(chatId, `🔕 <b>Alerts Disabled.</b> Use /alert to re-enable anytime.`);
    } else {
      await sendTelegramMessage(chatId, 'Unknown command. Use /rate to get the latest exchange rate or /alert to subscribe.');
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Telegram Bot Webhook Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
