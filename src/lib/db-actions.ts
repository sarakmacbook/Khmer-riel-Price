/**
 * Database operations shared by the Telegram bot menu and `POST /api/database`:
 * connect (probe first, then switch), disconnect, health checks — plus the
 * backup feature: link a second database, copy data between databases
 * ("moving my data across cloud storage"), and promote the backup.
 *
 * Every operation is safe to run while the app is live: probes happen against
 * throwaway instances, and only a database that answers is saved and activated.
 */

import { configFromSpec, redactError, type DbSpec, type StoreConfig } from './store/env';
import {
  clearLink,
  normalizeLinkOptions,
  saveChoice,
  saveChoiceAndLink,
  saveLink,
  specFromInput,
  type DbChoice,
  type DbLink,
  type SaveResult,
} from './db-config';
import {
  activeConfig,
  activeLink,
  createStore,
  linkStatus,
  probeStore,
  resetStore,
  storeStatus,
  type LinkStatus,
  type ProbeResult,
  type StoreStatus,
} from './store';
import { describeStore, summarizeTransfer, transferStore, type TransferOptions, type TransferResult } from './store/transfer';
import { DEFAULT_LINK_OPTIONS, type LinkOptions } from './store/types';

export interface ConnectInput {
  kind?: string | null;
  url: string;
  token?: string | null;
  label?: string | null;
}

export interface ConnectOutcome extends ProbeResult {
  label: string;
  /** How the choice is described back to the user */
  summary: string;
  save: SaveResult;
}

/** Probe a database and, only if it answers, make it the active one. */
export async function connectDatabase(
  spec: DbSpec,
  opts: { by?: string | null; source?: 'telegram' | 'dashboard' } = {},
): Promise<ConnectOutcome> {
  const cfg = configFromSpec(spec);
  const probe = await probeStore(cfg);

  if (!probe.ok) {
    return {
      ...probe,
      error: redactError(probe.error ?? 'unknown error'),
      label: cfg.label,
      summary: '',
      save: { persisted: false, path: null },
    };
  }

  const choice: DbChoice = {
    mode: 'custom',
    spec,
    source: opts.source ?? 'telegram',
    setAt: Date.now(),
    setBy: opts.by ?? null,
  };
  const save = await saveChoice(choice, opts.by ?? null);
  resetStore(); // next request connects with the new config

  return { ...probe, label: cfg.label, summary: cfg.label, save };
}

/** Switch back to the deployment's env database, or to no database at all. */
export async function disconnectDatabase(
  mode: 'auto' | 'memory',
  by: string | null = null,
): Promise<{ save: SaveResult; status: StoreStatus }> {
  const choice: DbChoice =
    mode === 'memory'
      ? { mode: 'memory', setAt: Date.now(), setBy: by }
      : { mode: 'auto' };
  const save = await saveChoice(choice, by);
  resetStore();
  return { save, status: await storeStatus() };
}

/** Ping the active database (creates the schema on a brand-new server too). */
export async function testActiveDatabase(): Promise<StoreStatus> {
  resetStore(); // always re-connect for a real "test", never a cached instance
  return storeStatus();
}

export type SpecParse = { ok: true; spec: DbSpec } | { ok: false; error: string };

/** Parse a JSON body into a validated spec — accepts a few common field spellings. */
export function specificationFromBody(body: Record<string, unknown>): SpecParse {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const url = str(body.url) || str(body.connectionString) || str(body.connection_string) || str(body.databaseUrl);
  const token = str(body.token) || str(body.authToken) || str(body.auth_token);
  const kind = str(body.kind) || str(body.type) || str(body.backend);
  const label = str(body.label) || str(body.name);
  if (!url) {
    return {
      ok: false,
      error: 'Missing "url" — send {"kind":"postgres","url":"postgresql://…","token":"…"} (kind may be omitted: it is detected from the URL).',
    };
  }
  try {
    return { ok: true, spec: specFromInput({ kind, url, token: token || null, label: label || null }) };
  } catch (e) {
    return { ok: false, error: redactError(e) };
  }
}

// ---------------------------------------------------------------------------
// Backup database (second database + failover)
// ---------------------------------------------------------------------------

/** Turn an env/config database into a spec that can be saved or probed again. */
export function specOfConfig(cfg: StoreConfig): DbSpec {
  return {
    kind: cfg.kind,
    url: (cfg.url ?? cfg.token ?? '').trim(),
    token: cfg.token ?? null,
    label: cfg.label,
  };
}

export interface LinkOutcome {
  ok: boolean;
  ms: number;
  error?: string;
  label: string;
  options: LinkOptions;
  save: SaveResult;
  /** Result of the initial data copy (null when skipped) */
  sync: TransferResult | null;
  status: LinkStatus | null;
}

/**
 * Attach a backup database: probe it, save it as the link, then (by default)
 * make the two databases hold the same data right away.
 */
export async function linkBackup(
  spec: DbSpec,
  opts: {
    by?: string | null;
    source?: 'telegram' | 'dashboard';
    options?: Partial<LinkOptions> | null;
    /** false = link without copying data first; 'auto' (default) picks the useful direction */
    syncNow?: boolean;
  } = {},
): Promise<LinkOutcome> {
  const started = Date.now();
  const options = normalizeLinkOptions(opts.options, DEFAULT_LINK_OPTIONS);

  let cfg: StoreConfig;
  try {
    cfg = configFromSpec(spec);
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: redactError(e),
      label: spec.kind,
      options,
      save: { persisted: false, path: null },
      sync: null,
      status: null,
    };
  }

  const probe = await probeStore(cfg);
  if (!probe.ok) {
    return {
      ok: false,
      ms: probe.ms,
      error: redactError(probe.error ?? 'connection failed'),
      label: cfg.label,
      options,
      save: { persisted: false, path: null },
      sync: null,
      status: null,
    };
  }

  const link: DbLink = {
    spec,
    options,
    source: opts.source ?? 'telegram',
    addedAt: Date.now(),
    addedBy: opts.by ?? null,
  };
  const save = await saveLink(link, opts.by ?? null);
  resetStore(); // start mirroring from the next request on

  let sync: TransferResult | null = null;
  if (opts.syncNow !== false) {
    const outcome = await syncDatabases({ target: 'auto' }, { by: opts.by ?? null });
    sync = outcome.results[0] ?? null;
    if (!outcome.ok && outcome.error) sync = { ...(sync ?? emptyTransfer(cfg, {})), ok: false, error: outcome.error };
  }

  return {
    ok: true,
    ms: Date.now() - started,
    label: cfg.label,
    options,
    save,
    sync,
    status: await linkStatus({ fresh: true }).catch(() => null),
  };
}

/** Remove the saved link (a backup provided by env vars stays configured). */
export async function unlinkBackup(by: string | null = null): Promise<{ save: SaveResult; status: StoreStatus }> {
  const save = await clearLink(by);
  resetStore();
  return { save, status: await storeStatus() };
}

/** Toggle link behaviour (mirror, autoFailover, autoReturn, autoResync). */
export async function updateLinkOptions(
  partial: unknown,
  by: string | null = null,
): Promise<{ ok: boolean; error?: string; options?: LinkOptions; save?: SaveResult; status?: LinkStatus | null }> {
  const link = await activeLink();
  if (!link) return { ok: false, error: 'No backup database is linked yet.' };

  const options = normalizeLinkOptions(partial, link.options);
  const save = await saveLink({ ...link, options, addedBy: by ?? link.addedBy }, by);
  resetStore();
  return { ok: true, options, save, status: await linkStatus({ fresh: true }).catch(() => null) };
}

/** Health of the linked pair, refreshed (used by the "test backup" action). */
export async function testLink(): Promise<LinkStatus | null> {
  resetStore();
  return linkStatus({ fresh: true });
}

// ---------------------------------------------------------------------------
// Copying data between databases
// ---------------------------------------------------------------------------

export type SyncTarget = 'toBackup' | 'fromBackup' | 'both' | 'auto';

export interface SyncRequest {
  /** Which way to copy when a backup is linked (default: auto) */
  target?: SyncTarget;
  /** Explicit endpoints — migrate between two databases without linking them */
  from?: DbSpec;
  to?: DbSpec;
  mode?: 'merge' | 'replace';
  dryRun?: boolean;
  history?: boolean;
  alerts?: boolean;
  since?: number | null;
  limit?: number;
}

export interface SyncOutcome {
  ok: boolean;
  target: SyncTarget;
  error?: string;
  /** Human-readable one-liner(s) */
  summary: string;
  results: TransferResult[];
  status: LinkStatus | null;
}

const transferOptions = (req: SyncRequest): TransferOptions => ({
  mode: req.mode === 'replace' ? 'replace' : 'merge',
  dryRun: req.dryRun,
  history: req.history,
  alerts: req.alerts,
  since: req.since ?? null,
  limit: req.limit,
});

/** Build both stores for one direction and copy. Never throws. */
async function transferDirection(
  direction: 'toBackup' | 'fromBackup',
  primaryCfg: StoreConfig,
  backupCfg: StoreConfig,
  options: TransferOptions,
): Promise<TransferResult> {
  const [from, to] = direction === 'toBackup' ? [primaryCfg, backupCfg] : [backupCfg, primaryCfg];
  try {
    const [src, dst] = await Promise.all([createStore(from), createStore(to)]);
    return await transferStore(src, dst, options);
  } catch (e) {
    return {
      ...emptyTransfer(from, options),
      ok: false,
      error: redactError(e),
    };
  }
}

function emptyTransfer(cfg: StoreConfig, options: TransferOptions): TransferResult {
  return {
    ok: false,
    dryRun: Boolean(options.dryRun),
    mode: options.mode === 'replace' ? 'replace' : 'merge',
    ms: 0,
    source: { kind: cfg.kind, label: cfg.label },
    target: { kind: cfg.kind, label: cfg.label },
    history: options.history === false ? null : { found: 0, copied: 0, updated: 0, skipped: 0, targetOnly: 0, truncated: false },
    alerts: options.alerts === false ? null : { found: 0, copied: 0, updated: 0, skipped: 0, targetOnly: 0 },
    warnings: [],
  };
}

/**
 * Copy price history and Telegram/web alerts between databases.
 *
 *  • With a link configured and no explicit endpoints, `target` decides:
 *    `toBackup` (seed/repair the copy), `fromBackup` (restore the primary),
 *    `both` (reconcile), `auto` (work it out from what each side holds).
 *  • With `from`/`to` specs, copies between any two databases — e.g. moving an
 *    old Postgres into a new Turso before switching over.
 */
export async function syncDatabases(
  req: SyncRequest = {},
  opts: { by?: string | null } = {},
): Promise<SyncOutcome> {
  void opts;
  const options = transferOptions(req);
  const want = req.target ?? 'auto';

  try {
    // 1. Explicit endpoints: a plain migration between two databases.
    if (req.from && req.to) {
      const result = await transferDirection('toBackup', configFromSpec(req.from), configFromSpec(req.to), options);
      return {
        ok: result.ok,
        target: 'toBackup',
        error: result.error,
        summary: summarizeTransfer(result),
        results: [result],
        status: await linkStatus().catch(() => null),
      };
    }

    // 2. Linked pair: primary ⇄ backup.
    const link = await activeLink();
    if (!link) {
      return {
        ok: false,
        target: want,
        error: 'No backup database is linked yet. Link one first (/link, or POST /api/database with an "action":"link" body).',
        summary: '',
        results: [],
        status: null,
      };
    }
    const { cfg } = await activeConfig();
    if (cfg.kind === 'memory') {
      return {
        ok: false,
        target: want,
        error: 'The current database is in-memory (nothing durable to copy) — connect a real database first.',
        summary: '',
        results: [],
        status: await linkStatus().catch(() => null),
      };
    }
    const backupCfg = configFromSpec(link.spec);

    if (want === 'toBackup' || want === 'fromBackup') {
      const result = await transferDirection(want, cfg, backupCfg, options);
      return {
        ok: result.ok,
        target: want,
        error: result.error,
        summary: summarizeTransfer(result),
        results: [result],
        status: await linkStatus({ fresh: true }).catch(() => null),
      };
    }

    // 'both' / 'auto' — reconcile. (Replace semantics make no sense when both
    // directions are copied, so those runs are always merges.)
    const mergeOnly: TransferOptions = { ...options, mode: 'merge' };
    const [primary, backup] = await Promise.all([
      describeStore(await createStore(cfg)),
      describeStore(await createStore(backupCfg)),
    ]);

    let directions: ('toBackup' | 'fromBackup')[] = ['toBackup', 'fromBackup'];
    if (want === 'auto') {
      if (!backup.reachable && !primary.reachable) {
        return {
          ok: false,
          target: want,
          error: `Neither database answers — primary (${primary.label}): ${primary.error ?? 'unknown'}; backup (${backup.label}): ${backup.error ?? 'unknown'}`,
          summary: '',
          results: [],
          status: await linkStatus({ fresh: true }).catch(() => null),
        };
      }
      if (!backup.reachable) directions = ['toBackup'];
      else if (!primary.reachable) directions = ['fromBackup'];
      else if ((primary.rows ?? 0) === 0 && (backup.rows ?? 0) > 0) directions = ['fromBackup'];
      else if ((backup.rows ?? 0) === 0 && (primary.rows ?? 0) > 0) directions = ['toBackup'];
    }

    const results: TransferResult[] = [];
    for (const direction of directions) {
      results.push(await transferDirection(direction, cfg, backupCfg, mergeOnly));
    }
    const ok = results.every((r) => r.ok);
    return {
      ok,
      target: want,
      error: ok ? undefined : results.find((r) => !r.ok)?.error,
      summary: results.map(summarizeTransfer).join(' · '),
      results,
      status: await linkStatus({ fresh: true }).catch(() => null),
    };
  } catch (e) {
    return {
      ok: false,
      target: want,
      error: redactError(e),
      summary: '',
      results: [],
      status: await linkStatus().catch(() => null),
    };
  }
}

export interface PromoteOutcome {
  ok: boolean;
  error?: string;
  /** Label of the database that is now the primary */
  label?: string;
  save?: SaveResult;
  summary?: string;
  status?: LinkStatus | null;
}

/**
 * Swap roles: the backup becomes the primary database and the old primary
 * becomes its backup. Data on both sides is kept, and (by default) the two are
 * reconciled right away.
 */
export async function promoteBackup(
  opts: { by?: string | null; source?: 'telegram' | 'dashboard'; syncNow?: boolean } = {},
): Promise<PromoteOutcome> {
  const link = await activeLink();
  if (!link) return { ok: false, error: 'No backup database is linked yet.' };

  const { cfg } = await activeConfig();
  if (cfg.kind === 'memory') {
    return { ok: false, error: 'The current database is in-memory, so there is nothing to demote to a backup.' };
  }

  const backupCfg = configFromSpec(link.spec);
  const probe = await probeStore(backupCfg);
  if (!probe.ok) {
    return { ok: false, error: `The backup database does not answer, so it cannot be promoted: ${redactError(probe.error ?? 'unknown error')}` };
  }

  const source = opts.source ?? 'dashboard';
  const now = Date.now();
  const choice: DbChoice = { mode: 'custom', spec: link.spec, source, setAt: now, setBy: opts.by ?? null };
  const demoted: DbLink = {
    spec: specOfConfig(cfg),
    options: link.options,
    source,
    addedAt: now,
    addedBy: opts.by ?? null,
  };
  const save = await saveChoiceAndLink(choice, demoted, opts.by ?? null);
  resetStore();

  let summary: string | undefined;
  if (opts.syncNow !== false) {
    const outcome = await syncDatabases({ target: 'auto' }, { by: opts.by ?? null });
    summary = outcome.summary;
  }

  return {
    ok: true,
    label: backupCfg.label,
    save,
    summary,
    status: await linkStatus({ fresh: true }).catch(() => null),
  };
}
