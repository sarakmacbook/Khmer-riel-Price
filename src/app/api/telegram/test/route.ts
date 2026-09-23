import { NextRequest, NextResponse } from 'next/server';
import { sendTelegramWebhookAlert } from '@/lib/telegram';
import { fetchWingBankQuote } from '@/lib/scraper';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { webhookUrl, botToken, chatId } = body;

    let quote;
    try {
      quote = await fetchWingBankQuote();
    } catch {
      quote = { rate: 4054, bid: 4054, ask: 4062 };
    }

    const now = new Date().toLocaleTimeString();
    const testMessage = `🔔 <b>WingRate Test Alert</b> (${now})\n\n` +
      `🇰🇭 <b>USD / KHR Exchange Rate:</b>\n` +
      `• <b>Bank Buys (Bid):</b> ${quote.bid.toLocaleString()} KHR\n` +
      `• <b>Bank Sells (Ask):</b> ${quote.ask.toLocaleString()} KHR\n\n` +
      `✅ <i>Telegram Webhook connection is working properly!</i>`;

    const result = await sendTelegramWebhookAlert({
      webhookUrl,
      botToken,
      chatId,
      text: testMessage,
    });

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || 'Internal error' }, { status: 500 });
  }
}
