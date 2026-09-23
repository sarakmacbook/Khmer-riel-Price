import { NextRequest, NextResponse } from 'next/server';
import { sendTelegramWebhookAlert } from '@/lib/telegram';
import { getLatestRate } from '@/lib/rates';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { webhookUrl, botToken, chatId } = await req.json();
    const latest = await getLatestRate().catch(() => null);

    const text =
      `🔔 <b>WingRate Test Alert</b>\n\n` +
      (latest
        ? `🇰🇭 <b>USD / KHR:</b>\n` +
          `• <b>Bank Buys (Bid):</b> ${latest.bid.toLocaleString()} KHR\n` +
          `• <b>Bank Sells (Ask):</b> ${latest.ask.toLocaleString()} KHR\n\n`
        : '') +
      `✅ <i>Telegram connection is working!</i>`;

    const result = await sendTelegramWebhookAlert({ webhookUrl, botToken, chatId, text });
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
