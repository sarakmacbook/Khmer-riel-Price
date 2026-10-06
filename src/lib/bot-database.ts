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
  maskTarget,
  maskToken,
  redactError,
  type DbSpec,
} from './store/env';
import { storeStatus, type LinkStatus } from './store';
import { summarizeTransfer } from './store/transfer';
import {
  claimAdminChatId,
  getAdminChatId,
  normalizeKind,
  specFromInput,
} from './db-config';
import {
  connectDatabase,
  disconnectDatabase,
  linkBackup,
  promoteBackup,
  syncDatabases,
  testActiveDatabase,
  testLink,
  unlinkBackup,
  updateLinkOptions,
  type SyncTarget,
} from './db-actions';
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
/** Commands of the backup/link feature. */
export const LINK_COMMANDS = ['/link', '/backup'];
export const UNLINK_COMMANDS = ['/unlink', '/unbackup'];
export const SYNC_COMMANDS = ['/sync', '/copy'];
export const PROMOTE_COMMANDS = ['/promote', '/failback'];

const PENDING_TTL_MS = 15 * 60_000;

interface Pending {
  kind: StoreKind;
  /** connect = replace the primary database, link = add it as the backup */
  purpose: 'connect' | 'link';
  at: number;
}

const g = globalThis as typeof globalThis & {
  /** Chats that tapped a database type and are expected to paste a value next. */
  __wingrateBotPending?: Map<string, Pending>;
};
const pending = () => (g.__wingrateBotPending ??= new Map<string, Pending>());

const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
/** Escape user-supplied text for Telegram's HTML parse mode. */
export const esc = (s: string) => s.replace(/[&<>]/g, (c) => HTML_ESCAPE[c]);

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

/** 🟢 / 🔴 / ⚪️ for a reachability flag that may not have been checked yet. */
const dot = (ok: boolean | null | undefined) => (ok === null || ok === undefined ? '⚪️' : ok ? '🟢' : '🔴');
const onOff = (b: boolean) => (b ? 'on' : 'off');

/** "1,234 rows" — a side's size, when the backend reports it. */
const rowsLabel = (rows: number | null) => (rows === null ? '' : ` — ${rows.toLocaleString()} rows`);

/** The backup/failover block of the menu. */
function linkSection(link: LinkStatus | null): string[] {
  if (!link) {
    return [
      '🔗 <b>Backup database:</b> none linked',
      '<i>Link a second database (any kind) and every price tick is mirrored into it. If the primary goes down the app keeps working on the backup, and moves back automatically once it returns — /link does the same thing.</i>',
    ];
  }

  const lines: string[] = ['🔗 <b>Backup database</b>'];
  lines.push(`${dot(link.primary.reachable)} ${kindMeta(link.primary.kind).emoji} <b>${esc(link.primary.label)}</b> — primary${rowsLabel(link.primary.rows)}`);
  if (link.primary.target) lines.push(`   <code>${esc(link.primary.target)}</code>`);
  lines.push(`${dot(link.backup.reachable)} ${kindMeta(link.backup.kind).emoji} <b>${esc(link.backup.label)}</b> — backup${rowsLabel(link.backup.rows)}`);
  if (link.backup.target) lines.push(`   <code>${esc(link.backup.target)}</code>`);
  lines.push(
    `⚙️ mirror ${onOff(link.options.mirror)} · failover ${onOff(link.options.autoFailover)} · ` +
      `auto-return ${onOff(link.options.autoReturn)} · re-sync ${onOff(link.options.autoResync)}`,
  );
  lines.push(
    `🧭 <b>Serving:</b> ${link.serving === 'primary' ? esc(link.primary.label) : esc(link.backup.label)}` +
      (link.reason ? ` <i>(${esc(link.reason)})</i>` : ''),
  );
  lines.push(`${link.drift.inSync === false ? '⚠️' : '⚖️'} ${esc(link.drift.note)}`);

  const c = link.counters;
  const bits: string[] = [];
  if (c.failovers) bits.push(`${c.failovers} failover${c.failovers === 1 ? '' : 's'}`);
  if (c.failbacks) bits.push(`${c.failbacks} return${c.failbacks === 1 ? '' : 's'}`);
  if (c.mirrorErrors) bits.push(`${c.mirrorErrors} mirror error${c.mirrorErrors === 1 ? '' : 's'}`);
  if (c.pendingResync) bits.push('re-sync pending');
  if (c.lastResyncAt) bits.push(`last re-sync ${new Date(c.lastResyncAt).toISOString().slice(11, 16)} UTC`);
  if (bits.length) lines.push(`📈 ${esc(bits.join(' · '))}`);

  if (link.primary.error) lines.push(`❌ primary: <code>${esc(redactError(link.primary.error))}</code>`);
  if (link.backup.error) lines.push(`❌ backup: <code>${esc(redactError(link.backup.error))}</code>`);
  return lines;
}

/** The status card shown by /database and the ♻️ button. */
export async function databaseMenuText(status?: Awaited<ReturnType<typeof storeStatus>>): Promise<string> {
  const s = status ?? (await storeStatus());
  const choice = s.choice;

  const lines = ['🗄 <b>Database manager</b>', ''];

  const activeIcon = s.activeKind === 'memory' ? '🟡' : '🟢';
  const configured =
    choice.mode === 'custom'
      ? `${kindMeta(choice.spec.kind).emoji} <b>${esc(s.configuredLabel)}</b>\n<code>${esc(maskTarget(choice.spec.url))}</code>` +
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

  lines.push('', ...linkSection(s.link));
  lines.push('', 'Connect a database from anywhere — the switch is live, no redeploy needed.');
  return lines.join('\n');
}

export function databaseMenuKeyboard(link?: LinkStatus | null): InlineKeyboard {
  const rows: InlineKeyboard = [
    [{ text: '🔌 Connect database', callback_data: 'db:connect' }, { text: '🧪 Test connection', callback_data: 'db:test' }],
  ];
  if (link) {
    rows.push([
      { text: '🧬 Sync data', callback_data: 'db:linksync' },
      { text: '🧪 Test backup', callback_data: 'db:linktest' },
    ]);
    rows.push([
      { text: '⬆️ Promote backup', callback_data: 'db:linkpromote' },
      { text: '⚙️ Link options', callback_data: 'db:linkopts' },
    ]);
    rows.push([{ text: '⏏️ Unlink backup', callback_data: 'db:linkoff' }]);
  } else {
    rows.push([{ text: '🔗 Link backup database', callback_data: 'db:link' }, { text: '🧬 Sync data', callback_data: 'db:linksync' }]);
  }
  // 📤📥 Export/import lives in its own flow (lib/bot-export) — one tap away here.
  rows.push([{ text: '📤 Export & import', callback_data: 'exp:menu' }]);
  rows.push([{ text: '♻️ Refresh status', callback_data: 'db:menu' }, { text: '⏏️ Disconnect', callback_data: 'db:off' }]);
  rows.push([{ text: '✖️ Close', callback_data: 'db:close' }]);
  return rows;
}

/** Which way data should be copied (also accepts "to"/"from"/"both"). */
function parseSyncTarget(raw: string | undefined): SyncTarget {
  const s = (raw ?? '').trim().toLowerCase();
  if (['to', 'tobackup', 'backup', 'push', 'out'].includes(s)) return 'toBackup';
  if (['from', 'frombackup', 'restore', 'pull', 'in'].includes(s)) return 'fromBackup';
  if (['both', 'reconcile', 'merge'].includes(s)) return 'both';
  return 'auto';
}

function kindKeyboard(prefix = 'db:kind:'): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < KIND_META.length; i += 2) {
    rows.push(
      KIND_META.slice(i, i + 2).map((m) => ({ text: `${m.emoji} ${m.name}`, callback_data: `${prefix}${m.kind}` })),
    );
  }
  rows.push([{ text: '⬅️ Back', callback_data: 'db:menu' }]);
  return rows;
}

function backKeyboard(extra: InlineKeyboard[number] = []): InlineKeyboard {
  return extra.length ? [extra, [{ text: '⬅️ Back', callback_data: 'db:menu' }]] : [[{ text: '⬅️ Back', callback_data: 'db:menu' }]];
}

/** Instructions for linking a backend as the backup database. */
function linkInstructions(kind: StoreKind): string {
  const m = kindMeta(kind);
  const exampleArgs = m.tokenLabel ? `<connection-string> <${m.tokenLabel.toLowerCase().replace(/\s+/g, '-')}>` : '<connection-string>';
  return (
    `🔗 <b>Link a ${esc(m.name)} as the backup</b>\n\n${esc(m.hint)}\n\n` +
    `Send the connection string in one message:\n` +
    `<code>${LINK_COMMANDS[0]} ${m.kind} ${exampleArgs}</code>\n\n` +
    `Example:\n<code>${LINK_COMMANDS[0]} ${m.kind} ${esc(m.example)}</code>` +
    (m.tokenLabel ? `\n(token: ${esc(m.tokenLabel)})` : '') +
    '\n\n<i>The current database stays the primary: every tick is mirrored into this one, ' +
      'it takes over if the primary is down, and the app returns to the primary automatically. ' +
      'Both databases are made to hold the same data when you link.</i>'
  );
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

/** Edit a menu in place when possible, otherwise send a new message. */
export async function present(
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
  const status = await storeStatus();
  await present(ctx, await databaseMenuText(status), databaseMenuKeyboard(status.link), messageId);
}

// ---------------------------------------------------------------------------
// Connect flow
// ---------------------------------------------------------------------------

/** Remember which backend the chat asked for so a pasted value can be used directly. */
function setPending(chatId: string, kind: StoreKind, purpose: Pending['purpose'] = 'connect'): void {
  pending().set(chatId, { kind, purpose, at: Date.now() });
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
    `🔎 Testing ${meta.emoji} <b>${esc(meta.name)}</b>…\n<code>${esc(maskTarget(spec.url))}</code>`,
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
    ? `✅ <b>Connected</b>\n\n${meta.emoji} <b>${esc(outcome.label)}</b>\n<code>${esc(maskTarget(spec.url))}</code>` +
      (spec.token ? `\ntoken <code>${esc(maskToken(spec.token))}</code>` : '')
    : `❌ <b>Connection failed</b>\n\n${meta.emoji} ${esc(meta.name)}\n<code>${esc(maskTarget(spec.url))}</code>\n\n<code>${esc(redactError(outcome.error ?? 'unknown error'))}</code>`;

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
 * Link a second database as the backup: probe it, save it, and copy the data
 * across so both sides start in sync.
 */
async function runLink(
  ctx: BotContext,
  opts: { kind?: StoreKind | null; url: string; token?: string | null; sourceMessageId?: number },
): Promise<void> {
  let spec: DbSpec;
  try {
    spec = specFromInput({ kind: opts.kind ?? null, url: opts.url, token: opts.token ?? null, label: 'Backup' });
  } catch (e) {
    await present(ctx, `⚠️ ${esc(redactError(e))}\n\n${linkInstructions(opts.kind ?? 'postgres')}`, kindKeyboard('db:link:kind:'));
    return;
  }

  const meta = kindMeta(spec.kind);
  const progress = await sendTelegramMessage(
    ctx.token,
    ctx.chatId,
    `🔎 Testing ${meta.emoji} <b>${esc(meta.name)}</b> as the backup…\n<code>${esc(maskTarget(spec.url))}</code>`,
    { silent: true },
  );

  const outcome = await linkBackup(spec, { by: ctx.chatId, source: 'telegram', syncNow: true });

  let scrubbed: 'deleted' | 'failed' | null = null;
  if (opts.sourceMessageId && hasCredentials(opts.url)) {
    const del = await deleteTelegramMessage(ctx.token, ctx.chatId, opts.sourceMessageId);
    scrubbed = del.success ? 'deleted' : 'failed';
  }

  const lines: string[] = [];
  if (outcome.ok) {
    lines.push(`✅ <b>Backup linked</b>`);
    lines.push(`${meta.emoji} <b>${esc(outcome.label)}</b>`);
    lines.push(`<code>${esc(maskTarget(spec.url))}</code>` + (spec.token ? `\ntoken <code>${esc(maskToken(spec.token))}</code>` : ''));
    lines.push('');
    lines.push(`⚡ Responded in ${outcome.ms} ms`);
    if (outcome.sync) {
      lines.push(`🧬 ${esc(outcome.sync.ok ? summarizeTransfer(outcome.sync) : `Data copy failed: ${redactError(outcome.sync.error ?? 'unknown error')}`)}`);
      for (const warning of outcome.sync.warnings.slice(0, 3)) lines.push(`⚠️ ${esc(warning)}`);
    }
    lines.push(
      outcome.save.persisted
        ? `💾 Saved${outcome.save.path ? ` to <code>${esc(outcome.save.path)}</code>` : ''}`
        : '⚠️ Not saved to disk — this link lasts until the server restarts.',
    );
    if (outcome.save.warning) lines.push(`⚠️ ${esc(outcome.save.warning)}`);
    lines.push('');
    lines.push('Every write is now mirrored. If the primary stops answering, the backup serves the app and the primary is re-checked automatically.');
  } else {
    lines.push(`❌ <b>Could not link the backup</b>`);
    lines.push(`${meta.emoji} ${esc(meta.name)}\n<code>${esc(maskTarget(spec.url))}</code>`);
    lines.push('');
    lines.push(`<code>${esc(redactError(outcome.error ?? 'unknown error'))}</code>`);
    lines.push('', 'Nothing changed — the current database is untouched.');
  }
  if (scrubbed === 'deleted') lines.push('', '🧹 Your message with the credentials was deleted.');
  if (scrubbed === 'failed') lines.push('', '🧹 Tip: delete the message containing your credentials yourself.');

  const keyboard: InlineKeyboard = outcome.ok
    ? [
        [{ text: '🧪 Backup status', callback_data: 'db:linktest' }, { text: '🗄 Database menu', callback_data: 'db:menu' }],
        [{ text: '✖️ Close', callback_data: 'db:close' }],
      ]
    : backKeyboard([{ text: '🗄 Database menu', callback_data: 'db:menu' }]);

  const text = lines.join('\n');
  if (progress.success && progress.messageId) {
    const edited = await editTelegramMessage(ctx.token, ctx.chatId, progress.messageId, text, { keyboard });
    if (edited.success) return;
  }
  await present(ctx, text, keyboard);
}

/** `/link [type] <connection-string> [token]` — same shapes as /connect. */
async function linkFromArgs(ctx: BotContext, args: string[], userMessageId?: number): Promise<void> {
  if (args.length === 0) {
    await present(
      ctx,
      '🔗 <b>Link a backup database</b>\n\nPick a type — then send the connection string as the next message ' +
        '(or copy the <code>/link …</code> command). The current database stays the primary.',
      kindKeyboard('db:link:kind:'),
    );
    return;
  }
  const explicit = normalizeKind(args[0]);
  const url = explicit ? args[1] : args[0];
  const token = explicit ? args[2] : args[1];
  if (!url) {
    await present(ctx, linkInstructions(explicit!), kindKeyboard('db:link:kind:'));
    return;
  }
  await runLink(ctx, { kind: explicit, url, token: token ?? null, sourceMessageId: userMessageId });
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

/** Every command the database menu owns. Returns false when the text is not ours. */
function isDatabaseCommand(cmd: string): boolean {
  return (
    DATABASE_COMMANDS.includes(cmd) ||
    cmd === CONNECT_COMMAND ||
    LINK_COMMANDS.includes(cmd) ||
    UNLINK_COMMANDS.includes(cmd) ||
    SYNC_COMMANDS.includes(cmd) ||
    PROMOTE_COMMANDS.includes(cmd)
  );
}

/** Handle /database, /connect, /link, /unlink, /sync and /promote. Returns false when not ours. */
export async function handleDatabaseCommand(ctx: BotContext, text: string, userMessageId?: number): Promise<boolean> {
  const tokens = text.trim().split(/\s+/);
  const cmd = tokens[0].toLowerCase().split('@')[0];
  const isMenu = DATABASE_COMMANDS.includes(cmd);
  if (!isDatabaseCommand(cmd)) return false;

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

  if (LINK_COMMANDS.includes(cmd)) {
    await linkFromArgs(ctx, tokens.slice(1), userMessageId);
    return true;
  }

  if (UNLINK_COMMANDS.includes(cmd)) {
    await confirmUnlink(ctx, tokens[1] === 'yes');
    return true;
  }

  if (SYNC_COMMANDS.includes(cmd)) {
    await runSync(ctx, parseSyncTarget(tokens[1]), { dryRun: tokens.includes('--dry-run') });
    return true;
  }

  if (PROMOTE_COMMANDS.includes(cmd)) {
    await confirmPromote(ctx, tokens[1] === 'yes');
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

  const status0 = await storeStatus();
  let text0 = await databaseMenuText(status0);
  if (auth.claimed) {
    text0 +=
      '\n\n👑 <b>You are now the bot owner</b> — only this chat can manage the database. ' +
      'Set <code>TELEGRAM_ADMIN_CHAT_ID</code> to pin a different chat.';
  }
  await present(ctx, text0, databaseMenuKeyboard(status0.link));
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
  const wantsToken = kind === 'upstash' || kind === 'turso' || (kind === 'blob' && tokens.length > 1);
  const token = wantsToken ? (tokens[1] ?? null) : null;

  if (pending?.purpose === 'link') {
    await runLink(ctx, { kind, url, token, sourceMessageId: messageId });
    return true;
  }
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
    const status = await storeStatus();
    await present(ctx, await databaseMenuText(status), databaseMenuKeyboard(status.link), messageId);
    return;
  }

  if (data === 'db:connect') {
    await answerCallbackQuery(ctx.token, callbackId);
    await present(
      ctx,
      '🔌 <b>Connect a database</b>\n\nWhich one? Tap a type — then send the connection string as the next message (or copy the <code>/connect …</code> command).\n\n' +
        '<i>Connecting replaces the primary database. To add a second one as a live backup instead, use 🔗 Link backup.</i>',
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

  // ---- backup database ---------------------------------------------------

  if (data === 'db:link') {
    await answerCallbackQuery(ctx.token, callbackId);
    await present(
      ctx,
      '🔗 <b>Link a backup database</b>\n\nWhich kind? Tap a type — then send the connection string as the next message ' +
        '(or copy the <code>/link …</code> command). The current database stays the primary.',
      kindKeyboard('db:link:kind:'),
      messageId,
    );
    return;
  }

  if (data.startsWith('db:link:kind:')) {
    const kind = normalizeKind(data.slice('db:link:kind:'.length));
    if (!kind) {
      await answerCallbackQuery(ctx.token, callbackId, { text: 'Unknown database type.', showAlert: true });
      return;
    }
    setPending(ctx.chatId, kind, 'link');
    await answerCallbackQuery(ctx.token, callbackId, { text: `Send the ${kindMeta(kind).name} connection string next.` });
    await present(ctx, linkInstructions(kind), kindKeyboard('db:link:kind:'), messageId);
    return;
  }

  if (data === 'db:linktest') {
    await answerCallbackQuery(ctx.token, callbackId, { text: 'Testing the link…' });
    await testLink(); // force a real re-check of both databases
    const { text, keyboard } = await linkTestText();
    await present(ctx, text, keyboard, messageId);
    return;
  }

  if (data === 'db:linksync') {
    await answerCallbackQuery(ctx.token, callbackId);
    const { text, keyboard } = await syncMenu();
    await present(ctx, text, keyboard, messageId);
    return;
  }

  if (data.startsWith('db:sync:')) {
    const target = parseSyncTarget(data.slice('db:sync:'.length));
    await answerCallbackQuery(ctx.token, callbackId, { text: 'Copying…' });
    await runSync(ctx, target);
    return;
  }

  if (data === 'db:linkoff' || data === 'db:linkoff:yes') {
    await answerCallbackQuery(ctx.token, callbackId, { text: data.endsWith(':yes') ? 'Unlinking…' : '' });
    await confirmUnlink(ctx, data.endsWith(':yes'));
    return;
  }

  if (data === 'db:linkpromote' || data === 'db:linkpromote:yes') {
    await answerCallbackQuery(ctx.token, callbackId, { text: data.endsWith(':yes') ? 'Promoting…' : '' });
    await confirmPromote(ctx, data.endsWith(':yes'));
    return;
  }

  if (data === 'db:linkopts') {
    await answerCallbackQuery(ctx.token, callbackId);
    const { text, keyboard } = await linkOptionsText();
    await present(ctx, text, keyboard, messageId);
    return;
  }

  if (data.startsWith('db:opt:')) {
    const key = data.slice('db:opt:'.length);
    const status = await storeStatus();
    if (!status.link) {
      await answerCallbackQuery(ctx.token, callbackId, { text: 'No backup database is linked.', showAlert: true });
      await present(ctx, await databaseMenuText(status), databaseMenuKeyboard(status.link), messageId);
      return;
    }
    const next = { ...status.link.options, [key]: !status.link.options[key as keyof typeof status.link.options] };
    const outcome = await updateLinkOptions(next, ctx.chatId);
    await answerCallbackQuery(ctx.token, callbackId, {
      text: outcome.ok ? `${key} is now ${next[key as keyof typeof next] ? 'on' : 'off'}` : outcome.error ?? 'Could not update',
      showAlert: !outcome.ok,
    });
    const { text, keyboard } = await linkOptionsText();
    await present(ctx, text, keyboard, messageId);
    return;
  }

  await answerCallbackQuery(ctx.token, callbackId, { text: 'Unknown action — reopening the menu.' });
  const fallback = await storeStatus();
  await present(ctx, await databaseMenuText(fallback), databaseMenuKeyboard(fallback.link), messageId);
}


// ---------------------------------------------------------------------------
// Backup flows (link / sync / promote / options)
// ---------------------------------------------------------------------------

/** Status card for one side of the link, used by "🧪 Test backup". */
async function linkTestText(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const status = await storeStatus();
  if (!status.link) {
    return {
      text: '🔗 No backup database is linked yet. Tap <b>🔗 Link backup database</b> to add one (or send <code>/link postgres &lt;url&gt;</code>).',
      keyboard: backKeyboard([{ text: '🔗 Link backup', callback_data: 'db:link' }]),
    };
  }
  const { link } = status;
  const side = (s: typeof link.primary, role: string) =>
    `${dot(s.reachable)} ${kindMeta(s.kind).emoji} <b>${esc(s.label)}</b> (${role})${rowsLabel(s.rows)}\n` +
    (s.reachable ? `   ⚡ ${s.ms} ms` : `   <code>${esc(redactError(s.error ?? 'unreachable'))}</code>`) +
    (s.target ? `\n   <code>${esc(s.target)}</code>` : '');

  const lines = [
    '🔗 <b>Backup link test</b>',
    '',
    side(link.primary, 'primary'),
    side(link.backup, 'backup'),
    '',
    `🧭 Serving: ${link.serving === 'primary' ? esc(link.primary.label) : esc(link.backup.label)}${link.reason ? ` <i>(${esc(link.reason)})</i>` : ''}`,
    `${link.drift.inSync === false ? '⚠️' : '✅'} ${esc(link.drift.note)}`,
  ];
  if (link.counters.lastMirrorAt) lines.push(`📈 last mirror ${new Date(link.counters.lastMirrorAt).toISOString().slice(11, 19)} UTC`);
  if (link.counters.lastMirrorError) lines.push(`⚠️ mirror error: <code>${esc(redactError(link.counters.lastMirrorError))}</code>`);
  return { text: lines.join('\n'), keyboard: backKeyboard([{ text: '🧬 Sync data', callback_data: 'db:linksync' }]) };
}

/** Choose what to copy between the two linked databases. */
async function syncMenu(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const status = await storeStatus();
  if (!status.link) {
    return {
      text:
        '🔗 No backup database is linked yet, so there is nothing to sync.\n\n' +
        '<i>Linking two databases keeps them in step automatically — a manual sync is only needed to seed or repair them.</i>',
      keyboard: backKeyboard([{ text: '🔗 Link backup', callback_data: 'db:link' }]),
    };
  }
  const { link } = status;
  return {
    text:
      '🧬 <b>Copy data between the databases</b>\n\n' +
      `${kindMeta(link.primary.kind).emoji} ${esc(link.primary.label)}${rowsLabel(link.primary.rows)}\n` +
      `${kindMeta(link.backup.kind).emoji} ${esc(link.backup.label)}${rowsLabel(link.backup.rows)}\n\n` +
      `${link.drift.inSync === false ? '⚠️' : '✅'} ${esc(link.drift.note)}\n\n` +
      'Copies price history and alert subscriptions, and never duplicates what is already there. ' +
      'Rows that exist only in the target are left alone.',
    keyboard: [
      [{ text: '🧬 Reconcile both ways (recommended)', callback_data: 'db:sync:auto' }],
      [
        { text: '⬆️ Copy primary → backup', callback_data: 'db:sync:to' },
        { text: '⬇️ Restore backup → primary', callback_data: 'db:sync:from' },
      ],
      [{ text: '⬅️ Back', callback_data: 'db:menu' }],
    ],
  };
}

/** Run a copy and report the outcome. */
async function runSync(ctx: BotContext, target: SyncTarget, opts: { dryRun?: boolean } = {}): Promise<void> {
  const progress = await sendTelegramMessage(ctx.token, ctx.chatId, '🧬 Copying data between the databases…', { silent: true });
  const outcome = await syncDatabases({ target, dryRun: opts.dryRun }, { by: ctx.chatId });

  const lines = [outcome.ok ? '✅ <b>Data copied</b>' : '❌ <b>Copy failed</b>', ''];
  if (outcome.summary) lines.push(esc(outcome.summary));
  for (const r of outcome.results) {
    for (const warning of r.warnings.slice(0, 3)) lines.push(`⚠️ ${esc(warning)}`);
    if (r.error) lines.push(`<code>${esc(redactError(r.error))}</code>`);
  }
  if (outcome.status) lines.push('', `${outcome.status.drift.inSync === false ? '⚠️' : '✅'} ${esc(outcome.status.drift.note)}`);

  const text = lines.join('\n');
  const keyboard = backKeyboard([{ text: '🧬 Sync again', callback_data: 'db:linksync' }]);
  if (progress.success && progress.messageId) {
    const edited = await editTelegramMessage(ctx.token, ctx.chatId, progress.messageId, text, { keyboard });
    if (edited.success) return;
  }
  await present(ctx, text, keyboard);
}

/** Confirm (or perform) unlinking the backup. */
async function confirmUnlink(ctx: BotContext, yes: boolean): Promise<void> {
  const status = await storeStatus();
  if (!status.link) {
    await present(ctx, '🔗 No backup database is linked.', backKeyboard());
    return;
  }
  if (!yes) {
    await present(
      ctx,
      '⏏️ <b>Unlink the backup database?</b>\n\n' +
        `${kindMeta(status.link.backup.kind).emoji} ${esc(status.link.backup.label)} stops being a live copy of ` +
        `${esc(status.link.primary.label)}.\n\n` +
        '<b>No data is deleted:</b> both databases keep everything they hold, and the app keeps using the primary only.',
      [[{ text: '⏏️ Unlink backup', callback_data: 'db:linkoff:yes' }], [{ text: '⬅️ Back', callback_data: 'db:menu' }]],
    );
    return;
  }

  const { save } = await unlinkBackup(ctx.chatId);
  const lines = ['⏏️ <b>Backup unlinked</b>', '', 'The app now uses the primary database only. Nothing was deleted from either database.'];
  if (!save.persisted) lines.push('', `⚠️ ${esc(save.warning ?? 'The change could not be saved to disk.')}`);
  await present(ctx, lines.join('\n'), backKeyboard([{ text: '🗄 Database menu', callback_data: 'db:menu' }]));
}

/** Confirm (or perform) promoting the backup to primary. */
async function confirmPromote(ctx: BotContext, yes: boolean): Promise<void> {
  const status = await storeStatus();
  if (!status.link) {
    await present(ctx, '🔗 No backup database is linked.', backKeyboard());
    return;
  }
  if (!yes) {
    await present(
      ctx,
      '⬆️ <b>Promote the backup to the primary database?</b>\n\n' +
        `${kindMeta(status.link.backup.kind).emoji} ${esc(status.link.backup.label)} becomes the database the app uses, ` +
        `and ${esc(status.link.primary.label)} becomes its backup.\n\n` +
        '<i>Both keep their data and are reconciled afterwards.</i>',
      [[{ text: '⬆️ Promote backup', callback_data: 'db:linkpromote:yes' }], [{ text: '⬅️ Back', callback_data: 'db:menu' }]],
    );
    return;
  }

  const progress = await sendTelegramMessage(ctx.token, ctx.chatId, '⬆️ Promoting the backup…', { silent: true });
  const outcome = await promoteBackup({ by: ctx.chatId, source: 'telegram', syncNow: true });
  const lines = outcome.ok
    ? [
        '✅ <b>Backup promoted</b>',
        '',
        `${kindMeta(status.link.backup.kind).emoji} <b>${esc(outcome.label ?? status.link.backup.label)}</b> is now the primary database.`,
        `${kindMeta(status.link.primary.kind).emoji} ${esc(status.link.primary.label)} is now its backup.`,
        ...(outcome.summary ? ['', `🧬 ${esc(outcome.summary)}`] : []),
      ]
    : ['❌ <b>Promote failed</b>', '', `<code>${esc(redactError(outcome.error ?? 'unknown error'))}</code>`];

  const text = lines.join('\n');
  const keyboard = backKeyboard([{ text: '🗄 Database menu', callback_data: 'db:menu' }]);
  if (progress.success && progress.messageId) {
    const edited = await editTelegramMessage(ctx.token, ctx.chatId, progress.messageId, text, { keyboard });
    if (edited.success) return;
  }
  await present(ctx, text, keyboard);
}

function linkOptionsKeyboard(options: { mirror: boolean; autoFailover: boolean; autoReturn: boolean; autoResync: boolean }): InlineKeyboard {
  const mark = (b: boolean) => (b ? '✅' : '⬜️');
  return [
    [{ text: `${mark(options.mirror)} Mirror every write`, callback_data: 'db:opt:mirror' }],
    [{ text: `${mark(options.autoFailover)} Auto failover when the primary is down`, callback_data: 'db:opt:autoFailover' }],
    [{ text: `${mark(options.autoReturn)} Auto return to the primary`, callback_data: 'db:opt:autoReturn' }],
    [{ text: `${mark(options.autoResync)} Auto re-sync after a failover`, callback_data: 'db:opt:autoResync' }],
    [{ text: '⬅️ Back', callback_data: 'db:menu' }],
  ];
}

async function linkOptionsText(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const status = await storeStatus();
  if (!status.link) {
    return { text: '🔗 No backup database is linked.', keyboard: backKeyboard([{ text: '🔗 Link backup', callback_data: 'db:link' }]) };
  }
  return {
    text:
      '⚙️ <b>Backup link options</b>\n\n' +
      'Tap to turn an option on or off — changes apply immediately, no redeploy.\n\n' +
      '<b>Mirror every write</b> — the backup receives the same ticks as the primary.\n' +
      '<b>Auto failover</b> — serve requests from the backup while the primary is down.\n' +
      '<b>Auto return</b> — go back to the primary as soon as it answers again.\n' +
      '<b>Auto re-sync</b> — copy rows the backup recorded during an outage back into the primary.',
    keyboard: linkOptionsKeyboard(status.link.options),
  };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/** Extra /help lines for the database menu. */
export const DATABASE_HELP =
  `<b>Database</b>\n` +
  `• /database — 🗄 database menu: connect / switch / test / disconnect\n` +
  `• /connect &lt;type&gt; &lt;url&gt; [token] — connect directly (types: postgres, turso, mongodb, upstash, redis, blob)\n` +
  `   <i>e.g.</i> <code>/connect postgres postgresql://user:pass@host:5432/db</code>\n` +
  `<b>Backup &amp; failover</b>\n` +
  `• /link &lt;type&gt; &lt;url&gt; [token] — add a 2nd database: every write is mirrored into it, it takes over if the primary is down, and the app returns to the primary automatically\n` +
  `• /sync [to|from|auto] — copy price history &amp; alerts between the two databases\n` +
  `• /promote — make the backup the primary database\n` +
  `• /unlink — stop mirroring (nothing is deleted)\n` +
  `   <i>e.g.</i> <code>/link turso libsql://my-db.turso.io TOKEN</code>`;

export { KIND_META };
