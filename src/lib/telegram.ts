/**
 * Single place that talks to Telegram (or to a custom webhook relay).
 *
 * Every caller — the dashboard "Send Test Alert" button, the automatic rate
 * alerts and the bot webhook — goes through here so the error messages and the
 * credential handling stay identical everywhere.
 */

/** What the UI shows instead of a saved token. It is NEVER a usable credential. */
export const TOKEN_MASK = '••••••••';

/** Telegram Bot API base URL. Overridable for proxies / self-hosted relays / tests. */
export const TELEGRAM_API_BASE = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, '');

/** Telegram can hang; never let a slow call pin a serverless function. */
const SEND_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS) || 10_000;

/**
 * True only for a value that can actually be used as a secret.
 * Empty strings and UI masks ("••••••••") are rejected — sending the mask to
 * Telegram used to produce a confusing "Unauthorized" for the user.
 */
export function isUsableSecret(v: string | null | undefined): boolean {
  const s = (v ?? '').trim();
  if (!s) return false;
  if (/^[•*·.\-]+$/.test(s)) return false; // any bullet/asterisk/dot mask
  return true;
}

/** Normalise a chat id: numeric ids stay strings (Telegram accepts both). */
export function normalizeChatId(v: string | null | undefined): string {
  return (v ?? '').trim();
}

interface TelegramResponse {
  ok: boolean;
  status: number;
  /** Parsed JSON body when Telegram returned JSON, else null. */
  data: { ok?: boolean; error_code?: number; description?: string; result?: unknown } | null;
  /** Transport-level failure (DNS, timeout, TLS), when there was no HTTP response. */
  networkError?: string;
}

/** POST JSON to `url`, tolerating non-JSON bodies and hung connections. */
async function postJson(url: string, body: unknown): Promise<TelegramResponse> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: TelegramResponse['data'] = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null; // HTML error page from a proxy, empty body, …
    }
    return { ok: res.ok && data?.ok !== false, status: res.status, data };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return {
      ok: false,
      status: 0,
      data: null,
      networkError: timedOut ? `Telegram did not respond within ${SEND_TIMEOUT_MS / 1000}s` : reason || 'Network error',
    };
  }
}

/** Human-readable failure text for a Telegram/webhook response. */
function describeFailure(res: TelegramResponse, what: string): string {
  if (res.networkError) return `${what}: ${res.networkError}`;
  const code = res.data?.error_code ? ` ${res.data.error_code}` : ` ${res.status}`;
  const description = res.data?.description || (res.status === 0 ? 'no response' : `HTTP ${res.status}`);
  return `${what}${code}: ${description}`;
}

export interface SendTelegramMessageResult {
  success: boolean;
  error?: string;
}

/**
 * Send one message with an explicit bot token. This is the lowest-level call —
 * it never falls back to env vars, so callers always know which credential was used.
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<SendTelegramMessageResult> {
  const token = (botToken ?? '').trim();
  const chat = normalizeChatId(chatId);
  if (!isUsableSecret(token)) {
    return { success: false, error: 'No bot token — add TELEGRAM_BOT_TOKEN to your environment or enter one in the UI.' };
  }
  if (!chat) {
    return { success: false, error: 'No Telegram Chat ID — open the bell menu and fill in your Chat ID.' };
  }
  if (!text) return { success: false, error: 'Refusing to send an empty message.' };

  const res = await postJson(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    chat_id: chat,
    text,
    parse_mode: 'HTML',
  });

  return res.ok ? { success: true } : { success: false, error: describeFailure(res, 'Telegram API error') };
}

export interface SendTelegramAlertParams {
  webhookUrl?: string | null;
  botToken?: string | null;
  chatId?: string | null;
  text: string;
}

/**
 * Deliver an alert through whichever channel the alert is configured with:
 *   1. Bot Token + Chat ID  → direct Telegram Bot API (env token used as fallback)
 *   2. A Telegram Bot API URL used as a webhook
 *   3. Any other URL        → generic webhook (Make / Zapier / custom relay)
 */
export async function sendTelegramWebhookAlert(params: SendTelegramAlertParams): Promise<SendTelegramMessageResult> {
  const { webhookUrl, botToken, chatId, text } = params;

  // 1. Direct Telegram Bot API call via botToken + chatId.
  //    A masked token from the UI is ignored so the real credential (stored or
  //    from the environment) wins instead of being sent to Telegram verbatim.
  const token = isUsableSecret(botToken) ? (botToken as string).trim() : process.env.TELEGRAM_BOT_TOKEN;
  if (token && normalizeChatId(chatId)) {
    return sendTelegramMessage(token, chatId as string, text);
  }

  // 2. Custom Webhook URL
  const url = (webhookUrl ?? '').trim();
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { success: false, error: `Webhook URL is not valid: ${url}` };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { success: false, error: `Webhook URL must start with http:// or https:// (got ${parsed.protocol})` };
    }

    // A Telegram Bot API URL used as the webhook (…/bot<token>/sendMessage)
    if (parsed.hostname === 'api.telegram.org' || parsed.hostname.endsWith('.api.telegram.org')) {
      const body: Record<string, unknown> = { text, parse_mode: 'HTML' };
      const chat = normalizeChatId(chatId) || parsed.searchParams.get('chat_id') || '';
      if (chat) body.chat_id = chat;

      const res = await postJson(url, body);
      return res.ok ? { success: true } : { success: false, error: describeFailure(res, 'Telegram webhook error') };
    }

    // Generic webhook (supports Zapier, Make, custom relay)
    const res = await postJson(url, {
      text,
      message: text,
      content: text,
      chat_id: normalizeChatId(chatId) || null,
      timestamp: new Date().toISOString(),
    });
    return res.ok ? { success: true } : { success: false, error: describeFailure(res, 'Webhook error') };
  }

  return {
    success: false,
    error:
      'Nothing to send to — provide a Telegram Chat ID (+ bot token or TELEGRAM_BOT_TOKEN env var) or a Webhook URL.',
  };
}
