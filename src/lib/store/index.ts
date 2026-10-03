import { loadChoice, peekChoice, choiceSourceLabel, lastConfigPath, lastConfigWarning, type DbChoice } from '@/lib/db-config';
import { MEMORY_CONFIG, configFromSpec, detectAll, detectStore, type StoreConfig } from './env';
import { MemoryStore } from './memory';
import { errDetail, errMsg, type RateStore, type StoreKind } from './types';

export type { RateStore, RateRow, Point, AlertRecord, AlertInput, StoreKind } from './types';
export type { StoreConfig } from './env';

interface CacheEntry {
  /** Hash of the config, so switching databases (or servers) makes a new instance. */
  sig: string;
  cfg: StoreConfig;
  promise: Promise<RateStore>;
}

const g = globalThis as typeof globalThis & {
  __wingrateStore?: CacheEntry | null;
  __wingrateMemory?: MemoryStore;
  __wingrateStoreError?: string | null;
  /** Kind of the store instance that was actually created (may be memory fallback). */
  __wingrateActive?: { kind: StoreKind; label: string; sig: string } | null;
};

/** Non-cryptographic hash — only used to detect config changes, never for secrets. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const sigOf = (cfg: StoreConfig) => `${cfg.kind}:${cfg.token ? 't' : '-'}:${hash(`${cfg.url ?? ''}|${cfg.token ?? ''}`)}`;

export const MEMORY_LABEL = 'In-memory (no database)';

function memoryConfig(label = MEMORY_LABEL): StoreConfig {
  return { ...MEMORY_CONFIG, label };
}

/** Build a store instance for an explicit config (no init, no caching). */
export async function createStore(cfg: StoreConfig): Promise<RateStore> {
  switch (cfg.kind) {
    case 'postgres': {
      const { PostgresStore } = await import('./postgres');
      return new PostgresStore(cfg.url!, cfg.label);
    }
    case 'turso': {
      const { TursoStore } = await import('./turso');
      return new TursoStore(cfg.url!, cfg.token);
    }
    case 'mongodb': {
      const { MongoStore } = await import('./mongodb');
      return new MongoStore(cfg.url!, cfg.label);
    }
    case 'upstash': {
      const [{ RedisStore }, { UpstashRest }] = await Promise.all([import('./redis'), import('./redis-client')]);
      return new RedisStore(new UpstashRest(cfg.url!, cfg.token!), 'upstash', cfg.label);
    }
    case 'redis': {
      const [{ RedisStore }, { respClient }] = await Promise.all([import('./redis'), import('./redis-client')]);
      return new RedisStore(respClient(cfg.url!), 'redis', cfg.label);
    }
    case 'blob': {
      const { BlobStore } = await import('./blob');
      return new BlobStore(cfg.token!);
    }
    default:
      return memoryStore();
  }
}

/** Per-instance in-memory store (also used as fallback when the database is unreachable). */
export function memoryStore(): MemoryStore {
  return (g.__wingrateMemory ??= new MemoryStore());
}

/**
 * Which database the app is configured to use right now:
 * runtime choice (Telegram / API) → config file → DB_CONFIG_JSON → env detection.
 */
export async function activeConfig(): Promise<{ cfg: StoreConfig; choice: DbChoice }> {
  const choice = await loadChoice();
  if (choice.mode === 'memory') return { cfg: memoryConfig('In-memory (disconnected)'), choice };
  if (choice.mode === 'custom') return { cfg: configFromSpec(choice.spec), choice };
  return { cfg: detectStore(), choice };
}

/** Synchronous best-effort view (the file may not have been read yet on a cold instance). */
export function activeConfigSync(): StoreConfig {
  try {
    const choice = peekChoice();
    if (choice.mode === 'memory') return memoryConfig('In-memory (disconnected)');
    if (choice.mode === 'custom') return configFromSpec(choice.spec);
    return detectStore();
  } catch {
    return memoryConfig();
  }
}

/** Kind actually in use (falls back to memory when the database is unreachable). */
export const activeStoreKind = (): StoreKind => g.__wingrateActive?.kind ?? activeConfigSync().kind;
export const activeStoreLabel = (): string => g.__wingrateActive?.label ?? activeConfigSync().label;
/** Config signature — caches that key on it are invalidated when the database changes. */
export const activeSignature = (): string => g.__wingrateActive?.sig ?? sigOf(activeConfigSync());

/** Drop the cached instance so the next request connects with the current config. */
export function resetStore(): void {
  g.__wingrateStore = null;
  g.__wingrateActive = null;
  g.__wingrateStoreError = null;
}

/** The configured store, initialized once per config (schema/indexes created on first use). Throws if unreachable. */
export function getStore(): Promise<RateStore> {
  return (async () => {
    const { cfg } = await activeConfig();
    const sig = sigOf(cfg);
    if (g.__wingrateStore && g.__wingrateStore.sig === sig) return g.__wingrateStore.promise;

    const promise = (async () => {
      const store = await createStore(cfg);
      await store.init();
      g.__wingrateStoreError = null;
      g.__wingrateActive = { kind: store.kind, label: store.label, sig };
      return store;
    })();
    g.__wingrateStore = { sig, cfg, promise };
    promise.catch((e) => {
      g.__wingrateStoreError = errMsg(e);
      if (g.__wingrateStore?.sig === sig) g.__wingrateStore = null; // retry on next request
    });
    return promise;
  })();
}

/** Like getStore(), but falls back to the in-memory store instead of throwing. */
export async function getStoreOrMemory(): Promise<RateStore> {
  try {
    return await getStore();
  } catch (e) {
    console.error('[store] unavailable, using memory:', errMsg(e));
    return memoryStore();
  }
}

export const lastStoreError = () => g.__wingrateStoreError ?? null;

// ---------------------------------------------------------------------------
// Diagnostics / testing (used by the Telegram menu and /api/database)
// ---------------------------------------------------------------------------

export interface StoreStatus {
  choice: DbChoice;
  /** How the choice is described ("connected via Telegram", "environment variables", …) */
  source: string;
  /** Kind the configuration points at */
  configuredKind: StoreKind;
  configuredLabel: string;
  /** Kind actually answering queries (memory = fallback) */
  activeKind: StoreKind;
  activeLabel: string;
  persistent: boolean;
  reachable: boolean;
  ms: number;
  error: string | null;
  stats: Record<string, unknown> | null;
  /** Where a Telegram/API choice is stored */
  configPath: string | null;
  configWarning: string | null;
  /** Databases the deployment's env vars provide (names only) */
  detected: StoreConfig[];
}

export async function storeStatus(): Promise<StoreStatus> {
  const { cfg, choice } = await activeConfig();
  const base: StoreStatus = {
    choice,
    source: choiceSourceLabel(choice),
    configuredKind: cfg.kind,
    configuredLabel: cfg.label,
    activeKind: cfg.kind,
    activeLabel: cfg.label,
    persistent: false,
    reachable: false,
    ms: 0,
    error: null,
    stats: null,
    configPath: lastConfigPath(),
    configWarning: lastConfigWarning(),
    detected: (() => {
      try {
        return detectAll();
      } catch {
        return [];
      }
    })(),
  };

  const started = Date.now();
  try {
    const store = await getStore();
    base.ms = Date.now() - started;
    base.reachable = true;
    base.persistent = store.persistent;
    base.activeKind = store.kind;
    base.activeLabel = store.label;
    base.stats = (await store.stats().catch(() => null)) as Record<string, unknown> | null;
  } catch (e) {
    base.ms = Date.now() - started;
    base.error = errDetail(e) || lastStoreError();
  }
  return base;
}

export interface ProbeResult {
  ok: boolean;
  ms: number;
  error?: string;
  stats?: Record<string, unknown> | null;
}

/**
 * Connect to an arbitrary database *without* making it active — the Telegram
 * "connect" flow probes first so a typo cannot break a working deployment.
 */
export async function probeStore(cfg: StoreConfig): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const store = await createStore(cfg);
    await store.init();
    await store.latest();
    const stats = (await store.stats().catch(() => null)) as Record<string, unknown> | null;
    return { ok: true, ms: Date.now() - started, stats };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: errDetail(e) };
  }
}
