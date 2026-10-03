/**
 * 🗄 Database menu for the Telegram bot.
 *
 * Lets the bot owner connect the app to ANY database after deployment
 * (Postgres, Turso/libSQL, MongoDB, Upstash REST, Redis TCP, Vercel Blob),
 * switch to another one later, test the connection, or disconnect and fall back
 * to the environment database / in-memory store — without editing env vars or
 * redeploying.
 *
 * Design notes:
 *  • Nothing is switched before the new database has answered a real probe, so
 *    a typo can never take a working deployment down.
 *  • Only one chat may manage the database: TELEGRAM_ADMIN_CHAT_ID (or the
 *    dashboard's chat id) when set, otherwise the first chat that runs
 *    /database claims ownership.
 *  • Credentials are never echoed back in full (passwords/tokens are masked)
 *    and the user's message containing them is deleted when Telegram allows it.
 */

import {
  KIND_META,
  detectKindFromUrl,
  kindMeta,
  maskToken,
  maskUrl,
  redactError,
  type DbSpec,
} from './store/env';
import { storeStatus } from './store';
import {
  claimAdminChatId,
  getAdminChatId,
  normalizeKind,
  specFromInput,
} from './db-config';
import { connectDatabase, disconnectDatabase, testActiveDatabase } from './db-actions';
import {
  answerCallbackQuery,
  deleteTelegramMessage,
  editTelegramMessage,
  sendTelegramMessage,
  type InlineKeyboard,
} from './telegram';
import type { StoreKind } from './store/types';

export const DATABASE_COMMANDS = ['/database', '/db', '/storage'];
export const CONNECT_COMMAND = '/connect';

const PENDING_TTL_MS = 15 * 60_000;

interface Pending {
  kind: StoreKind;
  at: number;
}

const g = globalThis as typeof globalThis & {
  /** Chats that tapped a database type and are expected to paste a value next. */
  __wingrateBotPending?: Map<string, Pending>;
};
const pending = () => (g.__wingrateBotPending ??= new Map<string, Pending>());

const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s: string) => s.replace(/[&<>]/g, (c) => HTML_ESCAPE[c]);

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Only the owner may change the database. Precedence:
 *   1. TELEGRAM_ADMIN_CHAT_ID (etc.) when set — the strict mode;
 *   2. the chat id saved in the dashboard's Telegram alert;
 *   3. otherwise the first chat that asks claims ownership (persisted with the config).
 */
export async function authorizeDatabaseChat(chatId: string): Promise<{ ok: boolean; claimed: boolean; admin: string | null }> {
  const admin = await getAdminChatId();
  if (admin) return { ok: admin === chatId, claimed: false, admin };
  const claimed = await claimAdminChatId(chatId);
  return { ok: true, claimed, admin: chatId };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Compact "rows / first → last" summary that works for every backend's stats(). */
function formatStats(stats: Record<string, unknown> | null): string | null {
  if (!stats) return null;
  const parts: string[] = [];
  const num = (v: unknown) => (typeof v === 'number' ? v.toLocaleString() : null);
  const rows = num(stats.rows) ?? num(stats.count);
  if (rows) parts.push(`${rows} rows`);
  if (typeof stats.days === 'number') parts.push(`${stats.days} daily snapshots`);
  const first = stats.first ? new Date(stats.first as string).toISOString().slice(0, 10) : null;
  const last = stats.last ? new Date(stats.last as string).toISOString().slice(0, 10) : null;
  if (first) parts.push(`first ${first}`);
  if (last) parts.push(`last ${last}`);
  if (typeof stats.database === 'string') parts.push(`db ${esc(stats.database)}`);
  if (typeof stats.note === 'string') parts.push(esc(String(stats.note)));
  return parts.length ? parts.join(' · ') : null;
}

/** The status card shown by /database and the ♻️ button. */
export async function databaseMenuText(): Promise<string> {
  const s = await storeStatus();
  const choice = s.choice;

  const lines = ['🗄 <b>Database manager</b>', ''];

  const activeIcon = s.activeKind === 'memory' ? '🟡' : '🟢';
  const configured =
    choice.mode === 'custom'
      ? `${kindMeta(choice.spec.kind).emoji} <b>${esc(s.configuredLabel)}</b>\n<code>${esc(maskUrl(choice.spec.url))}</code>` +
        (choice.spec.token ? `\ntoken <code>${esc(maskToken(choice.spec.token))}</code>` : '')
      : `${kindMeta(s.configuredKind).emoji} <b>${esc(s.configuredLabel)}</b>`;

  lines.push(`${activeIcon} <b>Active:</b> ${kindMeta(s.activeKind).emoji} ${esc(s.activeLabel)}`);
  if (choice.mode === 'custom') lines.push(configured);
  lines.push(`📡 <b>Source:</b> ${esc(s.source)}`);

  if (s.reachable) {
    lines.push(`✅ <b>Reachable:</b> yes (${s.ms} ms)`);
    const stats = formatStats(s.stats);
    if (stats) lines.push(`📊 ${stats}`);
  } else {
    lines.push(`❌ <b>Reachable:</b> no\n<code>${esc(redactError(s.error ?? 'unknown error'))}</code>`);
  }

  if (s.configPath) lines.push(`💾 Saved to <code>${esc(s.configPath)}</code>`);
  if (s.configWarning) lines.push(`⚠️ ${esc(s.configWarning)}`);

  const detected = s.detected.filter((d) => d.kind !== 'memory');
  if (detected.length) {
    lines.push('');
    lines.push(`🔍 From environment: ${detected.map((d) => `${kindMeta(d.kind).emoji} ${esc(d.label)}`).join(', ')}`);
  }

  lines.push('', 'Connect a database from anywhere — the switch is live, no redeploy needed.');
  return lines.join('\n');
}

export function databaseMenuKeyboard(): InlineKeyboard {
  return [
    [{ text: '🔌 Connect database', callback_data: 'db:connect' }, { text: '🧪 Test connection', callback_data: 'db:test' }],
    [{ text: '♻️ Refresh status', callback_data: 'db:menu' }, { text: '⏏️ Disconnect', callback_data: 'db:off' }],
    [{ text: '✖️ Close', callback_data: 'db:close' }],
  ];
}

function kindKeyboard(): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < KIND_META.length; i += 2) {
    rows.push(
      KIND_META.slice(i, i + 2).map((m) => ({ text: `${m.emoji} ${m.name}`, callback_data: `db:kind:${m.kind}` })),
    );
  }
  rows.push([{ text: '⬅️ Back', callback_data: 'db:menu' }]);
  return rows;
}

function backKeyboard(extra: InlineKeyboard[number] = []): InlineKeyboard {
  return extra.length ? [extra, [{ text: '⬅️ Back', callback_data: 'db:menu' }]] : [[{ text: '⬅️ Back', callback_data: 'db:menu' }]];
}

/** Instructions for one backend, including the exact command to copy. */
function kindInstructions(kind: StoreKind): string {
  const m = kindMeta(kind);
  const exampleArgs = m.tokenLabel ? `<connection-string> <${m.tokenLabel.toLowerCase().replace(/\s+/g, '-')}>` : '<connection-string>';
  return (
    `${m.emoji} <b>${esc(m.name)}</b>\n\n${esc(m.hint)}\n\n` +
    `Send the connection string in one message:\n` +
    `<code>${CONNECT_COMMAND} ${m.kind} ${exampleArgs}</code>\n\n` +
    `Example:\n<code>${CONNECT_COMMAND} ${m.kind} ${esc(m.example)}</code>` +
    (m.tokenLabel ? `\n(token: ${esc(m.tokenLabel)})` : '') +
    `\n\n<i>You can also just paste the value(s) here — it is detected automatically.</i>`
  );
}

// ---------------------------------------------------------------------------
// Sending / editing
// ---------------------------------------------------------------------------

export interface BotContext {
  token: string;
  chatId: string;
}

async function present(
  ctx: BotContext,
  text: string,
  keyboard: InlineKeyboard | undefined,
  messageId?: number,
): Promise<void> {
  if (messageId) {
    const edited = await editTelegramMessage(ctx.token, ctx.chatId, messageId, text, { keyboard });
    if (edited.success) return;
  }
  const sent = await sendTelegramMessage(ctx.token, ctx.chatId, text, { keyboard });
  if (!sent.success) console.error('[bot-db] reply failed:', sent.error);
}

/** Open the database menu (new message, or edit an existing one). */
export async function openDatabaseMenu(ctx: BotContext, messageId?: number): Promise<void> {
  await present(ctx, await databaseMenuText(), databaseMenuKeyboard(), messageId);
}

// ---------------------------------------------------------------------------
// Connect flow
// ---------------------------------------------------------------------------

/** Remember which backend the chat asked for so a pasted value can be used directly. */
function setPending(chatId: string, kind: StoreKind): void {
  pending().set(chatId, { kind, at: Date.now() });
}

function takePending(chatId: string): Pending | null {
  const p = pending().get(chatId);
  if (!p) return null;
  pending().delete(chatId);
  return Date.now() - p.at > PENDING_TTL_MS ? null : p;
}

/** Does this message look like something the user would send to connect a database? */
export function looksLikeDatabaseValue(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith('/')) return false;
  const tokens = t.split(/\s+/);
  if (detectKindFromUrl(tokens[0])) return true;
  // "https://… <token>" — the Upstash REST pair (the only backend whose URL is
  // generic https). Still gated by the pending-type window before connecting.
  return tokens.length === 2 && /^https?:\/\//i.test(tokens[0]);
}

/** Does the text hold credentials that should not stay in the chat history? */
function hasCredentials(text: string): boolean {
  return (
    /:\/\/[^/\s]*:[^@\s]+@/.test(text) || // user:password@host
    /vercel_blob_rw_/.test(text) || // Vercel Blob token
    /(^|\s)[A-Za-z0-9._-]{24,}(\s|$)/.test(text) // long opaque token (Turso/Upstash)
  );
}

/** Probe + switch, then report the outcome (and scrub the credentials message). */
async function runConnect(
  ctx: BotContext,
  opts: { kind?: StoreKind | null; url: string; token?: string | null; sourceMessageId?: number },
): Promise<void> {
  let spec: DbSpec;
  try {
    spec = specFromInput({ kind: opts.kind ?? null, url: opts.url, token: opts.token ?? null });
  } catch (e) {
    await present(ctx, `⚠️ ${esc(redactError(e))}\n\n${kindInstructions(opts.kind ?? 'postgres')}`, kindKeyboard());
    return;
  }

  const meta = kindMeta(spec.kind);
  const progress = await sendTelegramMessage(
    ctx.token,
    ctx.chatId,
    `🔎 Testing ${meta.emoji} <b>${esc(meta.name)}</b>…\n<code>${esc(maskUrl(spec.url))}</code>`,
    { silent: true },
  );

  const outcome = await connectDatabase(spec, { by: ctx.chatId, source: 'telegram' });

  // Never leave the pasted credentials sitting in the chat if we can remove them.
  let scrubbed: 'deleted' | 'failed' | null = null;
  if (opts.sourceMessageId && hasCredentials(opts.url)) {
    const del = await deleteTelegramMessage(ctx.token, ctx.chatId, opts.sourceMessageId);
    scrubbed = del.success ? 'deleted' : 'failed';
  }

  const head = outcome.ok
    ? `✅ <b>Connected</b>\n\n${meta.emoji} <b>${esc(outcome.label)}</b>\n<code>${esc(maskUrl(spec.url))}</code>` +
      (spec.token ? `\ntoken <code>${esc(maskToken(spec.token))}</code>` : '')
    : `❌ <b>Connection failed</b>\n\n${meta.emoji} ${esc(meta.name)}\n<code>${esc(maskUrl(spec.url))}</code>\n\n<code>${esc(redactError(outcome.error ?? 'unknown error'))}</code>`;

  const lines = [head];
  if (outcome.ok) {
    lines.push(`⚡ Responded in ${outcome.ms} ms`);
    const stats = formatStats((outcome.stats ?? null) as Record<string, unknown> | null);
    if (stats) lines.push(`📊 ${stats}`);
    lines.push('');
    lines.push(
      outcome.save.persisted
        ? `💾 Saved${outcome.save.path ? ` to <code>${esc(outcome.save.path)}</code>` : ''}`
        : '⚠️ Not saved to disk — this connection lasts until the server restarts.',
    );
    if (outcome.save.warning) lines.push(`⚠️ ${esc(outcome.save.warning)}`);
    lines.push('', 'The dashboard, chart, history and Telegram alerts now use this database.');
  } else {
    lines.push('', 'Nothing changed — still using the previous database.');
    lines.push('', `Check the value and try again: <code>${CONNECT_COMMAND} ${spec.kind} ${esc(kindMeta(spec.kind).example)}</code>`);
  }
  if (scrubbed === 'deleted') lines.push('', '🧹 Your message with the credentials was deleted.');
  if (scrubbed === 'failed') lines.push('', '🧹 Tip: delete the message containing your credentials yourself.');

  const text = lines.join('\n');
  const keyboard: InlineKeyboard = outcome.ok
    ? [[{ text: '🗄 Database menu', callback_data: 'db:menu' }, { text: '✖️ Close', callback_data: 'db:close' }]]
    : backKeyboard([{ text: '🗄 Database menu', callback_data: 'db:menu' }]);

  if (progress.success && progress.messageId) {
    const edited = await editTelegramMessage(ctx.token, ctx.chatId, progress.messageId, text, { keyboard });
    if (edited.success) return;
  }
  await present(ctx, text, keyboard);
}

/**
 * `/connect <type> <connection-string> [token]` — also accepts the URL alone
 * (`/connect postgresql://…`) and `/database connect …`.
 */
async function connectFromArgs(ctx: BotContext, args: string[], userMessageId?: number): Promise<void> {
  if (args.length === 0) {
    await present(
      ctx,
      '🔌 <b>Connect a database</b>\n\nPick the type — then send the connection string as the next message, or use <code>/connect &lt;type&gt; &lt;url&gt;</code>.',
      kindKeyboard(),
    );
    return;
  }

  const explicit = normalizeKind(args[0]);
  const url = explicit ? args[1] : args[0];
  const token = explicit ? args[2] : args[1];

  if (!url) {
    await present(ctx, kindInstructions(explicit!), kindKeyboard());
    return;
  }
  // userMessageId is the user's own message — deleted after connecting when it holds credentials.
  await runConnect(ctx, { kind: explicit, url, token: token ?? null, sourceMessageId: userMessageId });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Handle /database, /db, /storage and /connect. Returns false when not ours. */
export async function handleDatabaseCommand(ctx: BotContext, text: string, userMessageId?: number): Promise<boolean> {
  const tokens = text.trim().split(/\s+/);
  const cmd = tokens[0].toLowerCase().split('@')[0];
  const isMenu = DATABASE_COMMANDS.includes(cmd);
  if (!isMenu && cmd !== CONNECT_COMMAND) return false;

  const auth = await authorizeDatabaseChat(ctx.chatId);
  if (!auth.ok) {
    await sendTelegramMessage(
      ctx.token,
      ctx.chatId,
      `🔒 Only the bot owner can manage the database. You are chat <code>${esc(ctx.chatId)}</code>; ` +
        `the configured owner is <code>${esc(auth.admin ?? 'unknown')}</code>.`,
    );
    return true;
  }

  if (cmd === CONNECT_COMMAND) {
    await connectFromArgs(ctx, tokens.slice(1), userMessageId);
    return true;
  }

  const sub = (tokens[1] ?? '').toLowerCase();
  if (sub === 'connect') {
    await connectFromArgs(ctx, tokens.slice(2), userMessageId);
    return true;
  }
  if (sub === 'disconnect' || sub === 'off' || sub === 'reset') {
    // Note: menus are sent as new messages here — a bot may only edit its own
    // messages, and `userMessageId` belongs to the user (used for scrubbing).
    await present(ctx, await disconnectPrompt(), await disconnectKeyboard());
    return true;
  }

  let text0 = await databaseMenuText();
  if (auth.claimed) {
    text0 +=
      '\n\n👑 <b>You are now the bot owner</b> — only this chat can manage the database. ' +
      'Set <code>TELEGRAM_ADMIN_CHAT_ID</code> to pin a different chat.';
  }
  await present(ctx, text0, databaseMenuKeyboard());
  return true;
}

/**
 * A pasted connection string: either right after tapping a type in the menu, or
 * on its own. A value whose scheme identifies the backend (postgres://, libsql://,
 * mongodb://, redis://, *.upstash.io, vercel_blob_rw_…) is accepted without the
 * menu too — the pending entry only exists in the memory of one instance, so a
 * cold start must not swallow the message. Generic `https://…` still needs the
 * menu to say which backend it belongs to.
 */
export async function handleDatabaseValueMessage(ctx: BotContext, text: string, messageId: number): Promise<boolean> {
  const tokens = text.trim().split(/\s+/);
  const detected = detectKindFromUrl(tokens[0]);
  const pending = takePending(ctx.chatId);
  if (!detected && !pending) return false;

  const auth = await authorizeDatabaseChat(ctx.chatId);
  if (!auth.ok) return false;

  const kind = detected ?? pending!.kind;
  const url = tokens[0];
  const wantsToken = kind === 'upstash' || kind === 'turso';
  const token = wantsToken ? (tokens[1] ?? null) : null;

  await runConnect(ctx, { kind, url, token, sourceMessageId: messageId });
  return true;
}

// ---------------------------------------------------------------------------
// Disconnect flow
// ---------------------------------------------------------------------------

async function disconnectPrompt(): Promise<string> {
  const s = await storeStatus();
  return (
    '⏏️ <b>Disconnect database</b>\n\n' +
    `Currently: ${kindMeta(s.configuredKind).emoji} ${esc(s.configuredLabel)} (${esc(s.source)})\n\n` +
    'What should the app use instead?\n' +
    '• <b>No database</b> — everything runs in memory; the live rate keeps working, history/alerts reset on restart.\n' +
    '• <b>Environment database</b> — ignore the saved choice and go back to the env-var database (if the deployment has one).'
  );
}

async function disconnectKeyboard(): Promise<InlineKeyboard> {
  const s = await storeStatus();
  const rows: InlineKeyboard = [];
  if (s.detected.length) rows.push([{ text: '⚙️ Use environment database', callback_data: 'db:off:env' }]);
  rows.push([{ text: '🌱 Use no database (in-memory)', callback_data: 'db:off:mem' }]);
  rows.push([{ text: '⬅️ Back', callback_data: 'db:menu' }]);
  return rows;
}

// ---------------------------------------------------------------------------
// Callback buttons
// ---------------------------------------------------------------------------

export async function handleDatabaseCallback(
  ctx: BotContext,
  messageId: number,
  data: string,
  callbackId: string,
): Promise<void> {
  const auth = await authorizeDatabaseChat(ctx.chatId);
  if (!auth.ok) {
    await answerCallbackQuery(ctx.token, callbackId, { text: 'Only the bot owner can do that.', showAlert: true });
    return;
  }

  if (data === 'db:menu') {
    await answerCallbackQuery(ctx.token, callbackId);
    await present(ctx, await databaseMenuText(), databaseMenuKeyboard(), messageId);
    return;
  }

  if (data === 'db:connect') {
    await answerCallbackQuery(ctx.token, callbackId);
    await present(
      ctx,
      '🔌 <b>Connect a database</b>\n\nWhich one? Tap a type — then send the connection string as the next message (or copy the <code>/connect …</code> command).',
      kindKeyboard(),
      messageId,
    );
    return;
  }

  if (data.startsWith('db:kind:')) {
    const kind = normalizeKind(data.slice('db:kind:'.length));
    if (!kind) {
      await answerCallbackQuery(ctx.token, callbackId, { text: 'Unknown database type.', showAlert: true });
      return;
    }
    setPending(ctx.chatId, kind);
    await answerCallbackQuery(ctx.token, callbackId, { text: `Send the ${kindMeta(kind).name} connection string next.` });
    await present(ctx, kindInstructions(kind), kindKeyboard(), messageId);
    return;
  }

  if (data === 'db:test') {
    await answerCallbackQuery(ctx.token, callbackId, { text: 'Testing…' });
    const status = await testActiveDatabase();
    const lines = [
      status.reachable ? '✅ <b>Connection OK</b>' : '❌ <b>Connection failed</b>',
      '',
      `${kindMeta(status.activeKind).emoji} ${esc(status.activeLabel)} (${esc(status.source)})`,
      status.reachable ? `⚡ ${status.ms} ms` : `<code>${esc(redactError(status.error ?? 'unknown error'))}</code>`,
    ];
    const stats = formatStats(status.stats);
    if (stats) lines.push(`📊 ${stats}`);
    await present(ctx, lines.join('\n'), backKeyboard([{ text: '🗄 Database menu', callback_data: 'db:menu' }]), messageId);
    return;
  }

  if (data === 'db:off') {
    await answerCallbackQuery(ctx.token, callbackId);
    await present(ctx, await disconnectPrompt(), await disconnectKeyboard(), messageId);
    return;
  }

  if (data === 'db:off:mem' || data === 'db:off:env') {
    await answerCallbackQuery(ctx.token, callbackId, { text: 'Switching…' });
    const { status, save } = await disconnectDatabase(data === 'db:off:env' ? 'auto' : 'memory', ctx.chatId);
    const modeLabel = data === 'db:off:env' ? 'the environment database' : 'in-memory storage';
    const lines = [
      `⏏️ <b>Disconnected</b> — now using ${modeLabel}.`,
      '',
      `${kindMeta(status.activeKind).emoji} <b>${esc(status.activeLabel)}</b>`,
      status.reachable ? `✅ Reachable (${status.ms} ms)` : `❌ Unreachable${status.error ? `: <code>${esc(redactError(status.error))}</code>` : ''}`,
    ];
    if (data === 'db:off:mem') {
      lines.push('', '⚠️ In-memory history and alert subscriptions are lost when the server restarts.');
    }
    if (!save.persisted) lines.push('', `⚠️ ${esc(save.warning ?? 'The choice could not be saved to disk.')}`);
    await present(ctx, lines.join('\n'), backKeyboard([{ text: '🗄 Database menu', callback_data: 'db:menu' }]), messageId);
    return;
  }

  if (data === 'db:close') {
    await answerCallbackQuery(ctx.token, callbackId);
    await deleteTelegramMessage(ctx.token, ctx.chatId, messageId).then((r) => {
      if (!r.success) present(ctx, '🗄 Database menu closed. Send /database to reopen.', undefined, messageId);
    });
    return;
  }

  await answerCallbackQuery(ctx.token, callbackId, { text: 'Unknown action — reopening the menu.' });
  await present(ctx, await databaseMenuText(), databaseMenuKeyboard(), messageId);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/** Extra /help lines for the database menu. */
export const DATABASE_HELP =
  `<b>Database</b>\n` +
  `• /database — 🗄 database menu: connect / switch / test / disconnect\n` +
  `• /connect &lt;type&gt; &lt;url&gt; [token] — connect directly (types: postgres, turso, mongodb, upstash, redis, blob)\n` +
  `   <i>e.g.</i> <code>/connect postgres postgresql://user:pass@host:5432/db</code>`;

export { KIND_META };
