import { getStore, type AlertRecord, type RateStore } from '@/lib/store';
import { sendTelegramWebhookAlert } from '@/lib/telegram';
import type { WingBankQuote } from '@/lib/scraper';

// Alert settings logic, shared by every storage backend.

/** The alert configured on the website (latest 'web' record). */
export async function getWebAlert(store: RateStore): Promise<AlertRecord | null> {
  const all = await store.listAlerts();
  return all.filter((a) => a.source === 'web').sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
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
  if (!existing && !active) return;
  await store.saveAlert({
    ...(existing ?? { webhookUrl: null, botToken: null, condition: 'change' as const, targetRate: null, lastAlertAt: null }),
    id: existing?.id,
    source: 'bot',
    chatId,
    active,
  });
}

/** Notify every active Telegram alert whose condition matches the new quote. */
export async function notifyRateChange(prevBid: number | null, quote: WingBankQuote) {
  const store = await getStore();
  const alerts = (await store.listAlerts()).filter((a) => a.active);
  if (alerts.length === 0) return;

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

  await Promise.allSettled(
    alerts.map(async (alert) => {
      const target = alert.targetRate;
      const shouldNotify =
        alert.condition === 'above'
          ? target !== null && quote.bid >= target
          : alert.condition === 'below'
            ? target !== null && quote.bid <= target
            : true; // 'change'
      if (!shouldNotify) return;

      const res = await sendTelegramWebhookAlert({
        webhookUrl: alert.webhookUrl,
        botToken: alert.botToken,
        chatId: alert.chatId,
        text,
      });
      if (res.success) await store.saveAlert({ ...alert, lastAlertAt: Date.now() });
    }),
  );
}
