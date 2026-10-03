/**
 * Runtime database selection.
 *
 * The deployment's database used to be whatever the environment variables
 * happened to point at — a Telegram user could not change it. This module keeps
 * a small override document so the bot (and `POST /api/database`) can:
 *
 *   • connect ANY Postgres / Turso / MongoDB / Upstash / Redis / Blob database,
 *   • switch between them later,
 *   • disconnect and fall back to the environment database (or to memory).
 *
 * Where the override lives (first writable wins):
 *   1. `DB_CONFIG_FILE` (default `<cwd>/.data/wingrate-db.json`)
 *   2. `<tmpdir>/wingrate-db.json` when the working directory is read-only
 *      (Vercel, read-only containers) — survives warm invocations only.
 * Reading also honours `DB_CONFIG_JSON` (an inline JSON document) so a
 * serverless deployment with a read-only filesystem can be pinned by config.
 *
 * Precedence when resolving the active database:
 *   in-process override → config file → `DB_CONFIG_JSON` → env auto-detection.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectBackupStore, detectKindFromUrl, validateSpec, type DbSpec } from './store/env';
import {
  DEFAULT_LINK_OPTIONS,
  LINK_OPTION_KEYS,
  type LinkOptions,
  type StoreKind,
} from './store/types';

export type DbMode = 'auto' | 'memory' | 'custom';

export type DbChoice =
  /** Use whatever the deployment's env vars point at (default). */
  | { mode: 'auto' }
  /** Explicitly no database — everything runs from the in-memory fallback. */
  | { mode: 'memory'; setAt: number; setBy: string | null }
  /** A database the user connected at runtime. */
  | {
      mode: 'custom';
      spec: DbSpec;
      /** Where this choice came from (telegram = set from the bot, file/env = restored). */
      source: 'telegram' | 'dashboard' | 'file' | 'env';
      setAt: number;
      setBy: string | null;
    };

/**
 * The linked backup database: a second database that mirrors the primary and
 * takes over when it is down (see lib/store/linked.ts).
 */
export interface DbLink {
  spec: DbSpec;
  options: LinkOptions;
  /** Where this link came from (telegram = set from the bot, env = BACKUP_* vars) */
  source: 'telegram' | 'dashboard' | 'file' | 'env';
  addedAt: number;
  addedBy: string | null;
}

interface LinkDoc {
  kind?: string;
  url?: string;
  token?: string | null;
  label?: string | null;
  options?: Partial<LinkOptions>;
}

interface ConfigDoc {
  v?: number;
  mode?: DbMode;
  spec?: { kind?: string; url?: string; token?: string | null; label?: string | null };
  link?: LinkDoc | null;
  updatedAt?: number;
  updatedBy?: string | null;
  adminChatId?: string | null;
}

export interface SaveResult {
  /** true when the choice will survive a restart */
  persisted: boolean;
  /** file it was written to, when persisted */
  path: string | null;
  /** human explanation when it could not be persisted */
  warning?: string;
}

const g = globalThis as typeof globalThis & {
  /** Choice made in this process (also the value handed to the store factory). */
  __wingrateChoice?: DbChoice;
  /** Document read from disk / env (used for the synchronous peek). */
  __wingrateChoiceDoc?: ConfigDoc | null;
  /** Promise of the first read so concurrent requests share it. */
  __wingrateChoiceLoad?: Promise<DbChoice> | null;
  /** Linked backup database (null = none, undefined = not read yet). */
  __wingrateLink?: DbLink | null;
  /** Where the cached document came from (for messages). */
  __wingrateDocSource?: 'file' | 'env';
  __wingrateConfigPath?: string | null;
  __wingrateConfigWarning?: string | null;
};

// ---------------------------------------------------------------------------
// Paths & IO
// ---------------------------------------------------------------------------

export function configFilePaths(): { primary: string; fallback: string } {
  const configured = process.env.DB_CONFIG_FILE?.trim();
  const cwd = process.cwd();
  // The fallback is namespaced by working directory: /tmp is shared between
  // deployments on the same host (and between instances on Vercel).
  let hash = 5381;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) + hash + cwd.charCodeAt(i)) >>> 0;
  return {
    primary: configured || path.join(cwd, '.data', 'wingrate-db.json'),
    fallback: path.join(os.tmpdir(), `wingrate-db-${hash.toString(36)}.json`),
  };
}

/** Where the override document currently lives (null until one was written/read). */
export const lastConfigPath = () => g.__wingrateConfigPath ?? null;
export const lastConfigWarning = () => g.__wingrateConfigWarning ?? null;

/**
 * Filesystem calls are bounded: a stuck mount (or a Node bug on exotic paths
 * such as /proc) must never hang the webhook that is saving the choice. The
 * caller then degrades to the next writable location instead of timing out.
 */
const IO_TIMEOUT_MS = Number(process.env.DB_CONFIG_IO_TIMEOUT_MS) || 3_000;

function withTimeout<T>(p: Promise<T>, ms = IO_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`filesystem did not respond within ${ms}ms`)), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function readJson(file: string): Promise<ConfigDoc | null> {
  try {
    const text = await withTimeout(fs.readFile(file, 'utf8'));
    const doc = JSON.parse(text) as ConfigDoc;
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null; // missing / unreadable / corrupt → treat as "no override"
  }
}

async function writeJson(file: string, doc: ConfigDoc): Promise<boolean> {
  try {
    await withTimeout(fs.mkdir(path.dirname(file), { recursive: true }));
    const tmp = `${file}.${process.pid}.tmp`;
    await withTimeout(fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8'));
    await withTimeout(fs.rename(tmp, file));
    return true;
  } catch (e) {
    console.error(`[db-config] could not write ${file}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

function envJsonDoc(): ConfigDoc | null {
  const raw = (process.env.DB_CONFIG_JSON ?? process.env.DB_OVERRIDE_JSON ?? '').trim();
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as ConfigDoc;
    return doc && typeof doc === 'object' ? doc : null;
  } catch (e) {
    console.error('[db-config] DB_CONFIG_JSON is not valid JSON:', e instanceof Error ? e.message : e);
    return null;
  }
}

const asKind = (v: unknown): StoreKind | null => {
  const s = String(v ?? '').trim().toLowerCase();
  return (['postgres', 'turso', 'mongodb', 'upstash', 'redis', 'blob'] as const).find((k) => k === s) ?? null;
};

function choiceFromDoc(doc: ConfigDoc | null, source: 'file' | 'env'): DbChoice | null {
  if (!doc) return null;
  if (doc.mode === 'memory') return { mode: 'memory', setAt: doc.updatedAt ?? 0, setBy: doc.updatedBy ?? null };
  if (doc.mode === 'custom') {
    const kind = asKind(doc.spec?.kind);
    const url = String(doc.spec?.url ?? '').trim();
    if (!kind || !url) return null;
    try {
      return {
        mode: 'custom',
        spec: validateSpec({ kind, url, token: doc.spec?.token ?? null, label: doc.spec?.label ?? null }),
        source,
        setAt: doc.updatedAt ?? 0,
        setBy: doc.updatedBy ?? null,
      };
    } catch {
      return null; // half-written / outdated document → ignore instead of crashing
    }
  }
  if (doc.mode === 'auto') return { mode: 'auto' };
  return null;
}

function docFromChoice(
  choice: DbChoice,
  by: string | null,
  adminChatId: string | null | undefined,
  link: DbLink | null = null,
): ConfigDoc {
  const base: ConfigDoc = {
    v: 1,
    mode: choice.mode,
    updatedAt: Date.now(),
    updatedBy: by,
    adminChatId: adminChatId ?? null,
    link: link ? linkDocFrom(link) : null,
  };
  if (choice.mode === 'custom') {
    base.spec = { kind: choice.spec.kind, url: choice.spec.url, token: choice.spec.token ?? null, label: choice.spec.label ?? null };
  }
  return base;
}

// ---------------------------------------------------------------------------
// The linked backup database
// ---------------------------------------------------------------------------

/** Local hash — only used to key caches, never for secrets. */
function smallHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const asBool = (v: string | undefined): boolean | null => {
  if (v === undefined) return null;
  return !/^(0|false|no|off|disable[d]?)$/i.test(v.trim());
};

/** Link options from the `LINK_*` env vars (missing ones keep the default). */
export function linkOptionsFromEnv(base: LinkOptions = DEFAULT_LINK_OPTIONS): LinkOptions {
  return {
    mirror: asBool(process.env.LINK_MIRROR) ?? base.mirror,
    autoFailover: asBool(process.env.LINK_AUTO_FAILOVER) ?? base.autoFailover,
    autoReturn: asBool(process.env.LINK_AUTO_RETURN) ?? base.autoReturn,
    autoResync: asBool(process.env.LINK_AUTO_RESYNC) ?? base.autoResync,
  };
}

/** Accepts booleans, "on"/"off", numbers — anything the API or Telegram may send. */
export function normalizeLinkOptions(input: unknown, base: LinkOptions = DEFAULT_LINK_OPTIONS): LinkOptions {
  const out: LinkOptions = { ...base };
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    for (const key of LINK_OPTION_KEYS) {
      const v = rec[key];
      if (typeof v === 'boolean') out[key] = v;
      else if (typeof v === 'number') out[key] = v !== 0;
      else if (typeof v === 'string') out[key] = asBool(v) ?? out[key];
    }
  }
  return out;
}

function linkDocFrom(link: DbLink): LinkDoc {
  return {
    kind: link.spec.kind,
    url: link.spec.url,
    token: link.spec.token ?? null,
    label: link.spec.label ?? null,
    options: { ...link.options },
  };
}

function linkFromDoc(doc: LinkDoc | null | undefined, source: DbLink['source']): DbLink | null {
  if (!doc || typeof doc !== 'object') return null;
  const kind = asKind(doc.kind);
  const url = String(doc.url ?? '').trim();
  if (!kind || !url) return null;
  try {
    return {
      spec: validateSpec({ kind, url, token: doc.token ?? null, label: doc.label ?? null }),
      options: normalizeLinkOptions(doc.options),
      source,
      addedAt: g.__wingrateChoiceDoc?.updatedAt ?? 0,
      addedBy: g.__wingrateChoiceDoc?.updatedBy ?? null,
    };
  } catch {
    return null; // half-written / outdated link → ignore instead of crashing
  }
}

/** The backup database described by `DB_BACKUP_JSON` or the BACKUP_ / SECONDARY_ env vars. */
function envLink(): DbLink | null {
  const raw = (process.env.DB_BACKUP_JSON ?? process.env.DB_LINK_JSON ?? '').trim();
  if (raw) {
    try {
      const doc = JSON.parse(raw) as LinkDoc & { options?: unknown };
      const parsed = linkFromDoc({ ...doc, options: normalizeLinkOptions(doc.options, linkOptionsFromEnv()) }, 'env');
      if (parsed) return parsed;
    } catch (e) {
      console.error('[db-config] DB_BACKUP_JSON is not valid JSON:', e instanceof Error ? e.message : e);
    }
  }

  let cfg;
  try {
    cfg = detectBackupStore();
  } catch (e) {
    console.error('[db-config]', e instanceof Error ? e.message : e);
    return null;
  }
  if (!cfg) return null;
  const url = (cfg.url ?? cfg.token ?? '').trim(); // Vercel Blob: the token IS the value
  if (!url) return null;
  try {
    return {
      spec: validateSpec({ kind: cfg.kind, url, token: cfg.token ?? null, label: cfg.label }),
      options: linkOptionsFromEnv(),
      source: 'env',
      addedAt: 0,
      addedBy: null,
    };
  } catch (e) {
    console.error('[db-config] ignoring the backup database from the environment:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** A link worth persisting in the config document (env links stay in the env). */
function savedLink(): DbLink | null {
  const link = g.__wingrateLink ?? linkFromDoc(g.__wingrateChoiceDoc?.link, 'file');
  return link && link.source !== 'env' ? link : null;
}

/** Cache key: any change to the backup database or its options reconnects the store. */
export function linkSignature(link: DbLink | null): string {
  if (!link) return '-';
  const { kind, url, token } = link.spec;
  return `${kind}:${smallHash(`${url}|${token ?? ''}`)}:${LINK_OPTION_KEYS.map((k) => (link.options[k] ? '1' : '0')).join('')}`;
}

/**
 * The linked backup database, or null when only one database is configured.
 * Precedence: the saved doc (Telegram/dashboard) → `DB_BACKUP_JSON` → BACKUP_* env vars.
 */
export async function loadLink(): Promise<DbLink | null> {
  if (g.__wingrateLink !== undefined) return g.__wingrateLink;
  await loadChoice(); // fills __wingrateChoiceDoc from file / DB_CONFIG_JSON
  const fromFile = linkFromDoc(g.__wingrateChoiceDoc?.link, g.__wingrateDocSource ?? 'file');
  return (g.__wingrateLink = fromFile ?? envLink());
}

/** Best-known link without touching the filesystem (diagnostics). */
export function peekLink(): DbLink | null {
  if (g.__wingrateLink !== undefined) return g.__wingrateLink;
  return linkFromDoc(g.__wingrateChoiceDoc?.link, g.__wingrateDocSource ?? 'file') ?? envLink();
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** The active choice (cached per process; the first call reads the file). */
export function loadChoice(): Promise<DbChoice> {
  if (g.__wingrateChoice) return Promise.resolve(g.__wingrateChoice);
  g.__wingrateChoiceLoad ??= (async () => {
    const { primary, fallback } = configFilePaths();

    // 1. the file written by a previous Telegram/API choice
    let doc = await readJson(primary);
    let from: string | null = doc ? primary : null;
    let source: 'file' | 'env' = 'file';

    // 2. an explicit DB_CONFIG_JSON pin (read-only deployments) — it outranks the
    //    ephemeral /tmp fallback but not a real config file
    if (!doc) {
      const pinned = envJsonDoc();
      if (pinned) {
        doc = pinned;
        source = 'env';
        g.__wingrateDocSource = 'env';
      }
    }

    // 3. the fallback location used when the working directory was read-only
    if (!doc) {
      doc = await readJson(fallback);
      if (doc) from = fallback;
    }

    if (doc) g.__wingrateDocSource ??= source === 'env' ? 'env' : 'file';
    g.__wingrateChoiceDoc = doc;
    if (from) g.__wingrateConfigPath = from;
    return choiceFromDoc(doc, source) ?? { mode: 'auto' };
  })();
  return g.__wingrateChoiceLoad;
}

/**
 * Best-known choice without touching the filesystem — used by the synchronous
 * `storeBackend()` diagnostics. Call `loadChoice()` first for an exact answer.
 */
export function peekChoice(): DbChoice {
  if (g.__wingrateChoice) return g.__wingrateChoice;
  return choiceFromDoc(g.__wingrateChoiceDoc ?? null, 'file') ?? choiceFromDoc(envJsonDoc(), 'env') ?? { mode: 'auto' };
}

/** How the choice should be described in messages/logs. */
export function choiceSourceLabel(choice: DbChoice): string {
  if (choice.mode === 'auto') return 'environment variables';
  if (choice.mode === 'memory') return 'disconnected (in-memory)';
  return choice.source === 'telegram'
    ? 'connected via Telegram'
    : choice.source === 'dashboard'
      ? 'connected from the API'
      : `restored from ${choice.source === 'env' ? 'DB_CONFIG_JSON' : 'the saved config file'}`;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Persist a choice and make it the active one for this process.
 * Never throws: a read-only filesystem degrades to an in-memory override and
 * reports `persisted: false` so the caller can warn the user.
 */
export async function saveChoice(choice: DbChoice, by: string | null = null): Promise<SaveResult> {
  // Read the document first when this instance never did: rewriting it must not
  // silently drop a link that a previous session saved to disk.
  if (g.__wingrateChoiceDoc === undefined) await loadChoice().catch(() => null);
  return saveChoiceAndLink(choice, savedLink(), by);
}

/**
 * Persist the primary choice *and* the linked backup in one document — used by
 * "promote backup", which swaps the two roles atomically.
 */
export async function saveChoiceAndLink(
  choice: DbChoice,
  link: DbLink | null,
  by: string | null = null,
): Promise<SaveResult> {
  g.__wingrateChoice = choice;
  g.__wingrateChoiceLoad = Promise.resolve(choice);
  g.__wingrateLink = link;

  const doc = docFromChoice(choice, by, await getAdminChatId(), link);
  g.__wingrateChoiceDoc = doc;

  const { primary, fallback } = configFilePaths();
  if (await writeJson(primary, doc)) {
    g.__wingrateConfigPath = primary;
    g.__wingrateConfigWarning = null;
    return { persisted: true, path: primary };
  }
  if (await writeJson(fallback, doc)) {
    g.__wingrateConfigPath = fallback;
    const warning =
      `The working directory is read-only, so the choice was saved to ${fallback} instead. ` +
      'It survives restarts of this instance but not a redeploy — set DB_CONFIG_JSON (or mount a writable DB_CONFIG_FILE) to make it permanent.';
    g.__wingrateConfigWarning = warning;
    return { persisted: true, path: fallback, warning };
  }
  const warning =
    'No writable location for the database config — this choice applies until the server restarts. ' +
    'Mount a writable volume (DB_CONFIG_FILE) or set DB_CONFIG_JSON to keep it.';
  g.__wingrateConfigWarning = warning;
  return { persisted: false, path: null, warning };
}

/**
 * Link a backup database (or update the link's options) and remember it.
 * `loadChoice()` is awaited first so a link saved on a fresh instance keeps the
 * primary choice that is already on disk / in `DB_CONFIG_JSON`.
 */
export async function saveLink(link: DbLink, by: string | null = null): Promise<SaveResult> {
  const choice = await loadChoice();
  return saveChoiceAndLink(choice, link, by);
}

/** Remove the saved link (an env-provided backup database stays configured). */
export async function clearLink(by: string | null = null): Promise<SaveResult> {
  const choice = await loadChoice();
  return saveChoiceAndLink(choice, null, by);
}

// ---------------------------------------------------------------------------
// Admin (who may change the database)
// ---------------------------------------------------------------------------

/** Chat allowed to manage the database: env wins, else the saved claim. */
export async function getAdminChatId(): Promise<string | null> {
  const env = envAdminChatId();
  if (env) return env;
  return String(g.__wingrateChoiceDoc?.adminChatId ?? '').trim() || null;
}

export function envAdminChatId(): string | null {
  for (const key of ['TELEGRAM_ADMIN_CHAT_ID', 'TELEGRAM_OWNER_CHAT_ID', 'ADMIN_CHAT_ID', 'TELEGRAM_CHAT_ID']) {
    const v = process.env[key]?.trim();
    if (v) return v;
  }
  return null;
}

/** First chat that asks to manage the bot claims ownership (saved in the config file). */
export async function claimAdminChatId(chatId: string): Promise<boolean> {
  if (await getAdminChatId()) return false;
  const doc: ConfigDoc = { ...(g.__wingrateChoiceDoc ?? {}), adminChatId: chatId, updatedAt: Date.now() };
  g.__wingrateChoiceDoc = doc;
  const { primary, fallback } = configFilePaths();
  if (await writeJson(primary, doc)) g.__wingrateConfigPath = primary;
  else if (await writeJson(fallback, doc)) g.__wingrateConfigPath = fallback;
  else g.__wingrateConfigWarning = 'Could not persist the owner chat id — ownership is per-instance only.';
  return true;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const KIND_ALIASES: Record<string, StoreKind> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  pg: 'postgres',
  neon: 'postgres',
  supabase: 'postgres',
  'supabase-postgres': 'postgres',
  turso: 'turso',
  libsql: 'turso',
  sqlite: 'turso',
  mongo: 'mongodb',
  mongodb: 'mongodb',
  atlas: 'mongodb',
  upstash: 'upstash',
  kv: 'upstash',
  'vercel-kv': 'upstash',
  redis: 'redis',
  'redis-tcp': 'redis',
  tcp: 'redis',
  blob: 'blob',
  'vercel-blob': 'blob',
};

/** "/connect pg <url>" → 'postgres'. Returns null for unknown names. */
export function normalizeKind(raw: string | null | undefined): StoreKind | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  return KIND_ALIASES[s] ?? asKind(s);
}

/**
 * Build a validated spec from user input: the kind may be given explicitly or
 * inferred from the connection string ("postgresql://…", "libsql://…", …).
 */
export function specFromInput(input: { kind?: string | null; url: string; token?: string | null; label?: string | null }): DbSpec {
  const url = (input.url ?? '').trim();
  if (!url) throw new Error('Missing connection string.');
  const kind = normalizeKind(input.kind) ?? detectKindFromUrl(url);
  if (!kind) {
    throw new Error(
      'Could not tell which database that is. Send it as /connect <type> <connection-string> — types: postgres, turso, mongodb, upstash, redis, blob.',
    );
  }
  return validateSpec({ kind, url, token: input.token ?? null, label: input.label ?? null });
}
