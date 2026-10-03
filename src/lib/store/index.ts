import {
  loadChoice,
  loadLink,
  linkSignature,
  peekChoice,
  choiceSourceLabel,
  lastConfigPath,
  lastConfigWarning,
  type DbChoice,
  type DbLink,
} from '@/lib/db-config';
import { MEMORY_CONFIG, configFromSpec, detectAll, detectStore, maskTarget, type StoreConfig } from './env';
import { MemoryStore } from './memory';
import { createLinkedStore, linkStateOf, type LinkCounters, type LinkState, type SideState } from './linked';
import { describeStore } from './transfer';
import { errDetail, errMsg, type LinkOptions, type LinkSide, type RateStore, type StoreKind } from './types';

export type { RateStore, RateRow, Point, AlertRecord, AlertInput, StoreKind, LinkOptions, LinkSide } from './types';
export type { StoreConfig } from './env';
export type { LinkCounters, LinkState, SideState } from './linked';

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
  /** Short-lived memo of the two-sided link probe. */
  __wingrateLinkProbe?: { sig: string; at: number; promise: Promise<LinkStatus | null> } | null;
};

/** Non-cryptographic hash — only used to detect config changes, never for secrets. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const sigOf = (cfg: StoreConfig, link?: DbLink | null) =>
  `${cfg.kind}:${cfg.token ? 't' : '-'}:${hash(`${cfg.url ?? ''}|${cfg.token ?? ''}`)}` +
  (link ? `+link:${linkSignature(link)}` : '');

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
  g.__wingrateLinkProbe = null;
}

/**
 * The linked backup database, when one is configured (Telegram/dashboard
 * setting, `DB_BACKUP_JSON`, or the BACKUP_ / SECONDARY_ env vars).
 */
export async function activeLink(): Promise<DbLink | null> {
  try {
    const { choice } = await activeConfig();
    if (choice.mode === 'memory') return null; // explicit "no database" wins
    return await loadLink();
  } catch {
    return null;
  }
}

/** Cache signature of the currently configured link (null when unlinked). */
export async function currentLinkSignature(): Promise<string | null> {
  const { cfg } = await activeConfig();
  const link = await activeLink();
  return link ? sigOf(cfg, link) : null;
}

/** The configured store, initialized once per config (schema/indexes created on first use). Throws if unreachable. */
export function getStore(): Promise<RateStore> {
  return (async () => {
    const { cfg } = await activeConfig();
    const link = await activeLink();
    const sig = sigOf(cfg, link);
    if (g.__wingrateStore && g.__wingrateStore.sig === sig) return g.__wingrateStore.promise;

    const promise = (async () => {
      // With a backup linked, the two databases are joined into one store:
      // writes are mirrored and the backup takes over while the primary is down.
      const store = link
        ? await createLinkedStore({
            primaryConfig: cfg,
            backupConfig: configFromSpec(link.spec),
            options: link.options,
            sig,
            create: createStore,
          })
        : await createStore(cfg);
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
  /** Backup database + failover state (null when only one database is used) */
  link: LinkStatus | null;
}

/** One side of a linked pair: reachability, contents and observed health. */
export interface LinkSideStatus {
  kind: StoreKind;
  label: string;
  /** Masked connection target (never a password or token) */
  target: string | null;
  reachable: boolean;
  ms: number;
  error: string | null;
  stats: Record<string, unknown> | null;
  rows: number | null;
  latest: number | null;
  alerts: number | null;
  /** What the linked store observed while serving requests (null before the first one) */
  runtime: SideState | null;
}

export interface LinkStatus {
  linked: true;
  /** How the link was configured: "connected via Telegram", "environment variables", … */
  source: string;
  options: LinkOptions;
  /** Which database answers requests right now */
  serving: LinkSide;
  /** Why the backup is serving, when it is */
  reason: string | null;
  /** true when this process actually joined the two databases (vs. configuring only) */
  active: boolean;
  primary: LinkSideStatus;
  backup: LinkSideStatus;
  counters: LinkCounters;
  drift: {
    inSync: boolean | null;
    /** rows(primary) − rows(backup): positive = the backup is behind */
    rowsDiff: number | null;
    /** latest(primary) − latest(backup) in ms: positive = the backup is behind */
    latestDiffMs: number | null;
    note: string;
  };
  checkedAt: number;
}

/** How the link should be described in messages. */
function linkSourceLabel(link: DbLink): string {
  switch (link.source) {
    case 'telegram':
      return 'linked via Telegram';
    case 'dashboard':
      return 'linked from the API';
    case 'env':
      return 'from BACKUP_ / DB_BACKUP_JSON env vars';
    default:
      return 'restored from the saved config file';
  }
}

const linkDrift = (primary: LinkSideStatus, backup: LinkSideStatus, counters: LinkCounters): LinkStatus['drift'] => {
  const rowsDiff = primary.rows !== null && backup.rows !== null ? primary.rows - backup.rows : null;
  const latestDiffMs = primary.latest !== null && backup.latest !== null ? primary.latest - backup.latest : null;

  let inSync: boolean | null = null;
  let note: string;
  if (!primary.reachable || !backup.reachable) {
    inSync = null;
    note = !primary.reachable
      ? backup.reachable
        ? counters.pendingResync
          ? 'The primary database is unreachable — the backup is serving and holding rows that still have to be copied back.'
          : 'The primary database is unreachable — the backup is answering requests.'
        : 'Neither database answers.'
      : 'The backup database is unreachable — the primary keeps working, but the copy is stale until it is back.';
  } else if (counters.pendingResync || (rowsDiff !== null && rowsDiff < 0)) {
    inSync = false;
    note = `${Math.abs(rowsDiff ?? 0)} row(s) recorded during a failover are still only in the backup — a re-sync is pending.`;
  } else if (rowsDiff === 0 && (latestDiffMs === null || Math.abs(latestDiffMs) < 90_000)) {
    inSync = true;
    note = 'Both databases hold the same data.';
  } else {
    inSync = false;
    const bits: string[] = [];
    if (rowsDiff && rowsDiff > 0) bits.push(`the backup is ${rowsDiff} row(s) behind`);
    if (latestDiffMs && latestDiffMs > 90_000) bits.push(`its newest row is ${Math.round(latestDiffMs / 60_000)} min older`);
    note = bits.length ? `Out of sync: ${bits.join(', ')} — a sync will copy the missing rows.` : 'The two databases are not identical yet.';
  }
  return { inSync, rowsDiff, latestDiffMs, note };
};

// Probing both sides on every status call would hammer the databases — a short
// cache keeps /api/database and the Telegram menu cheap to poll.
const LINK_PROBE_TTL_MS = Number(process.env.LINK_STATUS_TTL_MS) || 5_000;

/**
 * Health of the linked backup pair: configuration, which side is serving,
 * what each database holds and how far apart they are. Null when unlinked.
 */
export async function linkStatus(opts: { fresh?: boolean } = {}): Promise<LinkStatus | null> {
  const { cfg, choice } = await activeConfig();
  if (choice.mode === 'memory') return null;
  const link = await activeLink();
  if (!link) return null;

  const sig = sigOf(cfg, link);
  const cached = g.__wingrateLinkProbe;
  if (!opts.fresh && cached && cached.sig === sig && Date.now() - cached.at < LINK_PROBE_TTL_MS) return cached.promise;

  const promise = (async (): Promise<LinkStatus> => {
    const primaryCfg = cfg;
    const backupCfg = configFromSpec(link.spec);
    const [primary, backup] = await Promise.all([
      (async () => {
        try {
          return await describeStore(await createStore(primaryCfg));
        } catch (e) {
          return { ...(await fallbackSummary(primaryCfg)), reachable: false, error: errDetail(e) };
        }
      })(),
      (async () => {
        try {
          return await describeStore(await createStore(backupCfg));
        } catch (e) {
          return { ...(await fallbackSummary(backupCfg)), reachable: false, error: errDetail(e) };
        }
      })(),
    ]);

    const state: LinkState | null = linkStateOf(sig);
    const side = (summary: typeof primary, runtime: SideState | null, target: string | null): LinkSideStatus => ({
      kind: summary.kind,
      label: summary.label,
      target,
      reachable: summary.reachable,
      ms: summary.ms,
      error: summary.error,
      stats: summary.stats,
      rows: summary.rows,
      latest: summary.latest,
      alerts: summary.alerts,
      runtime,
    });

    const counters: LinkCounters =
      state?.counters ??
      ({
        failovers: 0,
        failbacks: 0,
        lastFailoverAt: null,
        lastFailbackAt: null,
        mirrorWrites: 0,
        mirrorErrors: 0,
        mirrorSkips: 0,
        lastMirrorAt: null,
        lastMirrorError: null,
        failoverWrites: 0,
        resyncs: 0,
        lastResyncAt: null,
        lastResyncError: null,
        lastResyncResult: null,
        pendingResync: false,
      } satisfies LinkCounters);

    const primarySide = side(primary, state?.primary ?? null, maskTarget(primaryCfg.url ?? primaryCfg.token ?? '') || 'in-memory');
    const backupSide = side(backup, state?.backup ?? null, maskTarget(link.spec.url));

    return {
      linked: true,
      source: linkSourceLabel(link),
      options: link.options,
      serving: state?.serving ?? (primary.reachable ? 'primary' : 'backup'),
      reason: state?.reason ?? null,
      active: Boolean(state),
      primary: primarySide,
      backup: backupSide,
      counters,
      drift: linkDrift(primarySide, backupSide, counters),
      checkedAt: Date.now(),
    };
  })();

  g.__wingrateLinkProbe = { sig, at: Date.now(), promise };
  promise.catch(() => {}); // status is best-effort; never an unhandled rejection
  return promise;
}

/** Minimal summary used when a store cannot even be constructed (bad URL, missing driver). */
async function fallbackSummary(cfg: StoreConfig) {
  return {
    kind: cfg.kind,
    label: cfg.label,
    reachable: false,
    ms: 0,
    error: null as string | null,
    stats: null as Record<string, unknown> | null,
    rows: null as number | null,
    latest: null as number | null,
    alerts: null as number | null,
  };
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
    link: null,
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

  // Backup database / failover state — independent of the store probe above, so
  // it is still reported when both databases are down.
  base.link = await linkStatus().catch(() => null);
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
