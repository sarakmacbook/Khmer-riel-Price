/**
 * 📤📥 The file format behind the Telegram bot's `/export` and `/import`.
 *
 * This module is deliberately free of Telegram and database code: it only
 * encodes a database into a file and parses one back, so the exact same bytes
 * can be produced by a script, opened in a spreadsheet, or handed to another
 * deployment.
 *
 * Two formats are supported:
 *   • **JSON** — a `wingrate-export` document with `history` (price ticks) and
 *     `alerts` (Telegram subscriptions / webhook alerts). The full backup: it is
 *     what `/import` writes back.
 *   • **CSV** — history only (`t,iso,bid,ask`), for Excel / Numbers / Google
 *     Sheets. `/import` reads it back too.
 *
 * Parsing is forgiving on purpose — an import should not fail because an old
 * export, a hand-edited spreadsheet or a different backend's dump has a slightly
 * different shape. Unknown columns are ignored, broken rows are counted and
 * reported instead of aborting the whole file, and the newest rows win when a
 * file is bigger than the configured cap.
 */

import type { AlertCondition, AlertRecord, Point, StoreKind } from './store/types';

/** Marker written into every JSON export, so unrelated files are rejected early. */
export const EXPORT_FORMAT = 'wingrate-export';
export const EXPORT_VERSION = 1;

export type ExportFormat = 'json' | 'csv';

/** What part of the database an export contains. */
export type ExportScope = 'all' | 'history' | 'alerts';

/**
 * Limits, read from the environment on every call so a deployment (or a test)
 * can tune them without a rebuild.
 */
/** History rows per export file (newest win when there are more). `EXPORT_LIMIT`. */
export const exportLimit = () => Math.max(1, Number(process.env.EXPORT_LIMIT) || 50_000);
/** Keep uploads well under Telegram's 50 MB sendDocument limit. `EXPORT_MAX_MB`. */
export const exportMaxBytes = () =>
  Math.max(1024, Math.min(45 * 1024 * 1024, (Number(process.env.EXPORT_MAX_MB) || 20) * 1024 * 1024));
/** Refuse to parse anything bigger (Telegram itself caps bot downloads at 20 MB). `IMPORT_MAX_MB`. */
export const importMaxBytes = () =>
  Math.max(1024, Math.min(20 * 1024 * 1024, (Number(process.env.IMPORT_MAX_MB) || 5) * 1024 * 1024));

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/** One alert inside an export file (a plain, portable copy — no database ids). */
export interface ExportAlert {
  source: 'web' | 'bot';
  webhookUrl: string | null;
  chatId: string | null;
  botToken: string | null;
  condition: AlertCondition;
  targetRate: number | null;
  customMessage: string | null;
  active: boolean;
  createdAt: number;
  lastAlertAt: number | null;
}

export interface ExportBundle {
  /** Always `wingrate-export` — the marker `/import` looks for. */
  format: string;
  version: number;
  app: string;
  /** ISO timestamp of the export. */
  exportedAt: string;
  /** Which database (and backend) the file was written from. */
  source: { kind: StoreKind; label: string };
  counts: { history: number; alerts: number };
  /** Price ticks, ascending by time. */
  history: Point[];
  alerts: ExportAlert[];
  /** true when older rows were dropped to stay inside the size/row limits. */
  truncated: boolean;
}

/** Turns a stored alert into the portable shape written to the file. */
export function alertToFile(a: AlertRecord): ExportAlert {
  return {
    source: a.source === 'bot' ? 'bot' : 'web',
    webhookUrl: text(a.webhookUrl),
    chatId: text(a.chatId),
    botToken: secret(a.botToken),
    condition: condition(a.condition),
    targetRate: finiteNumber(a.targetRate),
    customMessage: text(a.customMessage),
    active: a.active !== false,
    createdAt: finiteNumber(a.createdAt) ?? Date.now(),
    lastAlertAt: finiteNumber(a.lastAlertAt),
  };
}

// ---------------------------------------------------------------------------
// Small coercion helpers (shared by the JSON and CSV readers)
// ---------------------------------------------------------------------------

const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};

/** A real credential — UI masks ("••••••••") are dropped, never exported/imported. */
const secret = (v: unknown): string | null => {
  const s = text(v);
  if (!s || /^[•*·.\-]+$/.test(s)) return null;
  return s;
};

function finiteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const condition = (v: unknown): AlertCondition =>
  v === 'above' || v === 'below' || v === 'change' ? v : 'change';

/** Epoch ms from a number (seconds or ms), a numeric string, or an ISO date string. */
export function parseTime(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return parseTime(Number(s));
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = finiteNumber(v);
  if (n === null || n <= 0) return null;
  // 1e11 ms ≈ 1973; anything below that is a seconds-precision timestamp.
  const ms = n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  return ms > 0 ? ms : null;
}

/** Is this a usable history row? (valid time, positive bid/ask, sane magnitude) */
const saneRate = (n: number) => Number.isFinite(n) && n > 0 && n < 1e9;
const saneTime = (t: number) => t > Date.UTC(2000, 0, 1) && t < Date.UTC(2100, 0, 1);

/** One history row out of anything: `{t,bid,ask}`, `{timestamp,rate}`, `[t,bid,ask]`, … */
function pointFromRaw(raw: unknown): Point | null {
  let t: unknown;
  let bid: unknown;
  let ask: unknown;
  let rate: unknown;

  if (Array.isArray(raw)) {
    [t, bid, ask] = raw;
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    t = o.t ?? o.ts ?? o.time ?? o.timestamp ?? o.date ?? o.datetime ?? o.epoch ?? o.checked_at ?? o.checkedAt ?? o.created_at;
    bid = o.bid ?? o.buy ?? o.bank_buys ?? o.buying;
    ask = o.ask ?? o.sell ?? o.bank_sells ?? o.selling;
    rate = o.rate ?? o.value ?? o.price;
  } else if (typeof raw === 'string' || typeof raw === 'number') {
    // "t,bid,ask" pasted inside a JSON string
    const cells = String(raw).split(/[,;\t]/);
    if (cells.length >= 3) [t, bid, ask] = cells;
    else return null;
  } else {
    return null;
  }

  const time = parseTime(t);
  if (time === null || !saneTime(time)) return null;

  const rateNum = finiteNumber(rate);
  let bidNum = finiteNumber(bid);
  let askNum = finiteNumber(ask);
  if (bidNum === null && rateNum !== null) bidNum = rateNum;
  if (askNum === null && bidNum !== null) askNum = bidNum; // a "rate only" file
  if (bidNum === null) bidNum = askNum;
  if (bidNum === null || askNum === null || !saneRate(bidNum) || !saneRate(askNum)) return null;

  return { t: time, bid: bidNum, ask: askNum };
}

const pointKey = (p: Point) => `${p.t}|${p.bid}|${p.ask}`;

export interface PointCollect {
  points: Point[];
  /** Rows that could not be read (bad time, missing rate, …). */
  invalid: number;
  /** Exact duplicates inside the file. */
  duplicates: number;
  /** Rows dropped because the file holds more than `maxPoints` (oldest first). */
  truncated: number;
}

/** Normalise, sort, de-duplicate and cap a list of raw history rows. */
export function collectPoints(raw: unknown, maxPoints = exportLimit()): PointCollect {
  const list = Array.isArray(raw) ? raw : [];
  const out = new Map<string, Point>();
  let invalid = 0;

  for (const item of list) {
    const p = pointFromRaw(item);
    if (!p) {
      invalid += 1;
      continue;
    }
    out.set(pointKey(p), p);
  }

  const sorted = [...out.values()].sort((a, b) => a.t - b.t);
  const duplicates = list.length - invalid - sorted.length;
  const truncated = Math.max(0, sorted.length - maxPoints);
  return {
    points: truncated ? sorted.slice(sorted.length - maxPoints) : sorted,
    invalid,
    duplicates,
    truncated,
  };
}

const alertKey = (a: ExportAlert) =>
  [a.source, a.chatId ?? '', a.webhookUrl ?? '', a.condition, a.targetRate ?? ''].join('|');

export interface AlertCollect {
  alerts: ExportAlert[];
  /** Alert entries that were unusable (no destination, …). */
  invalid: number;
  duplicates: number;
}

/** Normalise the `alerts` array of an export file. */
export function collectAlerts(raw: unknown): AlertCollect {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const alerts: ExportAlert[] = [];
  let invalid = 0;

  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      invalid += 1;
      continue;
    }
    const o = item as Record<string, unknown>;
    const alert: ExportAlert = {
      source: o.source === 'web' ? 'web' : 'bot',
      webhookUrl: text(o.webhookUrl ?? o.webhook_url ?? o.url),
      chatId: text(o.chatId ?? o.chat_id),
      botToken: secret(o.botToken ?? o.bot_token),
      condition: condition(o.condition),
      targetRate: finiteNumber(o.targetRate ?? o.target_rate),
      customMessage: text(o.customMessage ?? o.custom_message ?? o.message),
      active: o.active !== false && o.active !== 0 && o.active !== 'false',
      createdAt: parseTime(o.createdAt ?? o.created_at) ?? Date.now(),
      lastAlertAt: parseTime(o.lastAlertAt ?? o.last_alert_at),
    };
    // An alert with no destination can never fire — dropping it is better than
    // importing a subscription that silently does nothing.
    if (alert.source === 'bot' && !alert.chatId) {
      invalid += 1;
      continue;
    }
    if (alert.source === 'web' && !alert.webhookUrl) {
      invalid += 1;
      continue;
    }
    const key = alertKey(alert);
    if (seen.has(key)) continue; // duplicate inside the file — counted below
    seen.add(key);
    alerts.push(alert);
  }

  return { alerts, invalid, duplicates: list.length - invalid - alerts.length };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** `wingrate-export-20261006-1215.json` — ASCII, sortable, no spaces. */
export function exportFilename(format: ExportFormat, at = Date.now()): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  return format === 'csv' ? `wingrate-rates-${stamp}.csv` : `wingrate-export-${stamp}.json`;
}

export const mimeFor = (format: ExportFormat) => (format === 'csv' ? 'text/csv' : 'application/json');

/** CSV cell: quote anything that could contain a separator, quote or newline. */
const cell = (v: string | number) => {
  const s = String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** History → `t,iso,bid,ask` (spreadsheet friendly, still importable). */
export function encodeCsv(points: Point[]): string {
  const lines = ['t,iso,bid,ask'];
  for (const p of points) lines.push([p.t, new Date(p.t).toISOString(), p.bid, p.ask].map(cell).join(','));
  return `${lines.join('\n')}\n`;
}

/** The file contents for a bundle — pretty-printed JSON, or CSV history. */
export function encodeExport(bundle: ExportBundle, format: ExportFormat = 'json'): string {
  if (format === 'csv') return encodeCsv(bundle.history);
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ParsedExport {
  ok: boolean;
  error?: string;
  format: ExportFormat;
  /** Normalised, ready-to-import bundle (empty when `ok` is false). */
  bundle: ExportBundle;
  warnings: string[];
}

const emptyBundle = (now = Date.now()): ExportBundle => ({
  format: EXPORT_FORMAT,
  version: EXPORT_VERSION,
  app: 'Wing Bank KHR/USD tracker',
  exportedAt: new Date(now).toISOString(),
  source: { kind: 'memory', label: 'unknown' },
  counts: { history: 0, alerts: 0 },
  history: [],
  alerts: [],
  truncated: false,
});

/** Split one CSV line on commas, honouring "quoted, cells" and doubled quotes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else quoted = false;
      } else current += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',' || ch === ';' || ch === '\t') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

const TIME_HEADERS = ['t', 'ts', 'time', 'timestamp', 'date', 'datetime', 'epoch', 'checked_at', 'created_at'];
const BID_HEADERS = ['bid', 'buy', 'buys', 'bank_buys', 'buying', 'rate', 'value', 'price'];
const ASK_HEADERS = ['ask', 'sell', 'sells', 'bank_sells', 'selling'];
const ISO_HEADER = ['iso', 'utc', 'time_iso', 'date_utc'];

interface CsvLayout {
  t: number;
  bid: number;
  ask: number;
  /** Column holding a human-readable copy of the time (ignored when reading). */
  iso: number | null;
}

/** Work out which CSV column holds what, from the header row when there is one. */
function csvLayout(header: string[]): CsvLayout | null {
  const lower = header.map((h) => h.toLowerCase().replace(/["'\s]/g, '_'));
  const find = (names: string[]) => lower.findIndex((h) => names.includes(h));
  const t = find(TIME_HEADERS);
  const bid = find(BID_HEADERS);
  const ask = find(ASK_HEADERS);
  if (t >= 0 && (bid >= 0 || ask >= 0)) return { t, bid, ask, iso: find(ISO_HEADER) };
  return null;
}

/** Sniff files written without a header row (`t,bid,ask`, `t,iso,bid,ask`, `iso,bid,ask`). */
function sniffLayout(row: string[]): CsvLayout | null {
  if (row.length >= 4 && parseTime(row[1]) !== null && finiteNumber(row[2]) !== null && finiteNumber(row[3]) !== null) {
    return { t: 0, bid: 2, ask: 3, iso: 1 };
  }
  if (row.length >= 3 && parseTime(row[0]) !== null && finiteNumber(row[1]) !== null) {
    return { t: 0, bid: 1, ask: 2, iso: null };
  }
  if (row.length >= 3 && parseTime(row[0]) !== null && finiteNumber(row[2]) !== null) {
    return { t: 0, bid: 1, ask: 2, iso: 1 };
  }
  if (row.length >= 2 && parseTime(row[0]) !== null) return { t: 0, bid: 1, ask: 1, iso: null };
  return null;
}

/** CSV → raw row objects, ready for `collectPoints`. */
function readCsv(text: string): { rows: unknown[]; layout: CsvLayout | null } {
  const rows: unknown[] = [];
  let layout: CsvLayout | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = splitCsvLine(line);
    if (!layout) {
      layout = csvLayout(cells);
      if (layout) continue; // consumed the header row
      layout = sniffLayout(cells);
      if (!layout) {
        // Unknown header, unreadable first row: report it as invalid data.
        rows.push({});
        continue;
      }
    }
    const time = cells[layout.t];
    const bid = layout.bid >= 0 ? cells[layout.bid] : undefined;
    const ask = layout.ask >= 0 ? cells[layout.ask] : bid;
    rows.push({ t: time, bid, ask });
  }

  return { rows, layout };
}

/**
 * Read an export file (JSON or CSV) into a normalised bundle.
 * Never throws: a file that cannot be understood comes back as `{ ok: false, error }`.
 */
export function parseExportFile(text: string, opts: { filename?: string | null; maxPoints?: number } = {}): ParsedExport {
  const warnings: string[] = [];
  const clean = (text ?? '').replace(/^\uFEFF/, '').trim();
  const name = opts.filename ?? '';
  const maxPoints = Math.max(1, opts.maxPoints ?? exportLimit());

  if (!clean) {
    return { ok: false, error: 'The file is empty.', format: 'json', bundle: emptyBundle(), warnings };
  }

  const looksJson = clean.startsWith('{') || clean.startsWith('[');
  const format: ExportFormat = looksJson ? 'json' : 'csv';

  let raw: unknown;
  if (looksJson) {
    try {
      raw = JSON.parse(clean);
    } catch (e) {
      return {
        ok: false,
        error: `This file is not valid JSON (${e instanceof Error ? e.message : String(e)}).`,
        format,
        bundle: emptyBundle(),
        warnings,
      };
    }
  }

  // ---- pick the history and alert arrays out of whatever shape we got -------
  let historyRaw: unknown;
  let alertsRaw: unknown;
  let source: ExportBundle['source'] | null = null;
  let exportedAt: string | null = null;
  let foreignFormat: string | null = null;

  if (!looksJson) {
    const csv = readCsv(clean);
    historyRaw = csv.rows;
    if (!csv.layout) warnings.push('No column header found — the file was read as “time, bid, ask”.');
  } else if (Array.isArray(raw)) {
    historyRaw = raw;
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    historyRaw = o.history ?? o.rates ?? o.points ?? o.ticks ?? o.data ?? o.rows ?? [];
    alertsRaw = o.alerts ?? o.subscriptions ?? o.alertRecords;
    const src = o.source as { kind?: unknown; label?: unknown } | undefined;
    if (src && typeof src === 'object') {
      source = {
        kind: (typeof src.kind === 'string' ? src.kind : 'memory') as StoreKind,
        label: typeof src.label === 'string' && src.label ? src.label : 'unknown',
      };
    }
    exportedAt = typeof o.exportedAt === 'string' ? o.exportedAt : null;
    if (typeof o.format === 'string' && o.format !== EXPORT_FORMAT) foreignFormat = o.format;
  } else {
    return { ok: false, error: 'The file is neither a JSON document nor CSV text.', format, bundle: emptyBundle(), warnings };
  }

  const history = collectPoints(historyRaw, maxPoints);
  const alerts = collectAlerts(alertsRaw);

  if (history.truncated) {
    warnings.push(
      `Only the newest ${maxPoints.toLocaleString()} history rows are imported — the file holds ${(history.points.length + history.truncated).toLocaleString()} (EXPORT_LIMIT).`,
    );
  }
  if (history.invalid) warnings.push(`${history.invalid.toLocaleString()} row(s) had no usable time or rate and were skipped.`);
  if (history.duplicates) warnings.push(`${history.duplicates.toLocaleString()} duplicate row(s) inside the file were folded together.`);
  if (alerts.invalid) warnings.push(`${alerts.invalid.toLocaleString()} alert(s) had no destination and were skipped.`);
  if (history.points.length === 0 && alerts.alerts.length === 0) {
    return {
      ok: false,
      error: foreignFormat
        ? `This looks like a “${foreignFormat}” file — it has no history rows or alerts that /import understands.`
        : 'No price history or alerts were found in this file.',
      format,
      bundle: emptyBundle(),
      warnings,
    };
  }

  const now = Date.now();
  const bundle: ExportBundle = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    app: 'Wing Bank KHR/USD tracker',
    exportedAt: exportedAt ?? new Date(now).toISOString(),
    source: source ?? { kind: 'memory', label: name ? `${name} (imported file)` : 'imported file' },
    counts: { history: history.points.length, alerts: alerts.alerts.length },
    history: history.points,
    alerts: alerts.alerts,
    truncated: history.truncated > 0,
  };

  return { ok: true, format, bundle, warnings };
}

// ---------------------------------------------------------------------------
// Quick facts used by the chat previews
// ---------------------------------------------------------------------------

/** "2024-01-05 → 2026-10-06" (UTC), or null when there is no history. */
export function historyRange(points: Point[]): string | null {
  if (!points.length) return null;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const first = day(points[0].t);
  const last = day(points[points.length - 1].t);
  return first === last ? first : `${first} → ${last}`;
}

/** Alerts that carry a credential (bot token / webhook URL) — worth warning about. */
export const alertsWithSecrets = (bundle: ExportBundle) =>
  bundle.alerts.filter((a) => Boolean(a.botToken) || Boolean(a.webhookUrl)).length;

export interface ExportFacts {
  historyRows: number;
  alerts: number;
  range: string | null;
  secrets: number;
}

export function exportFacts(bundle: ExportBundle): ExportFacts {
  return {
    historyRows: bundle.counts.history,
    alerts: bundle.counts.alerts,
    range: historyRange(bundle.history),
    secrets: alertsWithSecrets(bundle),
  };
}

/** `1,234` — numbers as they appear in the chat. */
export const num = (n: number) => n.toLocaleString();

export { alertKey, pointKey, pointFromRaw };
