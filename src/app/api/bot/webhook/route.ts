import { NextRequest, NextResponse } from 'next/server';
import { getFreshQuote, fetchWingBankQuote } from '@/lib/scraper';
import { getStoreOrMemory } from '@/lib/store';
import { errMsg } from '@/lib/store/types';
import { effectiveBotToken, getWebAlert, setChatSubscription } from '@/lib/alerts';
import { sendTelegramMessage } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const HELP =
  `👋 <b>Wing Bank KHR/USD Tracker</b>\n\n` +
  `• /rate — current live exchange rate\n` +
  `• /alert — subscribe this chat to automatic rate change notifications\n` +
  `• /stop — unsubscribe from alerts\n` +
  `• /help — show this message`;

/** Replies go out with the token saved on the dashboard, else TELEGRAM_BOT_TOKEN. */
async function reply(chatId: string, text: string): Promise<void> {
  const token =
    (await getStoreOrMemory()
      .then((s) => getWebAlert(s))
      .catch(() => null)) ?? null;
  const res = await sendTelegramMessage(effectiveBotToken(token ?? { botToken: null }) ?? '', chatId, text);
  if (!res.success) console.error('[bot] reply failed:', res.error);
}

/** Cheapest available quote: 30s scraper cache → stored row → live scrape. */
async function currentQuote() {
  const cached = getFreshQuote();
  if (cached) return { quote: cached, source: 'live' as const };
  try {
    const store = await getStoreOrMemory();
    const row = await store.latest();
    if (row && Date.now() - row.c < 15 * 60_000) {
      return { quote: { bid: row.bid, ask: row.ask, rate: row.bid, fetchedAt: new Date(row.c).toISOString() }, source: 'stored' as const };
    }
  } catch {
    /* fall through to a live scrape */
  }
  return { quote: await fetchWingBankQuote(), source: 'live' as const };
}

/**
 * Telegram webhook endpoint (registered with BotFather's setWebhook, or by
 * install.sh step 5/7).
 *
 * Always answers 200: Telegram retries non-2xx deliveries and disables the
 * webhook after enough failures, so an internal error must never be returned
 * as a 5xx to Telegram itself.
 */
export async function POST(req: NextRequest) {
  try {
    // Optional hardening: if TELEGRAM_WEBHOOK_SECRET is set, require Telegram's
    // secret header (configure it with setWebhook&secret_token=…). Unset = open,
    // exactly as before.
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expected && req.headers.get('x-telegram-bot-api-secret-token') !== expected) {
      return NextResponse.json({ ok: true, ignored: 'bad secret' }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as
      | { message?: { chat?: { id?: number | string }; text?: string } ; channel_post?: { chat?: { id?: number | string }; text?: string } }
      | null;
    const update = body?.message ?? body?.channel_post;
    const chatIdRaw = update?.chat?.id;
    const text = (update?.text ?? '').trim();

    if (chatIdRaw === undefined || !text) {
      return NextResponse.json({ ok: true });
    }
    const chatId = String(chatIdRaw);
    const command = text.split(/\s+/)[0].toLowerCase().split('@')[0]; // "/rate@WingRateBot" → "/rate"

    if (command === '/start' || command === '/help') {
      await reply(chatId, `${HELP}\n\nYour Chat ID is: <code>${chatId}</code>`);
    } else if (command === '/rate') {
      try {
        const { quote } = await currentQuote();
        await reply(
          chatId,
          `🇰🇭 <b>Wing Bank Exchange Rate</b>\n\n` +
            `• <b>Bank Buys (Bid):</b> ${quote.bid.toLocaleString()} KHR\n` +
            `• <b>Bank Sells (Ask):</b> ${quote.ask.toLocaleString()} KHR`,
        );
      } catch {
        await reply(chatId, 'Sorry, I could not fetch the rate right now.');
      }
    } else if (command === '/alert') {
      const store = await getStoreOrMemory();
      await setChatSubscription(store, chatId, true);
      await reply(
        chatId,
        `🔔 <b>Alerts Activated!</b> You will be notified whenever the Wing Bank rate changes.` +
          (store.persistent ? '' : `\n\n<i>Note: storage is "${store.label}", so this subscription is lost if the server restarts.</i>`),
      );
    } else if (command === '/stop') {
      const store = await getStoreOrMemory();
      await setChatSubscription(store, chatId, false);
      await reply(chatId, `🔕 <b>Alerts Disabled.</b> Use /alert to re-enable anytime.`);
    } else {
      await reply(chatId, `Unknown command. ${HELP}`);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Telegram Bot Webhook Error:', errMsg(error));
    return NextResponse.json({ ok: false, error: errMsg(error) });
  }
}
