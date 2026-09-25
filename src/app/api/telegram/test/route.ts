import { NextRequest, NextResponse } from 'next/server';
import { sendTelegramWebhookAlert, isUsableSecret, normalizeChatId } from '@/lib/telegram';
import { getStoreOrMemory } from '@/lib/store';
import { effectiveBotToken, getWebAlert, renderAlertMessage } from '@/lib/alerts';
import { fetchWingBankQuote } from '@/lib/scraper';
import { getLatestTick } from '@/lib/history-store';

export const dynamic = 'force-dynamic';

/**
 * "Send Test Alert" from the dashboard.
 *
 * Values typed in the form win; anything blank (or the "••••••••" mask the UI
 * shows for a saved token) falls back to the stored alert and then to
 * TELEGRAM_BOT_TOKEN. Previously the mask was posted straight to
 * api.telegram.org, so the test always failed with "Unauthorized" as soon as
 * the modal was reopened after saving.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const stored = await getStoreOrMemory()
      .then((s) => getWebAlert(s))
      .catch(() => null);

    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const bodyUrl = str(body.webhookUrl);
    const bodyChat = normalizeChatId(str(body.chatId));
    const bodyToken = str(body.botToken);
    // The dashboard tells us which channel it is testing. Without it (curl,
    // older clients) we merge the form with whatever is stored.
    const mode = body.mode === 'webhook' || body.mode === 'bot' ? body.mode : 'auto';

    let webhookUrl: string | null;
    let chatId: string | null;
    let token: string | null;
    let tokenSource: string;

    if (mode === 'webhook') {
      // Webhook channel only — never silently fall back to the saved bot token.
      webhookUrl = bodyUrl || stored?.webhookUrl || null;
      chatId = bodyChat || stored?.chatId || null;
      token = null;
      tokenSource = 'the webhook URL';
      if (!webhookUrl) {
        return NextResponse.json({ success: false, error: 'Enter a Webhook URL before sending a test alert.' }, { status: 400 });
      }
    } else {
      // Bot channel (or auto): form → stored alert → TELEGRAM_BOT_TOKEN.
      webhookUrl = mode === 'bot' ? null : bodyUrl || stored?.webhookUrl || null;
      chatId = bodyChat || stored?.chatId || null;
      if (isUsableSecret(bodyToken)) {
        token = bodyToken;
        tokenSource = 'bot token from the form';
      } else {
        token = effectiveBotToken(stored ?? { botToken: null });
        tokenSource = token
          ? isUsableSecret(stored?.botToken)
            ? 'bot token saved with this alert'
            : 'TELEGRAM_BOT_TOKEN from the environment'
          : 'none';
      }
      if (!normalizeChatId(chatId) && !webhookUrl) {
        return NextResponse.json(
          { success: false, error: 'Enter a Telegram Chat ID (or a Webhook URL) before sending a test alert.' },
          { status: 400 },
        );
      }
    }

    let quote;
    try {
      quote = await fetchWingBankQuote();
    } catch {
      quote = { rate: 4054, bid: 4054, ask: 4062, fetchedAt: new Date().toISOString() };
    }

    // Preview exactly what the user will receive: their custom template (form
    // value wins, then the stored one) or the default layout, with live values.
    const formCustomMessage = str(body.customMessage);
    const prevTick = await getLatestTick().catch(() => null);
    const prev = prevTick ? { bid: Number(prevTick.bid), ask: Number(prevTick.ask) } : null;

    const now = new Date().toLocaleTimeString();
    const testMessage =
      `🔔 <b>WingRate Test Alert</b> (${now})\n\n` +
      `✅ <i>Connection OK — this is a preview of your alert message:</i>\n\n` +
      renderAlertMessage({ prev, quote, customMessage: formCustomMessage || stored?.customMessage || null });

    const result = await sendTelegramWebhookAlert({
      webhookUrl,
      botToken: token,
      chatId,
      text: testMessage,
    });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error, used: { tokenSource, chatId: chatId ?? undefined, webhookUrl: webhookUrl ?? undefined } },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, used: { tokenSource } });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
