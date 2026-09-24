import { getStoreOrMemory, type AlertInput, type AlertRecord, type RateStore } from '@/lib/store';
import { isUsableSecret, normalizeChatId, sendTelegramWebhookAlert } from '@/lib/telegram';
import type { WingBankQuote } from '@/lib/scraper';

// Alert settings logic, shared by every storage backend.

/** The alert configured on the website (latest 'web' record). */
export async function getWebAlert(store: RateStore): Promise<AlertRecord | null> {
  const all = await store.listAlerts();
  return all.filter((a) => a.source === 'web').sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/**
 * Which bot token actually applies to an alert: its own stored token, falling
 * back to TELEGRAM_BOT_TOKEN. Returns null when neither is usable, so callers
 * can explain the problem instead of sending a masked placeholder to Telegram.
 */
export function effectiveBotToken(alert: Pick<AlertRecord, 'botToken'>): string | null {
  const own = alert.botToken;
  if (isUsableSecret(own)) return (own as string).trim();
  const env = process.env.TELEGRAM_BOT_TOKEN;
  return isUsableSecret(env) ? (env as string).trim() : null;
}

/** An alert can only deliver if it has a chat id (bot) or a webhook URL. */
export function hasDeliveryTarget(alert: Pick<AlertRecord, 'chatId' | 'webhookUrl'>): boolean {
  return Boolean(normalizeChatId(alert.chatId) || (alert.webhookUrl ?? '').trim());
}

/** Validate/clean the fields coming from the dashboard form. Throws on bad input. */
export function normalizeAlertInput(body: Record<string, unknown>): {
  webhookUrl: string | null;
  chatId: string | null;
  condition: AlertInput['condition'];
  targetRate: number | null;
  active: boolean;
} {
  const rawUrl = typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : '';
  const rawChat = typeof body.chatId === 'string' ? body.chatId.trim() : '';
  const rawCondition = typeof body.condition === 'string' ? body.condition.trim() : 'change';
  const rawTarget = body.targetRate;

  const condition = (['change', 'above', 'below'] as const).find((c) => c === rawCondition) ?? 'change';

  let targetRate: number | null = null;
  if (rawTarget !== null && rawTarget !== undefined && `${rawTarget}`.trim() !== '') {
    const n = Number(rawTarget);
    if (!Number.isFinite(n) || n <= 0) throw new Error('Target Rate must be a positive number (KHR).');
    targetRate = n;
  }
  if (condition !== 'change' && targetRate === null) {
    throw new Error(`Condition "${condition}" needs a Target Rate in KHR.`);
  }

  let webhookUrl: string | null = null;
  if (rawUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('Webhook URL is not a valid URL.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Webhook URL must start with http:// or https://');
    }
    webhookUrl = parsed.toString();
  }

  const chatId = rawChat || null;
  if (!webhookUrl && !chatId) {
    throw new Error('Enter a Telegram Chat ID (Bot mode) or a Webhook URL.');
  }

  return {
    webhookUrl,
    chatId,
    condition,
    targetRate,
    active: typeof body.active === 'boolean' ? body.active : true,
  };
}

export async function saveWebAlert(
  store: RateStore,
  input: Pick<AlertRecord, 'webhookUrl' | 'chatId' | 'condition' | 'targetRate' | 'active'> & { botToken?: string | null },
) {
  const existing = await getWebAlert(store);
  return store.saveAlert({
    ...(existing ?? {}),
    id: existing?.id,
    source: 'web',
    webhookUrl: input.webhookUrl,
    chatId: input.chatId,
    // undefined = keep the stored token (the UI only ever sees a masked value)
    botToken: input.botToken === undefined ? (existing?.botToken ?? null) : input.botToken,
    condition: input.condition,
    targetRate: input.targetRate,
    active: input.active,
    lastAlertAt: existing?.lastAlertAt ?? null,
  });
}

/** Telegram /alert and /stop. */
export async function setChatSubscription(store: RateStore, chatId: string, active: boolean) {
  const existing = (await store.listAlerts()).find((a) => a.source === 'bot' && a.chatId === chatId);
  if (!existing && !active) return null;
  return store.saveAlert({
    ...(existing ?? { webhookUrl: null, botToken: null, condition: 'change' as const, targetRate: null, lastAlertAt: null }),
    id: existing?.id,
    source: 'bot',
    chatId,
    active,
  });
}

export interface NotifyResult {
  /** Alerts whose condition matched and were attempted */
  matched: number;
  /** Alerts that Telegram/the webhook accepted */
  delivered: number;
  /** First delivery error, for logs and API responses */
  error?: string;
}

/**
 * Notify every active Telegram alert whose condition matches the new quote.
 * Works on every storage backend (Postgres, Turso, MongoDB, Upstash/Redis,
 * Vercel Blob, memory) because it goes through the RateStore abstraction.
 */
export async function notifyRateChange(prevBid: number | null, quote: WingBankQuote): Promise<NotifyResult> {
  const store = await getStoreOrMemory();
  const alerts = (await store.listAlerts()).filter((a) => a.active && hasDeliveryTarget(a));
  if (alerts.length === 0) return { matched: 0, delivered: 0 };

  const siteUrl = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL;
  const diff = prevBid !== null ? quote.bid - prevBid : 0;
  const arrow = diff > 0 ? '🟢 ↗' : diff < 0 ? '🔴 ↘' : '⚪ ➔';

  const text =
    `📢 <b>Wing Bank Exchange Rate Update</b>\n\n` +
    `• <b>Bank Buys (Bid):</b> ${quote.bid.toLocaleString()} KHR` +
    (prevBid !== null ? ` (${arrow} ${diff >= 0 ? '+' : ''}${diff})` : '') +
    `\n• <b>Bank Sells (Ask):</b> ${quote.ask.toLocaleString()} KHR\n` +
    `• <b>Time:</b> ${new Date().toUTCString()}` +
    (siteUrl ? `\n\n🔗 <a href="${siteUrl}">Open WingRate Live Chart</a>` : '');

  const results = await Promise.all(
    alerts.map(async (alert) => {
      const target = alert.targetRate;
      const shouldNotify =
        alert.condition === 'above'
          ? target !== null && quote.bid >= target
          : alert.condition === 'below'
            ? target !== null && quote.bid <= target
            : true; // 'change'
      if (!shouldNotify) return { matched: false, delivered: false, error: undefined as string | undefined };

      const res = await sendTelegramWebhookAlert({
        webhookUrl: alert.webhookUrl,
        botToken: alert.botToken,
        chatId: alert.chatId,
        text,
      });
      if (res.success) {
        await store.saveAlert({ ...alert, lastAlertAt: Date.now() }).catch(() => {});
      } else {
        console.error(`[alerts] delivery failed for chat ${alert.chatId ?? alert.webhookUrl}:`, res.error);
      }
      return { matched: true, delivered: res.success, error: res.error };
    }),
  );

  return {
    matched: results.filter((r) => r.matched).length,
    delivered: results.filter((r) => r.delivered).length,
    error: results.find((r) => r.error)?.error,
  };
}
