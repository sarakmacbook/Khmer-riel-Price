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

/** Uploading/downloading files is slower than a message — its own, longer budget. */
const FILE_TIMEOUT_MS = Number(process.env.TELEGRAM_FILE_TIMEOUT_MS) || 60_000;

/** Telegram refuses `getFile` downloads above this size (bot API limit). */
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

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

/** Read a Telegram reply, tolerating non-JSON bodies (proxy error pages, empty bodies). */
async function readResponse(res: Response): Promise<TelegramResponse> {
  const text = await res.text();
  let data: TelegramResponse['data'] = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { ok: res.ok && data?.ok !== false, status: res.status, data };
}

/** Transport-level failure (DNS, timeout, TLS) reported like an HTTP response. */
function transportFailure(err: unknown, timeoutMs: number): TelegramResponse {
  const reason = err instanceof Error ? err.message : String(err);
  const timedOut = err instanceof Error && err.name === 'TimeoutError';
  return {
    ok: false,
    status: 0,
    data: null,
    networkError: timedOut ? `Telegram did not respond within ${timeoutMs / 1000}s` : reason || 'Network error',
  };
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
    return await readResponse(res);
  } catch (err) {
    return transportFailure(err, SEND_TIMEOUT_MS);
  }
}

/** POST a multipart/form-data body — used to upload export files. */
async function postForm(url: string, form: FormData): Promise<TelegramResponse> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });
    return await readResponse(res);
  } catch (err) {
    return transportFailure(err, FILE_TIMEOUT_MS);
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
  /** Telegram message id (sendMessage only) — kept so menus can be edited in place. */
  messageId?: number;
}

/** One button of an inline keyboard. */
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

/** Rows of buttons (Telegram's `reply_markup.inline_keyboard`). */
export type InlineKeyboard = InlineKeyboardButton[][];

export interface SendMessageOptions {
  keyboard?: InlineKeyboard;
  /** Hide the link preview card for messages containing URLs (default true). */
  linkPreview?: boolean;
  /** Send silently (no notification sound). */
  silent?: boolean;
}

const replyMarkup = (keyboard?: InlineKeyboard) => (keyboard ? { inline_keyboard: keyboard } : undefined);

/**
 * Send one message with an explicit bot token. This is the lowest-level call —
 * it never falls back to env vars, so callers always know which credential was used.
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  options: SendMessageOptions = {},
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
    link_preview_options: { is_disabled: options.linkPreview !== false },
    ...(options.silent ? { disable_notification: true } : {}),
    ...(options.keyboard ? { reply_markup: replyMarkup(options.keyboard) } : {}),
  });

  if (!res.ok) return { success: false, error: describeFailure(res, 'Telegram API error') };
  const messageId = (res.data?.result as { message_id?: number } | undefined)?.message_id;
  return { success: true, messageId };
}

/**
 * Edit a previous message (menus are edited in place instead of spamming the chat).
 * "message is not modified" means the user tapped the same button twice — that is a success.
 */
export async function editTelegramMessage(
  botToken: string,
  chatId: string,
  messageId: number,
  text: string,
  options: SendMessageOptions = {},
): Promise<SendTelegramMessageResult> {
  const token = (botToken ?? '').trim();
  if (!isUsableSecret(token)) return { success: false, error: 'No bot token available.' };

  const res = await postJson(`${TELEGRAM_API_BASE}/bot${token}/editMessageText`, {
    chat_id: normalizeChatId(chatId),
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: options.linkPreview !== false },
    ...(options.keyboard ? { reply_markup: replyMarkup(options.keyboard) } : {}),
  });

  if (res.ok) return { success: true, messageId };
  const description = res.data?.description ?? '';
  if (/message is not modified/i.test(description)) return { success: true, messageId };
  return { success: false, error: describeFailure(res, 'Telegram API error') };
}

/** Remove a message (used to scrub credentials the user pasted into the chat). */
export async function deleteTelegramMessage(botToken: string, chatId: string, messageId: number): Promise<SendTelegramMessageResult> {
  const token = (botToken ?? '').trim();
  if (!isUsableSecret(token)) return { success: false, error: 'No bot token available.' };
  const res = await postJson(`${TELEGRAM_API_BASE}/bot${token}/deleteMessage`, {
    chat_id: normalizeChatId(chatId),
    message_id: messageId,
  });
  return res.ok ? { success: true } : { success: false, error: describeFailure(res, 'Telegram API error') };
}

/**
 * Acknowledge a button tap. Without this the client shows a loading spinner on
 * the button for ~10s, and with `show_alert` the text opens as a dialog.
 */
export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  options: { text?: string; showAlert?: boolean } = {},
): Promise<SendTelegramMessageResult> {
  const token = (botToken ?? '').trim();
  if (!isUsableSecret(token) || !callbackQueryId) return { success: false, error: 'No bot token available.' };
  const res = await postJson(`${TELEGRAM_API_BASE}/bot${token}/answerCallbackQuery`, {
    callback_query_id: callbackQueryId,
    ...(options.text ? { text: options.text.slice(0, 200) } : {}),
    ...(options.showAlert ? { show_alert: true } : {}),
  });
  return res.ok ? { success: true } : { success: false, error: describeFailure(res, 'Telegram API error') };
}

// ---------------------------------------------------------------------------
// Files (export / import)
// ---------------------------------------------------------------------------

/** A document the bot sends to a chat. */
export interface OutgoingDocument {
  filename: string;
  /** UTF-8 text (encoded here) or raw bytes. */
  content: string | Uint8Array;
  mimeType?: string;
}

export interface SendDocumentOptions {
  caption?: string;
  keyboard?: InlineKeyboard;
  /** Send silently (no notification sound). */
  silent?: boolean;
}

/** Telegram caps a document caption at 1024 characters. */
const CAPTION_LIMIT = 1024;
const trimCaption = (caption: string) => (caption.length <= CAPTION_LIMIT ? caption : `${caption.slice(0, CAPTION_LIMIT - 1)}…`);

/**
 * Upload a file with `sendDocument` (multipart/form-data).
 *
 * If Telegram rejects the caption's HTML entities (a database label can contain
 * anything), the caption is retried as plain text instead of losing the export.
 */
export async function sendTelegramDocument(
  botToken: string,
  chatId: string,
  doc: OutgoingDocument,
  options: SendDocumentOptions = {},
): Promise<SendTelegramMessageResult> {
  const token = (botToken ?? '').trim();
  const chat = normalizeChatId(chatId);
  if (!isUsableSecret(token)) {
    return { success: false, error: 'No bot token — add TELEGRAM_BOT_TOKEN to your environment or enter one in the UI.' };
  }
  if (!chat) return { success: false, error: 'No Telegram Chat ID — open the bell menu and fill in your Chat ID.' };
  if (!doc?.filename) return { success: false, error: 'Refusing to send a file without a name.' };

  // Copied into a plain ArrayBuffer-backed view so it can be uploaded as-is.
  const bytes =
    typeof doc.content === 'string' ? new TextEncoder().encode(doc.content) : Uint8Array.from(doc.content);
  if (bytes.byteLength === 0) return { success: false, error: 'Refusing to send an empty file.' };

  const build = (caption: string | null, html: boolean) => {
    const form = new FormData();
    form.append('chat_id', chat);
    form.append('document', new Blob([bytes], { type: doc.mimeType ?? 'application/octet-stream' }), doc.filename);
    if (caption) {
      form.append('caption', trimCaption(caption));
      if (html) form.append('parse_mode', 'HTML');
    }
    if (options.silent) form.append('disable_notification', 'true');
    if (options.keyboard) form.append('reply_markup', JSON.stringify(replyMarkup(options.keyboard)));
    return form;
  };

  let res = await postForm(`${TELEGRAM_API_BASE}/bot${token}/sendDocument`, build(options.caption ?? null, true));
  const description = res.data?.description ?? '';
  if (!res.ok && options.caption && /parse|entit/i.test(description)) {
    // The caption had broken markup — the file itself is fine, send it as text.
    res = await postForm(
      `${TELEGRAM_API_BASE}/bot${token}/sendDocument`,
      build(options.caption.replace(/<[^>]+>/g, ''), false),
    );
  }
  if (!res.ok) return { success: false, error: describeFailure(res, 'Telegram API error') };
  const messageId = (res.data?.result as { message_id?: number } | undefined)?.message_id;
  return { success: true, messageId };
}

/** Where a document lives on Telegram's file server, as `getFile` reports it. */
export interface TelegramFileInfo {
  fileId: string;
  fileUniqueId: string | null;
  /** Size in bytes, when Telegram reports one. */
  fileSize: number | null;
  filePath: string;
}

export interface TelegramDownload extends SendTelegramMessageResult {
  bytes?: Uint8Array;
  info?: TelegramFileInfo;
}

/**
 * Download a document a user sent to the bot (two steps: `getFile`, then the
 * file server). Refuses files above `maxBytes` — Telegram itself caps bot
 * downloads at 20 MB.
 */
export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  options: { maxBytes?: number } = {},
): Promise<TelegramDownload> {
  const token = (botToken ?? '').trim();
  if (!isUsableSecret(token)) return { success: false, error: 'No bot token available.' };
  if (!fileId) return { success: false, error: 'No file id in this message.' };
  const maxBytes = Math.max(1, options.maxBytes ?? TELEGRAM_DOWNLOAD_LIMIT);

  const meta = await postJson(`${TELEGRAM_API_BASE}/bot${token}/getFile`, { file_id: fileId });
  if (!meta.ok) return { success: false, error: describeFailure(meta, 'Telegram API error') };

  const result = meta.data?.result as { file_id?: string; file_unique_id?: string; file_size?: number; file_path?: string } | undefined;
  const filePath = result?.file_path;
  if (!filePath) return { success: false, error: 'Telegram did not return a download path for this file.' };

  const info: TelegramFileInfo = {
    fileId: result?.file_id ?? fileId,
    fileUniqueId: result?.file_unique_id ?? null,
    fileSize: typeof result?.file_size === 'number' ? result.file_size : null,
    filePath,
  };
  if (info.fileSize !== null && info.fileSize > maxBytes) {
    return { success: false, error: `The file is ${humanBytes(info.fileSize)} — larger than the ${humanBytes(maxBytes)} import limit.`, info };
  }

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`, {
      signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await readResponse(res);
      return { success: false, error: describeFailure(body, 'Telegram file download error'), info };
    }
    const announced = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(announced) && announced > maxBytes) {
      return { success: false, error: `The file is ${humanBytes(announced)} — larger than the ${humanBytes(maxBytes)} import limit.`, info };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      return { success: false, error: `The file is ${humanBytes(bytes.byteLength)} — larger than the ${humanBytes(maxBytes)} import limit.`, info };
    }
    return { success: true, bytes, info };
  } catch (err) {
    const failed = transportFailure(err, FILE_TIMEOUT_MS);
    return { success: false, error: describeFailure(failed, 'Telegram file download error'), info };
  }
}

/** `128 KB` / `3.4 MB` — file sizes as they appear in the chat. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
