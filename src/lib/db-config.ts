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
import { detectKindFromUrl, validateSpec, type DbSpec } from './store/env';
import type { StoreKind } from './store/types';

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

interface ConfigDoc {
  v?: number;
  mode?: DbMode;
  spec?: { kind?: string; url?: string; token?: string | null; label?: string | null };
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

function docFromChoice(choice: DbChoice, by: string | null, adminChatId: string | null | undefined): ConfigDoc {
  const base: ConfigDoc = {
    v: 1,
    mode: choice.mode,
    updatedAt: Date.now(),
    updatedBy: by,
    adminChatId: adminChatId ?? null,
  };
  if (choice.mode === 'custom') {
    base.spec = { kind: choice.spec.kind, url: choice.spec.url, token: choice.spec.token ?? null, label: choice.spec.label ?? null };
  }
  return base;
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
      }
    }

    // 3. the fallback location used when the working directory was read-only
    if (!doc) {
      doc = await readJson(fallback);
      if (doc) from = fallback;
    }

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
  g.__wingrateChoice = choice;
  g.__wingrateChoiceLoad = Promise.resolve(choice);

  const doc = docFromChoice(choice, by, await getAdminChatId());
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
