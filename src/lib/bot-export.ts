/**
 * 📤📥 Export & import over Telegram.
 *
 * `/export` writes the active database to a file and sends it to the chat;
 * `/import` reads a file back in (sent as a document, or by replying `/import`
 * to one that is already in the chat).
 *
 * Everything that touches the database goes through the same copy pipeline the
 * backup feature uses (`transferStore` + `ExportFileStore`), so an import is
 * idempotent: importing the same file twice adds nothing the second time, and
 * "replace" is refused when the connected backend cannot erase its own data.
 *
 * The file itself is the durable artefact — it can be re-imported into another
 * deployment, opened in a spreadsheet (CSV) or kept as a backup. Nothing is
 * written until the owner confirms on the preview card.
 *
 * Security notes:
 *  • Owner-only, exactly like the 🗄 database menu (`authorizeDatabaseChat`).
 *  • A JSON export can contain alert credentials (webhook URLs, bot tokens) —
 *    the caption says so, and the preview offers to delete the file message.
 *  • Uploads are size-capped twice: Telegram's own 20 MB bot download limit and
 *    `IMPORT_MAX_MB` (default 5 MB), before anything is parsed.
 */

import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  encodeExport,
  exportFacts,
  exportFilename,
  exportLimit,
  exportMaxBytes,
  importMaxBytes,
  mimeFor,
  num,
  parseExportFile,
  type ExportBundle,
  type ExportFormat,
  type ExportScope,
} from './export-file';
import { ExportFileStore } from './store/file';
import { getStoreOrMemory, storeStatus } from './store';
import { transferStore, type TransferResult } from './store/transfer';
import { redactError } from './store/env';
import { errDetail, type RateStore } from './store/types';
import { authorizeDatabaseChat, esc, present, type BotContext } from './bot-database';
import {
  answerCallbackQuery,
  deleteTelegramMessage,
  downloadTelegramFile,
  editTelegramMessage,
  humanBytes,
  sendTelegramDocument,
  sendTelegramMessage,
  type InlineKeyboard,
} from './telegram';

export const EXPORT_COMMANDS = ['/export'];
export const IMPORT_COMMANDS = ['/import', '/restore'];

const PENDING_TTL_MS = 15 * 60_000;
/** Files waiting for a confirmation tap; the oldest are dropped first. */
const MAX_PENDING = 8;

/** A document attached to (or replied to by) a Telegram message. */
export interface BotDocumentRef {
  fileId: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
}

/** The parts of a Telegram message the export/import flow cares about. */
export interface BotFileMessage {
  /** The user's own message id (used to delete it when asked). */
  messageId?: number;
  /** A document sent with this message. */
  document?: BotDocumentRef | null;
  /** A document this message is a reply to (`/import` as a reply). */
  replyDocument?: BotDocumentRef | null;
  /** Message id of the replied-to message (the file's own message). */
  replyMessageId?: number;
}

interface PendingImport {
  id: string;
  chatId: string;
  filename: string;
  bytes: number;
  bundle: ExportBundle;
  warnings: string[];
  /** Message holding the uploaded file, so it can be deleted again. */
  docMessageId: number | null;
  at: number;
}

const g = globalThis as typeof globalThis & {
  /** Files parsed and waiting for the owner to confirm the import. */
  __wingrateBotImports?: Map<string, PendingImport>;
};

const pendingImports = () => (g.__wingrateBotImports ??= new Map<string, PendingImport>());

/** Short, unguessable-enough id used in callback_data (`exp:imp:<id>:merge`). */
function newImportId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function rememberImport(entry: Omit<PendingImport, 'id' | 'at'>): PendingImport {
  const map = pendingImports();
  for (const [id, p] of map) if (Date.now() - p.at > PENDING_TTL_MS) map.delete(id);
  while (map.size >= MAX_PENDING) map.delete(map.keys().next().value as string);
  const pending: PendingImport = { ...entry, id: newImportId(), at: Date.now() };
  map.set(pending.id, pending);
  return pending;
}

function takeImport(chatId: string, id: string): PendingImport | null {
  const pending = pendingImports().get(id);
  if (!pending || pending.chatId !== chatId) return null;
  return Date.now() - pending.at > PENDING_TTL_MS ? null : pending;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface BuiltExport {
  bundle: ExportBundle;
  format: ExportFormat;
  filename: string;
  mimeType: string;
  text: string;
  bytes: number;
  warnings: string[];
}

/**
 * Read the database and turn it into a file.
 *
 * Two limits are applied, newest rows first: `EXPORT_LIMIT` rows, and
 * `EXPORT_MAX_MB` bytes (Telegram refuses large uploads) — the caller is told
 * through `warnings` and `bundle.truncated`, never silently.
 */
export async function buildExportFile(
  opts: { format?: ExportFormat; scope?: ExportScope; store?: RateStore; now?: number; maxPoints?: number } = {},
): Promise<BuiltExport> {
  const format: ExportFormat = opts.format === 'csv' ? 'csv' : 'json';
  const scope: ExportScope = opts.scope ?? 'all';
  const store = opts.store ?? (await getStoreOrMemory());
  const warnings: string[] = [];

  await store.init();
  const allPoints = scope === 'alerts' ? [] : await store.range(0);
  const allAlerts = scope === 'history' ? [] : await store.listAlerts();

  const maxPoints = Math.max(1, opts.maxPoints ?? exportLimit());
  let points = allPoints;
  if (points.length > maxPoints) {
    points = points.slice(points.length - maxPoints);
    warnings.push(
      `Only the newest ${num(maxPoints)} of ${num(allPoints.length)} history rows are in the file (EXPORT_LIMIT).`,
    );
  }

  const buildBundle = (rows: typeof points): ExportBundle => ({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    app: 'Wing Bank KHR/USD tracker',
    exportedAt: new Date(opts.now ?? Date.now()).toISOString(),
    source: { kind: store.kind, label: store.label },
    counts: { history: rows.length, alerts: format === 'csv' ? 0 : allAlerts.length },
    // Normalised key order (t, bid, ask) so two exports of the same data are
    // byte-identical no matter which backend produced the rows.
    history: rows.map((p) => ({ t: p.t, bid: p.bid, ask: p.ask })),
    alerts:
      format === 'csv'
        ? []
        : allAlerts.map((a) => ({
            source: a.source === 'bot' ? ('bot' as const) : ('web' as const),
            webhookUrl: a.webhookUrl ?? null,
            chatId: a.chatId ?? null,
            botToken: a.botToken ?? null,
            condition: a.condition,
            targetRate: a.targetRate ?? null,
            customMessage: a.customMessage ?? null,
            active: a.active !== false,
            createdAt: a.createdAt,
            lastAlertAt: a.lastAlertAt ?? null,
          })),
    truncated: rows.length < allPoints.length,
  });

  // Encode, and shrink (oldest rows first) until the upload fits.
  let bundle = buildBundle(points);
  let text = encodeExport(bundle, format);
  for (let i = 0; i < 16 && Buffer.byteLength(text, 'utf8') > exportMaxBytes() && points.length > 1; i++) {
    points = points.slice(Math.ceil(points.length / 2));
    bundle = buildBundle(points);
    text = encodeExport(bundle, format);
    warnings.push(
      `Older rows were dropped: the file had to fit Telegram's ${humanBytes(exportMaxBytes())} upload limit (set EXPORT_MAX_MB to change it).`,
    );
  }

  return {
    bundle,
    format,
    filename: exportFilename(format, opts.now),
    mimeType: mimeFor(format),
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    warnings,
  };
}

/** The caption attached to an export file. Kept well under Telegram's 1024 limit. */
function exportCaption(built: BuiltExport, scope: ExportScope): string {
  const facts = exportFacts(built.bundle);
  const lines = [
    `📤 <b>Database export</b> — ${built.format.toUpperCase()}`,
    `🎯 ${esc(built.bundle.source.label)}`,
  ];
  if (scope !== 'alerts') {
    lines.push(`🗂 ${num(facts.historyRows)} history row${facts.historyRows === 1 ? '' : 's'}${facts.range ? ` · ${facts.range} (UTC)` : ''}`);
  }
  if (scope !== 'history') {
    lines.push(
      built.format === 'csv'
        ? '🔔 CSV holds history only — use JSON for alerts'
        : `🔔 ${num(facts.alerts)} alert${facts.alerts === 1 ? '' : 's'}`,
    );
  }
  if (built.bundle.truncated) lines.push('⚠️ Truncated — older rows are not in this file');
  if (facts.secrets) lines.push('🔐 Contains alert credentials (chat ids / tokens) — keep it private');
  lines.push('', `Read it back with /import (${built.format === 'csv' ? 'history only' : 'history + alerts'}).`);
  return lines.join('\n');
}

function exportKeyboard(): InlineKeyboard {
  return [
    [{ text: '📥 Import a file', callback_data: 'exp:import' }, { text: '📤 Export options', callback_data: 'exp:menu' }],
    [
      { text: '🗄 Database menu', callback_data: 'db:menu' },
      { text: '✖️ Close', callback_data: 'db:close' },
    ],
  ];
}

/** `/export [json|csv] [all|history|alerts]` */
async function runExport(ctx: BotContext, args: string[]): Promise<void> {
  const parsed = parseExportArgs(args);
  if ('error' in parsed) {
    await present(ctx, `⚠️ ${esc(parsed.error)}\n\n${exportHelpText()}`, exportMenuKeyboard());
    return;
  }

  const progress = await sendTelegramMessage(ctx.token, ctx.chatId, '📤 <b>Building the export…</b>', { silent: true });
  let built: BuiltExport;
  try {
    built = await buildExportFile(parsed);
  } catch (e) {
    const text = `❌ <b>Export failed</b>\n\n<code>${esc(redactError(errDetail(e)))}</code>`;
    if (progress.success && progress.messageId) {
      const edited = await editTelegramMessage(ctx.token, ctx.chatId, progress.messageId, text, {
        keyboard: exportMenuKeyboard(),
      });
      if (edited.success) return;
    }
    await present(ctx, text, exportMenuKeyboard());
    return;
  }

  const sent = await sendTelegramDocument(
    ctx.token,
    ctx.chatId,
    { filename: built.filename, content: built.text, mimeType: built.mimeType },
    { caption: exportCaption(built, parsed.scope ?? 'all'), keyboard: exportKeyboard() },
  );

  const empty = built.bundle.counts.history === 0 && built.bundle.counts.alerts === 0;
  const lines = sent.success
    ? [
        '✅ <b>Export sent</b>',
        '',
        `📄 <code>${esc(built.filename)}</code> · ${humanBytes(built.bytes)}`,
        `🗂 ${num(built.bundle.counts.history)} history rows · 🔔 ${num(built.bundle.counts.alerts)} alerts`,
        ...built.warnings.map((w) => `⚠️ ${esc(w)}`),
        ...(empty ? ['⚠️ This database is empty — the file has nothing to restore.'] : []),
        '',
        'Import it with /import, or open the CSV in a spreadsheet.',
      ]
    : ['❌ <b>Could not send the file</b>', '', `<code>${esc(redactError(sent.error ?? 'unknown error'))}</code>`];

  const text = lines.join('\n');
  const keyboard = exportKeyboard();
  if (progress.success && progress.messageId) {
    const edited = await editTelegramMessage(ctx.token, ctx.chatId, progress.messageId, text, { keyboard });
    if (edited.success) return;
  }
  await present(ctx, text, keyboard);
}

/** `/export` arguments: a format, a scope, or nothing at all. */
function parseExportArgs(args: string[]): { format: ExportFormat; scope: ExportScope } | { error: string } {
  let format: ExportFormat = 'json';
  let scope: ExportScope = 'all';
  for (const raw of args) {
    const arg = raw.toLowerCase().replace(/^--/, '').replace(/^format=/, '');
    if (['json', 'js'].includes(arg)) format = 'json';
    else if (['csv', 'excel', 'xls', 'sheet', 'spreadsheet'].includes(arg)) format = 'csv';
    else if (['all', 'both', 'everything'].includes(arg)) scope = 'all';
    else if (['history', 'rates', 'ticks', 'prices'].includes(arg)) scope = 'history';
    else if (['alerts', 'subs', 'subscriptions'].includes(arg)) scope = 'alerts';
    else if (arg && arg !== 'export') return { error: `Unknown option “${raw}”.` };
  }
  if (format === 'csv' && scope === 'alerts') {
    return { error: 'CSV holds history only — use /export json alerts for alerts.' };
  }
  return { format, scope };
}

function exportMenuKeyboard(): InlineKeyboard {
  return [
    [{ text: '📄 JSON (history + alerts)', callback_data: 'exp:format:json' }],
    [{ text: '📊 CSV (history only)', callback_data: 'exp:format:csv' }],
    [{ text: '📥 Import a file', callback_data: 'exp:import' }],
    [
      { text: '🗄 Database menu', callback_data: 'db:menu' },
      { text: '✖️ Close', callback_data: 'db:close' },
    ],
  ];
}

/** Status card for the 📤 menu: what an export/import would touch. */
async function exportMenuText(): Promise<string> {
  const status = await storeStatus();
  const store = await getStoreOrMemory();
  const [stats, alerts] = await Promise.all([store.stats().catch(() => null), store.listAlerts().catch(() => [])]);
  const rawRows = stats?.rows ?? stats?.count;
  const rows = typeof rawRows === 'number' ? num(rawRows) : 'unknown';
  return (
    '📤📥 <b>Export &amp; import</b>\n\n' +
    'Export writes the database to a file you keep outside the app — a backup, a spreadsheet, or something to move to another deployment. ' +
    'Import reads such a file back into the <b>connected</b> database.\n\n' +
    `🎯 <b>Database:</b> ${esc(status.activeLabel)} (${esc(status.source)})\n` +
    `📊 <b>Stored:</b> ${rows} rows · ${num(alerts.length)} alerts\n` +
    `📥 <b>Import limit:</b> ${humanBytes(importMaxBytes())}\n\n` +
    '<i>JSON keeps history + alerts and is what /import expects. CSV is history only, for spreadsheets.</i>'
  );
}

const exportHelpText = () =>
  '📤 <b>Export</b>\n' +
  '<code>/export</code> — JSON with history + alerts\n' +
  '<code>/export csv</code> — spreadsheet of the history\n' +
  '<code>/export json alerts</code> — alerts only\n\n' +
  '📥 <b>Import</b>\n' +
  '<code>/import</code> — import a file you send (or reply <code>/import</code> to one)';

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Does this file look like something `/import` should read? */
function looksLikeImportFile(doc: BotDocumentRef): boolean {
  const name = (doc.fileName ?? '').toLowerCase();
  if (/\.(json|jsonl|csv|tsv|txt)$/.test(name)) return true;
  const mime = (doc.mimeType ?? '').toLowerCase();
  return ['application/json', 'text/json', 'text/csv', 'application/csv', 'text/plain', 'text/comma-separated-values'].includes(mime);
}

/** `/export` or `/import` in a caption (also accepts the command with @BotName). */
function captionIntent(caption: string): 'export' | 'import' | null {
  const first = (caption.trim().split(/\s+/)[0] ?? '').toLowerCase().split('@')[0];
  if (EXPORT_COMMANDS.includes(first)) return 'export';
  if (IMPORT_COMMANDS.includes(first)) return 'import';
  return null;
}

const importInstructions = () =>
  '📥 <b>Import a database export</b>\n\n' +
  '1. Send the file here as a <b>document</b> — a JSON export from this bot, or a CSV with a <code>t,bid,ask</code> (or timestamp) column.\n' +
  '2. I read it, show what it holds, and ask whether to <b>merge</b> or <b>replace</b>.\n\n' +
  `You can also reply <code>/import</code> to a file that is already in this chat. Maximum size: ${humanBytes(importMaxBytes())}.\n\n` +
  '🔒 Only the bot owner can import, and nothing is written before you confirm on the preview card.\n' +
  '📤 Send <code>/export</code> first if you just want to see the format.';

function importKeyboard(): InlineKeyboard {
  return [
    [{ text: '📤 Export instead', callback_data: 'exp:menu' }],
    [
      { text: '🗄 Database menu', callback_data: 'db:menu' },
      { text: '✖️ Close', callback_data: 'db:close' },
    ],
  ];
}

/** Download + parse a document the user sent, then show the confirmation card. */
async function previewImport(ctx: BotContext, doc: BotDocumentRef, msg: BotFileMessage): Promise<void> {
  const filename = doc.fileName ?? 'file';
  const progress = await sendTelegramMessage(
    ctx.token,
    ctx.chatId,
    `📥 <b>Reading ${esc(filename)}…</b>` + (doc.fileSize ? `\n${humanBytes(doc.fileSize)}` : ''),
    { silent: true },
  );

  const fail = async (text: string) => {
    if (progress.success && progress.messageId) {
      const edited = await editTelegramMessage(ctx.token, ctx.chatId, progress.messageId, text, {
        keyboard: importKeyboard(),
      });
      if (edited.success) return;
    }
    await present(ctx, text, importKeyboard());
  };

  if (doc.fileSize !== null && doc.fileSize > importMaxBytes()) {
    await fail(
      `❌ <b>File too large</b>\n\n${esc(filename)} is ${humanBytes(doc.fileSize)} — the import limit is ${humanBytes(importMaxBytes())}.\n\n` +
        'Export in CSV (history only), split the data, or raise <code>IMPORT_MAX_MB</code> (Telegram caps downloads at 20 MB).',
    );
    return;
  }

  const download = await downloadTelegramFile(ctx.token, doc.fileId, { maxBytes: importMaxBytes() });
  if (!download.success || !download.bytes) {
    await fail(`❌ <b>Could not download the file</b>\n\n<code>${esc(redactError(download.error ?? 'unknown error'))}</code>`);
    return;
  }
  if (download.bytes.includes(0)) {
    await fail(`❌ <b>${esc(filename)} is not a text file</b>\n\nSend the JSON or CSV file that <code>/export</code> produced.`);
    return;
  }

  const parsed = parseExportFile(new TextDecoder('utf-8').decode(download.bytes), { filename });
  if (!parsed.ok) {
    await fail(
      `❌ <b>This file cannot be imported</b>\n\n<code>${esc(redactError(parsed.error ?? 'unknown format'))}</code>\n\n` +
        'Accepted: a JSON export from <code>/export</code>, a JSON array of <code>{t,bid,ask}</code> rows, ' +
        'or a CSV with a <code>t,bid,ask</code> (or timestamp) header.',
    );
    return;
  }

  const pending = rememberImport({
    chatId: ctx.chatId,
    filename,
    bytes: download.bytes.byteLength,
    bundle: parsed.bundle,
    warnings: parsed.warnings,
    // The file's own message: the one it was sent in, or the one it was replied to.
    docMessageId: (msg.document ? msg.messageId : msg.replyMessageId) ?? null,
  });

  const text = await importPreviewText(ctx.chatId, pending, parsed.format);
  if (progress.success && progress.messageId) {
    const edited = await editTelegramMessage(ctx.token, ctx.chatId, progress.messageId, text, {
      keyboard: importPreviewKeyboard(pending, parsed.bundle.alerts.length > 0),
    });
    if (edited.success) return;
  }
  await present(ctx, text, importPreviewKeyboard(pending, parsed.bundle.alerts.length > 0));
}

/** "what is in the file, and what would happen to the database" card. */
async function importPreviewText(chatId: string, pending: PendingImport, format: ExportFormat): Promise<string> {
  const facts = exportFacts(pending.bundle);
  const status = await storeStatus();
  const stored = typeof status.stats?.rows === 'number' ? num(status.stats.rows as number) : null;

  const lines = [
    '📥 <b>Ready to import</b>',
    '',
    `📄 <code>${esc(pending.filename)}</code> · ${humanBytes(pending.bytes)} · ${format.toUpperCase()}`,
  ];
  if (facts.historyRows) {
    lines.push(`🗂 <b>History:</b> ${num(facts.historyRows)} rows${facts.range ? ` · ${facts.range} (UTC)` : ''}`);
  }
  if (facts.alerts) lines.push(`🔔 <b>Alerts:</b> ${num(facts.alerts)} subscription${facts.alerts === 1 ? '' : 's'}`);
  lines.push(`🎯 <b>Into:</b> ${esc(status.activeLabel)} (${esc(status.source)})${stored ? ` — ${stored} rows stored now` : ''}`);
  if (facts.secrets) lines.push('🔐 The file carries alert credentials (chat ids / tokens).');
  for (const warning of pending.warnings.slice(0, 4)) lines.push(`⚠️ ${esc(warning)}`);
  if (!status.persistent) {
    lines.push('⚠️ This database is not persistent — an import is lost when the server restarts.');
  }
  lines.push('', '<b>Nothing has been written yet.</b> How should it be imported?');
  lines.push('• <b>Merge</b> adds what is missing and keeps everything already stored (safe to repeat).');
  lines.push(
    `• <b>Replace</b> erases this database's history${facts.alerts ? ' and alerts' : ''} first, then writes the file.`,
  );
  return lines.join('\n');
}

function importPreviewKeyboard(pending: PendingImport, hasAlerts: boolean): InlineKeyboard {
  return [
    [{ text: '⬇️ Merge import (keeps existing data)', callback_data: `exp:imp:${pending.id}:merge` }],
    [
      {
        text: hasAlerts ? '♻️ Replace history + alerts' : '♻️ Replace history',
        callback_data: `exp:imp:${pending.id}:replace`,
      },
    ],
    [{ text: '✖️ Cancel', callback_data: `exp:imp:${pending.id}:cancel` }],
  ];
}

function replaceConfirmKeyboard(pending: PendingImport, hasAlerts: boolean): InlineKeyboard {
  return [
    [{ text: '♻️ Yes, replace everything', callback_data: `exp:imp:${pending.id}:replace2` }],
    [{ text: '⬅️ Back', callback_data: `exp:imp:${pending.id}:back` }],
  ];
}

/**
 * Write a parsed bundle into a store through the shared copy pipeline.
 * Exported so the guarantees (idempotency, replace refusal, count reporting)
 * can be exercised without Telegram.
 */
export async function importBundle(
  store: RateStore,
  bundle: ExportBundle,
  mode: 'merge' | 'replace',
  opts: { dryRun?: boolean } = {},
): Promise<TransferResult> {
  const source = new ExportFileStore(bundle, `📄 ${bundle.counts.history.toLocaleString()} rows from the file`);
  return transferStore(source, store, {
    mode,
    history: bundle.counts.history > 0,
    // Only touch alerts when the file actually carries them — "replace" must not
    // silently delete subscriptions an export without alerts knows nothing about.
    alerts: bundle.counts.alerts > 0,
    limit: Math.max(1, bundle.history.length),
    dryRun: opts.dryRun,
  });
}

/** Run the import and render the outcome. */
async function runImport(ctx: BotContext, pending: PendingImport, mode: 'merge' | 'replace'): Promise<void> {
  const progress = await sendTelegramMessage(
    ctx.token,
    ctx.chatId,
    mode === 'replace' ? '♻️ <b>Replacing the database…</b>' : '⬇️ <b>Importing…</b>',
    { silent: true },
  );

  let result: TransferResult;
  try {
    const store = await getStoreOrMemory();
    result = await importBundle(store, pending.bundle, mode);
  } catch (e) {
    result = {
      ok: false,
      dryRun: false,
      mode,
      ms: 0,
      source: { kind: 'memory', label: 'file' },
      target: { kind: 'memory', label: 'database' },
      history: null,
      alerts: null,
      warnings: [],
      error: errDetail(e),
    };
  }

  const facts = exportFacts(pending.bundle);
  const lines: string[] = [];
  if (result.ok) {
    const rows = (n: number) => `${num(n)} history row${n === 1 ? '' : 's'}`;
    lines.push('✅ <b>Import complete</b>', '');
    lines.push(`📄 <code>${esc(pending.filename)}</code> → ${esc(result.target.label)}`);
    if (result.history) {
      const h = result.history;
      lines.push(
        mode === 'replace'
          ? `🧬 ${rows(h.copied)} written — the database was replaced`
          : `🧬 ${rows(h.copied)} copied${h.skipped ? ` · ${num(h.skipped)} already there` : ''}`,
      );
    }
    if (result.history && facts.historyRows && result.history.copied === 0 && result.history.skipped > 0 && mode === 'merge') {
      lines.push('♻️ Everything in the file was already in the database — nothing changed.');
    }
    if (result.alerts) {
      lines.push(
        `🔔 Alerts: ${num(result.alerts.copied)} added` +
          (result.alerts.updated ? ` · ${num(result.alerts.updated)} updated` : '') +
          (result.alerts.skipped ? ` · ${num(result.alerts.skipped)} already there` : ''),
      );
    }
    lines.push(`⏱ ${num(result.ms)} ms`);
  } else {
    lines.push('❌ <b>Import failed</b>', '');
    lines.push(`<code>${esc(redactError(result.error ?? 'unknown error'))}</code>`);
    if (mode === 'replace') lines.push('', 'If the backend cannot erase its own data, use the merge import instead.');
  }
  for (const warning of result.warnings.slice(0, 4)) lines.push(`⚠️ ${esc(warning)}`);

  const keyboard: InlineKeyboard = [
    [{ text: '📤 Export', callback_data: 'exp:menu' }],
    [
      { text: '🗄 Database menu', callback_data: 'db:menu' },
      { text: '✖️ Close', callback_data: 'db:close' },
    ],
  ];
  if (facts.secrets && pending.docMessageId) {
    keyboard.unshift([{ text: '🧹 Delete the file message', callback_data: `exp:scrub:${pending.docMessageId}` }]);
  }

  const text = lines.join('\n');
  if (progress.success && progress.messageId) {
    const edited = await editTelegramMessage(ctx.token, ctx.chatId, progress.messageId, text, { keyboard });
    if (edited.success) return;
  }
  await present(ctx, text, keyboard);
}

// ---------------------------------------------------------------------------
// Entry points used by the webhook
// ---------------------------------------------------------------------------

/**
 * `/export …` and `/import …` (also as the caption of a file message).
 * Returns false when the text is not one of ours.
 */
export async function handleExportImportCommand(
  ctx: BotContext,
  text: string,
  msg: BotFileMessage = {},
): Promise<boolean> {
  const tokens = text.trim().split(/\s+/);
  const cmd = (tokens[0] ?? '').toLowerCase().split('@')[0];
  const isExport = EXPORT_COMMANDS.includes(cmd);
  const isImport = IMPORT_COMMANDS.includes(cmd);
  if (!isExport && !isImport) return false;

  const auth = await authorizeDatabaseChat(ctx.chatId);
  if (!auth.ok) {
    await sendTelegramMessage(
      ctx.token,
      ctx.chatId,
      `🔒 Only the bot owner can export or import the database. You are chat <code>${esc(ctx.chatId)}</code>; ` +
        `the configured owner is <code>${esc(auth.admin ?? 'unknown')}</code>.`,
    );
    return true;
  }

  if (isExport) {
    await runExport(ctx, tokens.slice(1));
    return true;
  }

  const doc = msg.document ?? msg.replyDocument ?? null;
  if (!doc) {
    await present(ctx, importInstructions(), importKeyboard());
    return true;
  }
  await previewImport(ctx, doc, msg);
  return true;
}

/**
 * A file sent to the bot without any command — `.json`/`.csv` documents are
 * treated as a possible import and answered with the preview card. Anything
 * else is left alone (returns false). The owner confirms before anything is
 * written, so reading a stray file is harmless.
 */
export async function handleExportImportFile(
  ctx: BotContext,
  msg: BotFileMessage,
  opts: { caption?: string } = {},
): Promise<boolean> {
  const doc = msg.document ?? msg.replyDocument;
  if (!doc) return false;

  const intent = captionIntent(opts.caption ?? '');
  const plausible = looksLikeImportFile(doc);
  if (!plausible) {
    if (intent === 'import') {
      await present(
        ctx,
        `❌ <b>${esc(doc.fileName ?? 'That file')}</b> is not a JSON or CSV file.\n\n${importInstructions()}`,
        importKeyboard(),
      );
      return true;
    }
    return false;
  }

  const auth = await authorizeDatabaseChat(ctx.chatId);
  if (!auth.ok) {
    // Silence on an unprompted file, a clear answer when the owner-only rule
    // was actually invoked with /import.
    if (intent === 'import') {
      await sendTelegramMessage(
        ctx.token,
        ctx.chatId,
        `🔒 Only the bot owner can import the database. You are chat <code>${esc(ctx.chatId)}</code>.`,
      );
      return true;
    }
    return false;
  }

  await previewImport(ctx, doc, msg);
  return true;
}

/** Inline button taps: `exp:*`. */
export async function handleExportImportCallback(
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

  if (data === 'exp:menu') {
    await answerCallbackQuery(ctx.token, callbackId);
    await present(ctx, await exportMenuText(), exportMenuKeyboard(), messageId);
    return;
  }

  if (data === 'exp:import') {
    await answerCallbackQuery(ctx.token, callbackId);
    await present(ctx, importInstructions(), importKeyboard(), messageId);
    return;
  }

  if (data.startsWith('exp:format:')) {
    const format: ExportFormat = data.endsWith(':csv') ? 'csv' : 'json';
    await answerCallbackQuery(ctx.token, callbackId, { text: format === 'csv' ? 'Building the CSV…' : 'Building the export…' });
    await runExport(ctx, [format]);
    return;
  }

  if (data.startsWith('exp:scrub:')) {
    const docMessageId = Number(data.slice('exp:scrub:'.length));
    const removed = Number.isFinite(docMessageId)
      ? await deleteTelegramMessage(ctx.token, ctx.chatId, docMessageId)
      : { success: false, error: 'no message id' };
    await answerCallbackQuery(ctx.token, callbackId, {
      text: removed.success ? 'File message deleted.' : 'Telegram would not let me delete it.',
      showAlert: !removed.success,
    });
    if (removed.success) {
      await present(
        ctx,
        '🧹 <b>File message deleted.</b> The import is done — the chat no longer holds a copy of the file.',
        [
          [{ text: '📤 Export', callback_data: 'exp:menu' }],
          [{ text: '🗄 Database menu', callback_data: 'db:menu' }],
        ],
        messageId,
      );
    }
    return;
  }

  if (data.startsWith('exp:imp:')) {
    const [, , id, action = ''] = data.split(':');
    const pending = takeImport(ctx.chatId, id);
    if (!pending) {
      await answerCallbackQuery(ctx.token, callbackId, { text: '⌛️ This import expired — send the file again.', showAlert: true });
      await present(ctx, '⌛️ <b>This import is no longer available.</b>\n\nSend the file again (or reply <code>/import</code> to it) and I will show the preview once more.', importKeyboard(), messageId);
      return;
    }

    if (action === 'cancel') {
      pendingImports().delete(id);
      await answerCallbackQuery(ctx.token, callbackId, { text: 'Import cancelled.' });
      await present(
        ctx,
        `✖️ <b>Import cancelled</b> — nothing was written.\n\n📄 <code>${esc(pending.filename)}</code> is still in this chat if you change your mind.`,
        importKeyboard(),
        messageId,
      );
      return;
    }

    if (action === 'replace' || action === 'replace2') {
      if (action === 'replace') {
        await answerCallbackQuery(ctx.token, callbackId);
        await present(
          ctx,
          '⚠️ <b>Replace the stored data?</b>\n\n' +
            `Everything currently in <b>${esc((await storeStatus()).activeLabel)}</b> is erased first: ` +
            `the whole price history${pending.bundle.alerts.length ? ' and every alert subscription' : ''}. ` +
            'The file then becomes the database.\n\n' +
            '<i>Merge is almost always what you want — it keeps existing rows.</i>',
          replaceConfirmKeyboard(pending, pending.bundle.alerts.length > 0),
          messageId,
        );
        return;
      }
      await answerCallbackQuery(ctx.token, callbackId, { text: 'Replacing…' });
      await runImport(ctx, pending, 'replace');
      return;
    }

    if (action === 'back') {
      await answerCallbackQuery(ctx.token, callbackId);
      const format: ExportFormat = pending.filename.toLowerCase().endsWith('.csv') ? 'csv' : 'json';
      await present(ctx, await importPreviewText(ctx.chatId, pending, format), importPreviewKeyboard(pending, pending.bundle.alerts.length > 0), messageId);
      return;
    }

    await answerCallbackQuery(ctx.token, callbackId, { text: 'Importing…' });
    await runImport(ctx, pending, 'merge');
    return;
  }

  await answerCallbackQuery(ctx.token, callbackId, { text: 'Unknown action.' });
}

/** Extra /help lines for export &amp; import. */
export const EXPORT_HELP =
  '<b>Export &amp; import</b>\n' +
  '• /export — 📤 send the database to this chat as a file (JSON: history + alerts)\n' +
  '• /export csv — history only, for a spreadsheet\n' +
  '• /import — 📥 send (or reply with) an export file to restore it\n' +
  '   <i>the 2nd tap on the preview card chooses merge (keeps data) or replace (erases first)</i>';
