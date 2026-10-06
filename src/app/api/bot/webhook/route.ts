import { NextRequest, NextResponse } from 'next/server';
import { getFreshQuote, fetchWingBankQuote } from '@/lib/scraper';
import { getStoreOrMemory } from '@/lib/store';
import { errMsg } from '@/lib/store/types';
import { effectiveBotToken, getWebAlert, setChatSubscription } from '@/lib/alerts';
import { answerCallbackQuery, sendTelegramMessage } from '@/lib/telegram';
import {
  DATABASE_HELP,
  handleDatabaseCallback,
  handleDatabaseCommand,
  handleDatabaseValueMessage,
  looksLikeDatabaseValue,
} from '@/lib/bot-database';
import {
  EXPORT_HELP,
  handleExportImportCallback,
  handleExportImportCommand,
  handleExportImportFile,
  type BotDocumentRef,
  type BotFileMessage,
} from '@/lib/bot-export';

export const dynamic = 'force-dynamic';
/** Imports download and write a whole file — more than the default budget. */
export const maxDuration = 60;

const HELP =
  `👋 <b>Wing Bank KHR/USD Tracker</b>\n\n` +
  `• /rate — current live exchange rate\n` +
  `• /alert — subscribe this chat to automatic rate change notifications\n` +
  `• /stop — unsubscribe from alerts\n` +
  `• /database — 🗄 connect, switch, test or disconnect the app's database\n` +
  `• /link — 🔗 add a 2nd database as a live backup (mirror + automatic failover)\n` +
  `• /sync — 🧬 copy history & alerts between the linked databases\n` +
  `• /export — 📤 download the database to this chat as a file (JSON or CSV)\n` +
  `• /import — 📥 read an export file back into the database\n` +
  `• /help — show this message`;

type Chat = { id?: number | string };
type TgDocument = { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
type TgMessage = {
  message_id?: number;
  chat?: Chat;
  text?: string;
  caption?: string;
  document?: TgDocument;
  reply_to_message?: TgMessage;
};
type TgUpdate = {
  message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: { id: string; data?: string; message?: TgMessage; from?: { id?: number } };
};

/** The bits of a Telegram document the export/import flow needs. */
function documentRef(doc: TgDocument | undefined): BotDocumentRef | null {
  if (!doc?.file_id) return null;
  return {
    fileId: doc.file_id,
    fileName: doc.file_name ?? null,
    mimeType: doc.mime_type ?? null,
    fileSize: typeof doc.file_size === 'number' ? doc.file_size : null,
  };
}

/** The effective bot token: the one saved on the dashboard, else TELEGRAM_BOT_TOKEN. */
async function botToken(): Promise<string> {
  const stored = await getStoreOrMemory()
    .then((s) => getWebAlert(s))
    .catch(() => null);
  return effectiveBotToken(stored ?? { botToken: null }) ?? '';
}

/** Replies go out with the token saved on the dashboard, else TELEGRAM_BOT_TOKEN. */
async function reply(chatId: string, text: string, token?: string): Promise<void> {
  const res = await sendTelegramMessage(token ?? (await botToken()), chatId, text);
  if (!res.success) console.error('[bot] reply failed:', res.error);
}

/** Cheapest available quote: 10s scraper cache → stored row → live scrape. */
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
 * Handles the rate commands, alert subscriptions, the 🗄 database menu
 * (inline buttons + /database, /connect) and 📤📥 export/import (a file is sent
 * to the chat, or received from it). Always answers 200: Telegram retries
 * non-2xx deliveries and disables the webhook after enough failures, so an
 * internal error must never be returned as a 5xx to Telegram itself.
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

    const body = (await req.json().catch(() => null)) as TgUpdate | null;

    // ---- Inline button taps (🗄 database menu) ----
    const cq = body?.callback_query;
    if (cq) {
      const chatId = cq.message?.chat?.id !== undefined ? String(cq.message!.chat!.id) : null;
      const data = (cq.data ?? '').trim();
      const token = await botToken();
      if (chatId && cq.message?.message_id && data.startsWith('db:')) {
        await handleDatabaseCallback({ token, chatId }, cq.message.message_id, data, cq.id);
      } else if (chatId && cq.message?.message_id && data.startsWith('exp:')) {
        await handleExportImportCallback({ token, chatId }, cq.message.message_id, data, cq.id);
      } else {
        // Acknowledge anyway, otherwise the client keeps spinning on the button.
        await answerCallbackQuery(token, cq.id);
      }
      return NextResponse.json({ ok: true });
    }

    const update = body?.message ?? body?.channel_post;
    const chatIdRaw = update?.chat?.id;
    const text = (update?.text ?? '').trim();
    const caption = (update?.caption ?? '').trim();
    const document = documentRef(update?.document);
    const replyDocument = documentRef(update?.reply_to_message?.document);
    const fileMessage: BotFileMessage = {
      messageId: update?.message_id,
      document,
      replyDocument,
      replyMessageId: update?.reply_to_message?.message_id,
    };

    if (chatIdRaw === undefined || (!text && !caption && !document && !replyDocument)) {
      return NextResponse.json({ ok: true });
    }
    const chatId = String(chatIdRaw);
    const ctx = { token: await botToken(), chatId };
    const command = text.split(/\s+/)[0].toLowerCase().split('@')[0]; // "/rate@WingRateBot" → "/rate"

    // ---- 🗄 Database menu (owner only) ----
    // /database, /db, /storage, /connect …
    if (text && (await handleDatabaseCommand(ctx, text, update?.message_id))) return NextResponse.json({ ok: true });
    // A connection string pasted right after picking a type in the menu.
    if (!document && looksLikeDatabaseValue(text) && update?.message_id) {
      if (await handleDatabaseValueMessage(ctx, text, update.message_id)) return NextResponse.json({ ok: true });
    }

    // ---- 📤📥 Export & import (owner only) ----
    // /export, /import — also as the caption of a file message.
    if (await handleExportImportCommand(ctx, text || caption, fileMessage)) return NextResponse.json({ ok: true });
    // A .json/.csv sent to the bot on its own: read it and ask what to do.
    if (document && (await handleExportImportFile(ctx, fileMessage, { caption }))) return NextResponse.json({ ok: true });
    if (!text) return NextResponse.json({ ok: true });

    if (command === '/start' || command === '/help') {
      await reply(chatId, `${HELP}\n\n${DATABASE_HELP}\n\n${EXPORT_HELP}\n\nYour Chat ID is: <code>${chatId}</code>`, ctx.token);
    } else if (command === '/rate') {
      try {
        const { quote } = await currentQuote();
        await reply(
          chatId,
          `🇰🇭 <b>Wing Bank Exchange Rate</b>\n\n` +
            `• <b>Bank Buys (Bid):</b> ${quote.bid.toLocaleString()} KHR\n` +
            `• <b>Bank Sells (Ask):</b> ${quote.ask.toLocaleString()} KHR`,
          ctx.token,
        );
      } catch {
        await reply(chatId, 'Sorry, I could not fetch the rate right now.', ctx.token);
      }
    } else if (command === '/alert') {
      const store = await getStoreOrMemory();
      await setChatSubscription(store, chatId, true);
      await reply(
        chatId,
        `🔔 <b>Alerts Activated!</b> You will be notified whenever the Wing Bank rate changes.` +
          (store.persistent ? '' : `\n\n<i>Note: storage is "${store.label}", so this subscription is lost if the server restarts.</i>`),
        ctx.token,
      );
    } else if (command === '/stop') {
      const store = await getStoreOrMemory();
      await setChatSubscription(store, chatId, false);
      await reply(chatId, `🔕 <b>Alerts Disabled.</b> Use /alert to re-enable anytime.`, ctx.token);
    } else {
      await reply(chatId, `Unknown command. ${HELP}`, ctx.token);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Telegram Bot Webhook Error:', errMsg(error));
    return NextResponse.json({ ok: false, error: errMsg(error) });
  }
}
