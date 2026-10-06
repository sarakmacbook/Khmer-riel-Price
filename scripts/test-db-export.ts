/**
 * Integration checks for the 📤📥 export/import feature (Telegram `/export` and
 * `/import`).
 *
 * The tests run the real code paths:
 *   • the file format (`encodeExport` → `parseExportFile` round trips, tolerant
 *     JSON/CSV reading, limits),
 *   • the import copy (`importBundle` → `transferStore`, so idempotency and
 *     replace semantics are the same as the backup feature),
 *   • and the whole Telegram conversation — `/export`, a user uploading the file
 *     back, the preview card, the Merge/Replace buttons — against a local fake
 *     Bot API that speaks the same HTTP as Telegram (multipart upload, getFile,
 *     file download, callback queries, message edits).
 *
 *   npm run test:export        (or: npx tsx scripts/test-db-export.ts)
 */

import http from 'node:http';
import { MemoryStore } from '../src/lib/store/memory';
import { memoryStore } from '../src/lib/store';
import type {
  AlertInput,
  AlertRecord,
  Point,
  RateStore,
  RecordResult,
} from '../src/lib/store/types';

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// A fake Telegram Bot API
//
// Records every message the bot would send, keeps uploaded documents so the bot
// can download them again, and answers the JSON methods the flow uses.
// ---------------------------------------------------------------------------

process.env.TELEGRAM_ADMIN_CHAT_ID = '4242';

interface WireMessage {
  method: string;
  chatId: string | null;
  text: string | null;
  caption: string | null;
  keyboard: Keyboard | null;
  messageId: number;
}

interface Keyboard {
  inline_keyboard: { text: string; callback_data?: string }[][];
}

interface FakeTelegram {
  /** Everything the bot sent (sendMessage / editMessageText / sendDocument). */
  wire: WireMessage[];
  /** Uploaded files, by the file id `getFile` later hands back. */
  files: Map<string, Buffer>;
  /** The documents the bot uploaded, oldest first. */
  uploads: { filename: string; content: Buffer; caption: string | null }[];
  /** The most recent message the bot sent, optionally filtered by text. */
  lastMatching: (needle: string) => WireMessage | undefined;
  /** Callback data of the button whose label matches, from the last keyboard. */
  button: (label: string) => string | undefined;
  close: () => Promise<void>;
}

/** Minimal `multipart/form-data` reader: enough to see the uploaded document. */
function parseMultipart(body: Buffer, contentType: string): { fields: Map<string, string>; filename: string | null; content: Buffer } {
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1];
  const fields = new Map<string, string>();
  let filename: string | null = null;
  let content = Buffer.alloc(0);
  if (!boundary) return { fields, filename, content };

  for (const part of body.toString('latin1').split(`--${boundary}`)) {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const headers = part.slice(0, split);
    const raw = part.slice(split + 4);
    const value = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw;
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (!name) continue;
    const file = /filename="([^"]*)"/.exec(headers)?.[1];
    if (file !== undefined) {
      filename = file;
      content = Buffer.from(value, 'latin1');
    } else {
      fields.set(name, Buffer.from(value, 'latin1').toString('utf8'));
    }
  }
  return { fields, filename, content };
}

async function startFakeTelegram(): Promise<FakeTelegram> {
  const wire: WireMessage[] = [];
  const files = new Map<string, Buffer>();
  const uploads: { filename: string; content: Buffer; caption: string | null; chatId: string | null; keyboard: Keyboard | null }[] = [];
  let nextMessageId = 100;

  const record = (message: WireMessage) => {
    wire.push(message);
    return { ok: true, result: { message_id: message.messageId } };
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '';
      const contentType = String(req.headers['content-type'] ?? '');
      const json = (payload: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // GET /file/bot<token>/<file_path> — the actual file download.
      if (url.includes('/file/bot')) {
        const id = url.split('/').pop() ?? '';
        const bytes = files.get(id);
        if (!bytes) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) });
        res.end(bytes);
        return;
      }

      const method = url.split('/').pop() ?? '';
      if (contentType.includes('multipart/form-data')) {
        const { fields, filename, content } = parseMultipart(body, contentType);
        const chatId = fields.get('chat_id') ?? null;
        const keyboard = fields.get('reply_markup') ? (JSON.parse(fields.get('reply_markup')!) as Keyboard) : null;
        const caption = fields.get('caption') ?? null;
        const fileId = `file-${files.size + 1}`;
        files.set(fileId, content);
        uploads.push({ filename: filename ?? '', content, caption, chatId, keyboard });
        json(record({ method: 'sendDocument', chatId, text: null, caption, keyboard, messageId: nextMessageId++ }));
        return;
      }

      const payload = body.length ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>) : {};
      if (method === 'sendMessage' || method === 'editMessageText') {
        const raw = payload.reply_markup as Keyboard | undefined;
        json(
          record({
            method,
            chatId: payload.chat_id !== undefined ? String(payload.chat_id) : null,
            text: typeof payload.text === 'string' ? payload.text : null,
            caption: null,
            keyboard: raw ? (typeof raw === 'string' ? (JSON.parse(raw) as Keyboard) : raw) : null,
            messageId: typeof payload.message_id === 'number' ? payload.message_id : nextMessageId++,
          }),
        );
        return;
      }
      if (method === 'getFile') {
        const id = String(payload.file_id);
        const bytes = files.get(id);
        json({
          ok: true,
          result: { file_id: id, file_unique_id: id, file_size: bytes?.byteLength ?? 0, file_path: `docs/${id}` },
        });
        return;
      }
      // answerCallbackQuery, deleteMessage, setWebhook, … — always fine.
      json({ ok: true, result: true });
    });
  });

  // An ephemeral port, so the checks never clash with a dev server.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  // Must be set before telegram.ts is imported — it reads the base URL on load.
  process.env.TELEGRAM_API_URL = `http://127.0.0.1:${port}`;

  return {
    wire,
    files,
    uploads,
    lastMatching: (needle) => [...wire].reverse().find((m) => (m.text ?? '').includes(needle)),
    button: (label) => {
      for (let i = wire.length - 1; i >= 0; i--) {
        const found = wire[i].keyboard?.inline_keyboard.flat().find((b) => b.text.includes(label));
        if (found?.callback_data) return found.callback_data;
      }
      return undefined;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5, 3, 0, 0);

const points = (count: number, start = T0): Point[] =>
  Array.from({ length: count }, (_, i) => ({ t: start + i * HOUR, bid: 4000 + i * 5, ask: 4020 + i * 5 }));

const botAlert = (chatId: string): AlertInput => ({
  source: 'bot',
  webhookUrl: null,
  chatId,
  botToken: null,
  condition: 'change',
  targetRate: null,
  customMessage: null,
  active: true,
  lastAlertAt: null,
});

const webAlert: AlertInput = {
  source: 'web',
  webhookUrl: 'https://example.com/hook',
  chatId: null,
  botToken: '123456:AA-secret-token',
  condition: 'above',
  targetRate: 4100,
  customMessage: 'Wing: {bid}',
  active: true,
  lastAlertAt: T0,
};

/** A backend that cannot erase its own data (no `wipe`/`backfill`). */
class PlainTarget implements RateStore {
  readonly kind = 'memory' as const;
  readonly label = 'no-wipe backend';
  readonly persistent = true;
  readonly readTtlMs = 0;
  rows: Point[] = [];
  async init() {}
  async latest() {
    const last = this.rows[this.rows.length - 1];
    return last ? { ...last, c: last.t } : null;
  }
  async record(_q: { bid: number; ask: number }, _now: number): Promise<RecordResult> {
    throw new Error('not used');
  }
  async claimRefresh() {
    return false;
  }
  async range(since: number) {
    return this.rows.filter((p) => p.t >= since).map((p) => ({ ...p }));
  }
  async before(ts: number) {
    const found = [...this.rows].reverse().find((p) => p.t < ts);
    return found ? { ...found } : null;
  }
  async daily() {
    return [] as Point[];
  }
  async listAlerts(): Promise<AlertRecord[]> {
    return [];
  }
  async saveAlert(_a: AlertInput): Promise<AlertRecord> {
    throw new Error('not used');
  }
  async stats() {
    return { rows: this.rows.length };
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const api = await startFakeTelegram();

  // Imported AFTER the fake API URL is in the environment: telegram.ts reads it
  // at load time.
  const ef = await import('../src/lib/export-file');
  const bot = await import('../src/lib/bot-export');

  const ctx = { token: '123:TEST', chatId: '4242' };
  const other = { token: '123:TEST', chatId: '9999' };
  const store = memoryStore(); // the store getStoreOrMemory() resolves to here
  await store.init();

  // =========================================================================
  section('1. File format — JSON round trip');
  // =========================================================================

  await store.wipe({ history: true, alerts: true });
  await store.backfill(points(5));
  await store.saveAlert(botAlert('4242'));
  await store.saveAlert(webAlert);

  const built = await bot.buildExportFile({ store });
  check('export is JSON with every row', built.format === 'json' && built.bundle.counts.history === 5, built.bundle.counts);
  check('export carries both alerts', built.bundle.counts.alerts === 2, built.bundle.counts);
  check('filename is descriptive', /^wingrate-export-\d{8}-\d{4}\.json$/.test(built.filename), built.filename);

  const roundTrip = ef.parseExportFile(built.text, { filename: built.filename });
  check('the file parses back', roundTrip.ok, roundTrip.error);
  check('history survives the round trip', JSON.stringify(roundTrip.bundle.history) === JSON.stringify(built.bundle.history));
  check('alerts survive the round trip', roundTrip.bundle.alerts.length === 2);
  check('the export marker is in the file', built.text.includes('"format": "wingrate-export"'));
  check(
    're-encoding the parsed file is byte-identical',
    ef.encodeExport(roundTrip.bundle, 'json') === built.text,
  );
  check('no warnings for a clean export', built.warnings.length === 0, built.warnings);

  // =========================================================================
  section('2. File format — CSV and tolerant readers');
  // =========================================================================

  const csv = await bot.buildExportFile({ store, format: 'csv' });
  check('CSV starts with a header', csv.text.startsWith('t,iso,bid,ask\n'), csv.text.split('\n')[0]);
  check('CSV holds one line per row', csv.text.trim().split('\n').length === 6);
  const csvBack = ef.parseExportFile(csv.text, { filename: 'rates.csv' });
  check('CSV parses back', csvBack.ok && csvBack.bundle.history.length === 5, csvBack.error);
  check('CSV values are unchanged', csvBack.bundle.history[2].bid === built.bundle.history[2].bid);
  check('CSV carries no alerts', csvBack.bundle.alerts.length === 0);

  const alt = ef.parseExportFile(
    'timestamp;buy;sell\n2026-01-05T03:00:00Z;4000;4020\n2026-01-05T04:00:00Z;4100;4120\n',
    { filename: 'other-tool.csv' },
  );
  check('foreign column names are understood', alt.ok && alt.bundle.history.length === 2, alt.error);
  check('semicolon + ISO values are read', alt.bundle.history[1].bid === 4100);

  const bare = ef.parseExportFile('[\n{"t":1767582000000,"bid":4000,"ask":4020}\n]\n');
  check('a bare JSON array of rows is accepted', bare.ok && bare.bundle.history.length === 1, bare.error);

  const seconds = ef.parseExportFile(JSON.stringify({ rates: [{ timestamp: 1767582000, rate: 4050 }] }));
  check('epoch seconds and a single rate are accepted', seconds.ok && seconds.bundle.history[0].t === 1767582000000, seconds.bundle.history);
  check('a missing ask falls back to the rate', seconds.bundle.history[0]?.ask === 4050);

  const messy = ef.parseExportFile(
    JSON.stringify({
      history: [
        { t: T0, bid: 4000, ask: 4020 },
        { t: T0, bid: 4000, ask: 4020 }, // duplicate
        { t: 'yesterday', bid: 4000, ask: 4020 }, // broken time
        { t: T0 + HOUR, bid: -5, ask: 4020 }, // broken rate
      ],
      alerts: [
        { source: 'bot', chatId: '4242', condition: 'change' },
        { source: 'bot', condition: 'change' }, // no destination
        { source: 'bot', botToken: '••••••••', chatId: '777', condition: 'below', targetRate: 4000 },
      ],
    }),
  );
  check('broken rows are skipped, not fatal', messy.ok && messy.bundle.history.length === 1, messy.bundle.history);
  check('duplicates are folded', /duplicate/i.test(messy.warnings.join(' ')), messy.warnings);
  check('useless alerts are dropped', messy.bundle.alerts.length === 2, messy.bundle.alerts.length);
  check('a masked bot token never reaches the file', messy.bundle.alerts.every((a) => !a.botToken));

  const empty = ef.parseExportFile('{"history":[],"alerts":[]}');
  check('an empty file is rejected with a reason', !empty.ok && /no price history/i.test(empty.error ?? ''), empty.error);
  const junk = ef.parseExportFile('<!doctype html><h1>hello</h1>');
  check('an unrelated file is rejected', !junk.ok, junk.error);
  const broken = ef.parseExportFile('{"history": [');
  check('invalid JSON is reported, not thrown', !broken.ok && /valid JSON/i.test(broken.error ?? ''), broken.error);

  const limited = ef.collectPoints(points(10), 4);
  check('the newest rows win above EXPORT_LIMIT', limited.points.length === 4 && limited.points[0].t === T0 + 6 * HOUR);
  check('truncation is counted', limited.truncated === 6);

  process.env.EXPORT_MAX_MB = '0.001'; // ≈1 KB — the export has to shrink to fit
  const tiny = await bot.buildExportFile({ store, maxPoints: 400 });
  process.env.EXPORT_MAX_MB = '20';
  check('an oversized export is shrunk to the upload limit', tiny.bytes <= ef.exportMaxBytes() && tiny.bundle.counts.history < 5, {
    bytes: tiny.bytes,
    rows: tiny.bundle.counts.history,
  });
  check('the shrinking is reported', tiny.warnings.length > 0 && tiny.bundle.truncated, tiny.warnings);

  // =========================================================================
  section('3. Import into a database — merge, replace, idempotency');
  // =========================================================================

  const target = new MemoryStore();
  await target.backfill(points(2));
  await target.saveAlert({ ...botAlert('5555'), customMessage: 'only here' });

  const first = await bot.importBundle(target, roundTrip.bundle, 'merge');
  check('merge copies what is missing', first.ok && first.history?.copied === 3, first.history);
  check('merge leaves existing rows alone', first.history?.skipped === 2, first.history);
  check('merge adds the missing alerts', first.alerts?.copied === 2, first.alerts);
  check('merge never deletes a local alert', (await target.listAlerts()).length === 3, (await target.listAlerts()).length);
  check('history is now the union', (await target.range(0)).length === 5);

  const again = await bot.importBundle(target, roundTrip.bundle, 'merge');
  check('importing the same file twice changes nothing', again.ok && again.history?.copied === 0 && again.history?.skipped === 5, again.history);
  check('the second import also adds no alerts', again.alerts?.copied === 0 && again.alerts?.skipped === 2, again.alerts);

  const dry = await bot.importBundle(new MemoryStore(), roundTrip.bundle, 'merge', { dryRun: true });
  check('a dry run reports without writing', dry.ok && dry.history?.copied === 5, dry.history);

  const replaced = await bot.importBundle(target, roundTrip.bundle, 'replace');
  check('replace mirrors the file', replaced.ok && (await target.range(0)).length === 5, replaced.history);
  check('replace drops rows that were only local', (await target.listAlerts()).some((a) => a.customMessage === 'only here') === false);

  const noAlerts = ef.parseExportFile(csv.text, { filename: 'rates.csv' });
  const keepAlerts = await bot.importBundle(target, noAlerts.bundle, 'replace');
  check('replacing with a history-only file keeps the alerts', keepAlerts.ok && (await target.listAlerts()).length === 2, await target.listAlerts());

  const noWipe = new PlainTarget();
  noWipe.rows = points(1);
  const refused = await bot.importBundle(noWipe, roundTrip.bundle, 'replace');
  check('replace is refused when the backend cannot erase data', !refused.ok && /merge/i.test(refused.error ?? ''), refused.error);
  check('the refused replace wrote nothing', noWipe.rows.length === 1);

  // =========================================================================
  section('4. Telegram: /export sends the file');
  // =========================================================================

  await store.wipe({ history: true, alerts: true });
  await store.backfill(points(5));
  await store.saveAlert(botAlert('4242'));
  await store.saveAlert(webAlert);
  api.wire.length = 0;

  const handled = await bot.handleExportImportCommand(ctx, '/export', { messageId: 7 });
  check('/export is handled by the bot', handled);
  const upload = api.wire.find((m) => m.method === 'sendDocument');
  check('a document was uploaded', Boolean(upload));
  const uploaded = api.files.get('file-1');
  check('the uploaded file contains the data', Boolean(uploaded?.toString('utf8').includes('"wingrate-export"')));
  const uploadedBundle = ef.parseExportFile(uploaded?.toString('utf8') ?? '', { filename: 'x.json' });
  check('the uploaded file holds all rows and alerts', uploadedBundle.bundle.counts.history === 5 && uploadedBundle.bundle.counts.alerts === 2);
  check('the caption warns about credentials', /credentials/i.test(upload?.caption ?? ''), upload?.caption);
  check('the caption explains how to import', /\/import/.test(upload?.caption ?? ''));
  check('the chat gets a "Export sent" confirmation', Boolean(api.lastMatching('Export sent')));
  check('the export buttons offer Import', api.button('Import a file') === 'exp:import');

  const csvOut = await bot.handleExportImportCommand(ctx, '/export@WingRateBot csv', {});
  check('/export csv is accepted (with @BotName)', csvOut);
  check('the CSV upload is named .csv', (api.uploads[api.uploads.length - 1]?.filename ?? '').endsWith('.csv'), api.uploads.map((u) => u.filename));

  const badArg = await bot.handleExportImportCommand(ctx, '/export pdf', {});
  check('an unknown option is refused with help', badArg && /Unknown option/.test(api.wire[api.wire.length - 1]?.text ?? ''));

  const stranger = await bot.handleExportImportCommand(other, '/export', {});
  check('a stranger cannot export', stranger && /Only the bot owner/.test(api.wire[api.wire.length - 1]?.text ?? ''));

  // =========================================================================
  section('5. Telegram: /import — preview, merge, replace');
  // =========================================================================

  await store.wipe({ history: true, alerts: true });
  api.wire.length = 0;

  const fileId = 'file-1'; // the JSON export uploaded above
  const sent = await bot.handleExportImportFile(
    ctx,
    { messageId: 9, document: { fileId, fileName: 'wingrate-export-20261006-1215.json', mimeType: 'application/json', fileSize: api.files.get(fileId)?.byteLength ?? 0 } },
    {},
  );
  check('a .json document starts an import', sent);
  const preview = api.lastMatching('Ready to import');
  check('the preview card is shown', Boolean(preview), api.wire.map((m) => m.text));
  check('the preview names the file', /wingrate-export-20261006-1215\.json/.test(preview?.text ?? ''));
  check('the preview counts the rows', /5/.test(preview?.text ?? ''));
  check('the preview promises nothing was written', /Nothing has been written yet/.test(preview?.text ?? ''));
  check('nothing was written before confirming', (await store.range(0)).length === 0 && (await store.listAlerts()).length === 0);

  const mergeCb = api.button('Merge import');
  check('the merge button carries an import id', Boolean(mergeCb && /^exp:imp:[a-z0-9]+:merge$/.test(mergeCb)), mergeCb);
  await bot.handleExportImportCallback(ctx, 100, mergeCb!, 'cb-1');
  check('merge writes the history', (await store.range(0)).length === 5, (await store.range(0)).length);
  check('merge writes the alerts', (await store.listAlerts()).length === 2);
  check('the chat reports the import', /Import complete/.test(api.lastMatching('Import complete')?.text ?? ''));
  check(
    'the result offers to delete the credential-bearing file',
    api.button('Delete the file message') === 'exp:scrub:9',
    api.button('Delete the file message'),
  );

  // /import with no file explains what to send, and the 📤 menu opens.
  api.wire.length = 0;
  check('/import without a file is still handled', await bot.handleExportImportCommand(ctx, '/import', {}));
  check('the instructions explain how to send a file', /Send the file here as a/.test(api.wire.map((m) => m.text ?? '').join(' ')));
  api.wire.length = 0;
  await bot.handleExportImportCallback(ctx, 100, 'exp:menu', 'cb-menu');
  check('the 📤📥 menu shows the stored counts', /Export &amp; import/.test(api.wire.map((m) => m.text ?? '').join(' ')));
  check('the menu offers JSON and CSV', Boolean(api.button('JSON (history + alerts)') && api.button('CSV (history only)')));

  // A file with only broken content is refused before anything happens.
  const junkId = 'file-junk';
  api.files.set(junkId, Buffer.from('{"hello": "world"}'));
  api.wire.length = 0;
  const junkHandled = await bot.handleExportImportFile(
    ctx,
    { messageId: 11, document: { fileId: junkId, fileName: 'notes.json', mimeType: 'application/json', fileSize: 18 } },
    {},
  );
  check('an unrelated .json is read and refused politely', junkHandled && /cannot be imported/i.test(api.wire.map((m) => m.text ?? '').join(' ')));
  check('the refusal writes nothing', (await store.range(0)).length === 5);

  // A huge file is refused on size alone.
  process.env.IMPORT_MAX_MB = '0.002'; // ≈2 KB
  const bigId = 'file-big';
  api.files.set(bigId, Buffer.from(JSON.stringify({ history: points(400) })));
  api.wire.length = 0;
  await bot.handleExportImportFile(
    ctx,
    { messageId: 12, document: { fileId: bigId, fileName: 'big.json', mimeType: 'application/json', fileSize: 50_000 } },
    {},
  );
  process.env.IMPORT_MAX_MB = '5';
  check('an oversized file is refused with the limit', /File too large/.test(api.wire.map((m) => m.text ?? '').join(' ')));
  check('the oversized import writes nothing', (await store.range(0)).length === 5);

  // Reply-based import: /import as a reply to a file, then the Replace flow.
  api.wire.length = 0;
  const replied = await bot.handleExportImportCommand(ctx, '/import', {
    messageId: 13,
    replyDocument: { fileId, fileName: 'backup.json', mimeType: 'application/json', fileSize: 1000 },
    replyMessageId: 3,
  });
  check('/import as a reply starts the same preview', replied && Boolean(api.lastMatching('Ready to import')));
  const replaceCb = api.button('Replace');
  check('the preview offers replace', Boolean(replaceCb && /:replace$/.test(replaceCb)), replaceCb);
  await bot.handleExportImportCallback(ctx, 100, replaceCb!, 'cb-2');
  check('replace asks for a second confirmation', /Replace the stored data\?/.test(api.lastMatching('Replace the stored data?')?.text ?? ''));
  const confirmCb = api.button('Yes, replace everything');
  check('the confirmation carries the replace action', Boolean(confirmCb && /:replace2$/.test(confirmCb)), confirmCb);
  await bot.handleExportImportCallback(ctx, 100, confirmCb!, 'cb-3');
  check('the replace import runs', /Import complete/.test(api.lastMatching('Import complete')?.text ?? ''));
  check('the database matches the file', (await store.range(0)).length === 5);

  // Cancel writes nothing.
  api.wire.length = 0;
  await bot.handleExportImportFile(
    ctx,
    { messageId: 14, document: { fileId, fileName: 'backup.json', mimeType: 'application/json', fileSize: 1000 } },
    {},
  );
  const cancelCb = api.button('Cancel');
  await bot.handleExportImportCallback(ctx, 100, cancelCb!, 'cb-4');
  check('cancel leaves the database untouched', /Import cancelled/.test(api.wire.map((m) => m.text ?? '').join(' ')) && (await store.range(0)).length === 5);

  // Expired / unknown ids are answered, not crashed.
  api.wire.length = 0;
  await bot.handleExportImportCallback(ctx, 100, 'exp:imp:zzzzzz:merge', 'cb-5');
  check('an unknown import id is reported', /no longer available|expired/i.test(api.wire.map((m) => m.text ?? '').join(' ')));

  // =========================================================================
  section('6. Telegram: files and commands that are not ours');
  // =========================================================================

  api.wire.length = 0;
  check('a /rate command is not swallowed', (await bot.handleExportImportCommand(ctx, '/rate')) === false);
  check(
    'a PDF is ignored',
    (await bot.handleExportImportFile(
      ctx,
      { messageId: 15, document: { fileId: 'x', fileName: 'invoice.pdf', mimeType: 'application/pdf', fileSize: 10 } },
      {},
    )) === false,
  );
  check(
    'a PDF with /import gets a clear answer',
    (await bot.handleExportImportFile(
      ctx,
      { messageId: 16, document: { fileId: 'x', fileName: 'invoice.pdf', mimeType: 'application/pdf', fileSize: 10 } },
      { caption: '/import' },
    )) && /not a JSON or CSV file/.test(api.wire.map((m) => m.text ?? '').join(' ')),
  );
  check(
    'a stranger uploading a file is ignored silently',
    (await bot.handleExportImportFile(
      other,
      { messageId: 17, document: { fileId: 'y', fileName: 'data.json', mimeType: 'application/json', fileSize: 10 } },
      {},
    )) === false,
  );

  // =========================================================================
  section('7. Facts used by the chat cards');
  // =========================================================================

  check('the range is human readable', ef.historyRange(points(3)) === '2026-01-05', ef.historyRange(points(3)));
  check('a multi-day range shows both ends', ef.historyRange([points(1)[0], { ...points(1)[0], t: T0 + 5 * 24 * HOUR }]) === '2026-01-05 → 2026-01-10');
  check('credentials in a bundle are detected', ef.exportFacts(roundTrip.bundle).secrets === 1, ef.exportFacts(roundTrip.bundle));

  await api.close();

  // ---------------------------------------------------------------------------
  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length) {
    console.log(`❌ ${failures.length} check(s) failed out of ${passed + failures.length}:`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ all ${passed} checks passed`);
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
