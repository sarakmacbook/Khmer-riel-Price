/**
 * Two databases, one store — the "backup database" feature.
 *
 * `createLinkedStore()` joins the configured primary database with a second
 * (backup) database of any supported kind and returns a normal `RateStore`:
 *
 *   • **Live mirror** (`mirror`) — every write also goes to the backup, so the
 *     second database is a current copy, not a stale snapshot.
 *   • **Automatic failover** (`autoFailover`) — if the primary throws, the same
 *     request is retried against the backup and the app keeps working.
 *   • **Automatic return** (`autoReturn`) — while the backup is serving, the
 *     primary is re-probed at most once per probe interval; as soon as it
 *     answers, traffic goes back to it.
 *   • **Automatic re-sync** (`autoResync`) — rows and alerts that were written
 *     to the backup during the outage are copied back into the primary
 *     (`transfer.ts`), so returning can never lose data.
 *
 * Everything degrades gracefully: mirror failures never break a request, and if
 * both databases are down the outer layer falls back to the in-memory store.
 */

import {
  type AlertInput,
  type AlertRecord,
  type LinkOptions,
  type LinkSide,
  type Point,
  type RateRow,
  type RateStore,
  type RecordResult,
  type StoreKind,
  errDetail,
} from './types';
import type { StoreConfig } from './env';
import { catchUp, type TransferResult } from './transfer';

// ---------------------------------------------------------------------------
// Runtime state (per linked configuration, shared by every request)
// ---------------------------------------------------------------------------

export interface SideState {
  kind: StoreKind;
  label: string;
  /** null = not contacted yet in this process */
  ok: boolean | null;
  error: string | null;
  lastAttemptAt: number | null;
  lastOkAt: number | null;
  /** When the side started failing (null while healthy) */
  downSince: number | null;
  latencyMs: number | null;
}

export interface LinkCounters {
  failovers: number;
  failbacks: number;
  lastFailoverAt: number | null;
  lastFailbackAt: number | null;
  /** Successful mirror writes */
  mirrorWrites: number;
  mirrorErrors: number;
  /** Writes not mirrored because the backup was known to be down (repaired later) */
  mirrorSkips: number;
  lastMirrorAt: number | null;
  lastMirrorError: string | null;
  /** Writes that had to be served by the backup while the primary was down */
  failoverWrites: number;
  resyncs: number;
  lastResyncAt: number | null;
  lastResyncError: string | null;
  lastResyncResult: TransferResult | null;
  /** true = the primary is missing rows the backup holds (a re-sync is due) */
  pendingResync: boolean;
}

export interface LinkState {
  /** Cache signature of the linked configuration this state belongs to. */
  sig: string;
  serving: LinkSide;
  /** Why the backup is serving, when it is */
  reason: string | null;
  primary: SideState;
  backup: SideState;
  counters: LinkCounters;
}

const g = globalThis as typeof globalThis & { __wingrateLinkState?: LinkState | null };

const emptyCounters = (): LinkCounters => ({
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
});

function newState(sig: string, primary: RateStore, backup: RateStore): LinkState {
  return {
    sig,
    serving: primary.kind === 'memory' ? 'backup' : 'primary',
    reason: primary.kind === 'memory' ? 'no primary database' : null,
    primary: { kind: primary.kind, label: primary.label, ok: null, error: null, lastAttemptAt: null, lastOkAt: null, downSince: null, latencyMs: null },
    backup: { kind: backup.kind, label: backup.label, ok: null, error: null, lastAttemptAt: null, lastOkAt: null, downSince: null, latencyMs: null },
    counters: emptyCounters(),
  };
}

/** Runtime state for a linked configuration (null when nothing was linked yet). */
export function linkStateOf(sig: string | null | undefined): LinkState | null {
  if (!sig || !g.__wingrateLinkState) return null;
  return g.__wingrateLinkState.sig === sig ? g.__wingrateLinkState : null;
}

/** Forget the runtime state (used by tests). */
export function resetLinkState(): void {
  g.__wingrateLinkState = null;
}

const probeIntervalMs = () => Math.max(5, Number(process.env.LINK_PROBE_SECONDS) || 30) * 1_000;
const mirrorTimeoutMs = () => Math.max(250, Number(process.env.LINK_MIRROR_TIMEOUT_MS) || 5_000);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
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

// ---------------------------------------------------------------------------
// The linked store
// ---------------------------------------------------------------------------

export interface LinkedStoreArgs {
  primaryConfig: StoreConfig;
  backupConfig: StoreConfig;
  options: LinkOptions;
  /** Cache signature of this configuration (see lib/store/index.ts) */
  sig: string;
  /** Factory that builds a store for one config (normally `createStore`) */
  create: (cfg: StoreConfig) => Promise<RateStore>;
  /** How often a failed primary may be re-probed (default LINK_PROBE_SECONDS, 30 s) */
  probeMs?: number;
  log?: (msg: string) => void;
}

export class LinkedStore implements RateStore {
  readonly kind: StoreKind;
  readonly label: string;
  readonly persistent: boolean;
  readonly readTtlMs: number;
  /** Marker so diagnostics can recognise the wrapper without importing it. */
  readonly linked = true as const;

  private resyncInflight: Promise<TransferResult | null> | null = null;
  private log: (msg: string) => void;
  /** How often a known-failed primary is re-probed. */
  private probeMs: number;

  constructor(
    readonly primary: RateStore,
    readonly backup: RateStore,
    readonly options: LinkOptions,
    private state: LinkState,
    opts: { probeMs?: number; log?: (msg: string) => void } = {},
  ) {
    this.log = opts.log ?? ((m) => console.warn(m));
    this.probeMs = opts.probeMs ?? probeIntervalMs();
    // With no primary database configured, the backup *is* the database the app
    // uses — reporting 'memory' here would make /api/health and the status
    // endpoints claim there is no storage at all.
    this.kind = primary.kind === 'memory' ? backup.kind : primary.kind;
    this.persistent = primary.persistent || backup.persistent;
    this.readTtlMs = Math.min(primary.readTtlMs, backup.readTtlMs);
    this.label =
      primary.kind === 'memory'
        ? `backup ${backup.label}`
        : `${primary.label} ⇄ ${backup.label}`;
  }

  /** Snapshot of the health/failover state (safe to serialise). */
  snapshot(): LinkState {
    return {
      ...this.state,
      primary: { ...this.state.primary },
      backup: { ...this.state.backup },
      counters: { ...this.state.counters },
    };
  }

  get serving(): LinkSide {
    return this.state.serving;
  }

  // ---- state bookkeeping ------------------------------------------------

  private markOk(side: LinkSide, latencyMs: number): void {
    const s = this.state[side];
    const now = Date.now();
    s.ok = true;
    s.error = null;
    s.latencyMs = latencyMs;
    s.lastAttemptAt = now;
    s.lastOkAt = now;
    s.downSince = null;
  }

  private markDown(side: LinkSide, e: unknown, latencyMs = 0): void {
    const s = this.state[side];
    const now = Date.now();
    s.ok = false;
    s.error = errDetail(e);
    s.latencyMs = latencyMs;
    s.lastAttemptAt = now;
    s.downSince ??= now;
  }

  private async attempt<T>(store: RateStore, side: LinkSide, op: string, fn: (s: RateStore) => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const value = await fn(store);
      this.markOk(side, Date.now() - started);
      return value;
    } catch (e) {
      this.markDown(side, e, Date.now() - started);
      throw e;
    }
  }

  private hasPrimary(): boolean {
    return this.primary.kind !== 'memory';
  }

  private usePrimary(): boolean {
    return this.state.serving === 'primary' && this.hasPrimary();
  }

  /** Re-probe a failed primary no more often than the probe interval. */
  private mayProbePrimary(): boolean {
    if (!this.options.autoReturn || !this.hasPrimary()) return false;
    const last = this.state.primary.lastAttemptAt ?? 0;
    return Date.now() - last >= this.probeMs;
  }

  /**
   * Mirroring is skipped while the backup is known to be down: retrying a dead
   * database on every write would add latency to the live rate endpoint. The
   * backup is re-probed at most once per interval, and the cron repairs the gap.
   */
  private mayMirror(): boolean {
    if (!this.options.mirror) return false;
    if (this.state.backup.ok !== false) return true;
    const last = this.state.backup.lastAttemptAt ?? 0;
    return Date.now() - last >= this.probeMs;
  }

  private failover(op: string, e: unknown): void {
    if (this.state.serving === 'primary') {
      this.state.serving = 'backup';
      this.state.reason = `primary failed during ${op}`;
      this.state.counters.failovers += 1;
      this.state.counters.lastFailoverAt = Date.now();
      this.log(`[link] primary is down (${op}: ${errDetail(e)}) — serving from ${this.backup.label}`);
    }
  }

  private failback(op: string): void {
    this.state.serving = 'primary';
    this.state.reason = null;
    this.state.counters.failbacks += 1;
    this.state.counters.lastFailbackAt = Date.now();
    this.log(`[link] ${this.primary.label} is back (${op}) — serving from the primary again`);
    if (this.state.counters.pendingResync && this.options.autoResync) void this.resync('failback');
  }

  // ---- reads ------------------------------------------------------------

  private async run<T>(op: string, fn: (s: RateStore) => Promise<T>): Promise<T> {
    if (this.usePrimary()) {
      try {
        return await this.attempt(this.primary, 'primary', op, fn);
      } catch (e) {
        if (!this.options.autoFailover) throw e;
        this.failover(op, e);
      }
    }

    if (this.mayProbePrimary()) {
      try {
        const value = await this.attempt(this.primary, 'primary', op, fn);
        this.failback(op);
        return value;
      } catch {
        /* still down — keep serving from the backup */
      }
    }

    return this.attempt(this.backup, 'backup', op, fn);
  }

  /** Best-effort mirror of a write that the primary already accepted. */
  private async mirror(op: string, fn: (s: RateStore) => Promise<unknown>): Promise<void> {
    const c = this.state.counters;
    try {
      await withTimeout(this.attempt(this.backup, 'backup', `mirror:${op}`, fn), mirrorTimeoutMs(), `mirror to ${this.backup.label}`);
      c.mirrorWrites += 1;
      c.lastMirrorAt = Date.now();
      c.lastMirrorError = null;
    } catch (e) {
      c.mirrorErrors += 1;
      c.lastMirrorError = errDetail(e);
      c.pendingResync = true; // the backup missed a write — a re-sync will repair it
      this.log(`[link] mirror to ${this.backup.label} failed during ${op}: ${c.lastMirrorError}`);
    }
  }

  // ---- writes -----------------------------------------------------------

  private async runWrite<T>(
    op: string,
    fn: (s: RateStore) => Promise<T>,
    mirrorFn?: (s: RateStore) => Promise<unknown>,
  ): Promise<T> {
    if (this.usePrimary()) {
      let wrote = false;
      let value!: T;
      try {
        value = await this.attempt(this.primary, 'primary', op, fn);
        wrote = true;
      } catch (e) {
        if (!this.options.autoFailover) throw e;
        this.failover(op, e);
      }
      if (wrote) {
        if (this.mayMirror()) await this.mirror(op, mirrorFn ?? fn);
        else this.state.counters.mirrorSkips += 1;
        return value;
      }
    }

    if (this.mayProbePrimary()) {
      let wrote = false;
      let value!: T;
      try {
        value = await this.attempt(this.primary, 'primary', op, fn);
        wrote = true;
      } catch {
        /* still down */
      }
      if (wrote) {
        this.failback(op);
        if (this.mayMirror()) await this.mirror(op, mirrorFn ?? fn);
        else this.state.counters.mirrorSkips += 1;
        return value;
      }
    }

    // The backup becomes the write target until the primary answers again.
    // Whatever the mirror setting says, this write exists only on the backup —
    // so it is flagged for the catch-up that runs when the primary returns.
    const value = await this.attempt(this.backup, 'backup', op, fn);
    this.state.counters.failoverWrites += 1;
    this.state.counters.pendingResync = true;
    return value;
  }

  // ---- RateStore --------------------------------------------------------

  async init(): Promise<void> {
    const [p, b] = await Promise.allSettled([
      this.hasPrimary() ? this.primary.init() : Promise.resolve(),
      this.backup.init(),
    ]);

    if (b.status === 'fulfilled') this.markOk('backup', 0);
    else this.markDown('backup', b.reason);

    if (!this.hasPrimary()) {
      this.state.serving = 'backup';
      this.state.reason = 'no primary database';
    } else if (p.status === 'fulfilled') {
      this.markOk('primary', 0);
      if (this.state.serving !== 'primary') this.failback('init');
    } else {
      this.markDown('primary', p.reason);
      if (!this.options.autoFailover) {
        throw p.reason instanceof Error ? p.reason : new Error(errDetail(p.reason));
      }
      this.failover('init', p.reason);
      if (b.status === 'rejected') {
        throw new Error(
          `Both databases are unreachable — primary (${this.primary.label}): ${errDetail(p.reason)}; ` +
            `backup (${this.backup.label}): ${errDetail(b.reason)}`,
        );
      }
    }

    if (b.status === 'rejected' && this.state.serving === 'backup') {
      throw b.reason instanceof Error ? b.reason : new Error(errDetail(b.reason));
    }
  }

  latest(): Promise<RateRow | null> {
    return this.run('latest', (s) => s.latest());
  }

  record(q: { bid: number; ask: number }, now: number): Promise<RecordResult> {
    return this.runWrite('record', (s) => s.record(q, now));
  }

  claimRefresh(now: number, refreshMs: number): Promise<boolean> {
    return this.runWrite('claimRefresh', (s) => s.claimRefresh(now, refreshMs));
  }

  range(since: number): Promise<Point[]> {
    return this.run('range', (s) => s.range(since));
  }

  before(ts: number): Promise<Point | null> {
    return this.run('before', (s) => s.before(ts));
  }

  daily(since: number | null): Promise<Point[]> {
    return this.run('daily', (s) => s.daily(since));
  }

  async backfill(points: Point[]): Promise<number> {
    return this.runWrite('backfill', (s) => (s.backfill ? s.backfill(points) : Promise.resolve(0)));
  }

  listAlerts(): Promise<AlertRecord[]> {
    return this.run('listAlerts', (s) => s.listAlerts());
  }

  saveAlert(a: AlertInput): Promise<AlertRecord> {
    return this.runWrite('saveAlert', (s) => s.saveAlert(a), async (backup) => {
      // Ids are per-database (serial, ObjectId, sequence…): mirror onto the
      // backup's own matching record, or insert a new one there.
      const existing = await backup.listAlerts();
      const key = alertKeyOf(a);
      const match = existing.find((x) => x.id === a.id) ?? existing.find((x) => alertKeyOf(x) === key);
      return backup.saveAlert(match ? { ...a, id: match.id, createdAt: match.createdAt } : { ...a, id: undefined });
    });
  }

  async wipe(opts: { history?: boolean; alerts?: boolean }): Promise<void> {
    const sides: RateStore[] = [];
    if (this.hasPrimary()) sides.push(this.primary);
    sides.push(this.backup);
    for (const s of sides) {
      if (!s.wipe) throw new Error(`${s.label} cannot erase its stored data (no wipe support)`);
    }
    for (const s of sides) await s.wipe!(opts);
  }

  async stats(): Promise<Record<string, unknown>> {
    const stats = await this.run('stats', (s) => s.stats());
    const c = this.state.counters;
    return {
      ...stats,
      serving: this.state.serving,
      reason: this.state.reason,
      failovers: c.failovers,
      mirrorErrors: c.mirrorErrors,
      mirrorSkips: c.mirrorSkips,
      pendingResync: c.pendingResync,
    };
  }

  // ---- catch-up ---------------------------------------------------------

  /**
   * Copy what the backup holds back into the primary (rows newer than the
   * primary's last row, plus alert changes). Runs at most once at a time and
   * clears `pendingResync` when it succeeds.
   */
  resync(reason = 'manual'): Promise<TransferResult | null> {
    if (this.resyncInflight) return this.resyncInflight;
    const counters = this.state.counters;

    this.resyncInflight = (async (): Promise<TransferResult | null> => {
      try {
        if (!this.primary.persistent) {
          counters.pendingResync = false; // nothing durable to catch up (memory primary)
          return null;
        }
        const latest = await this.primary.latest();
        const since = latest ? Math.max(0, latest.t - 1_000) : null;
        const result = await catchUp(this.backup, this.primary, {
          since,
          limit: Number(process.env.LINK_RESYNC_LIMIT) || 5_000,
        });
        counters.lastResyncResult = result;
        if (!result.ok) throw new Error(result.error ?? 'unable to copy data back into the primary');
        counters.resyncs += 1;
        counters.lastResyncAt = Date.now();
        counters.lastResyncError = null;
        counters.pendingResync = false;
        this.log(
          `[link] re-synced ${result.history?.copied ?? 0} history row(s) and ${result.alerts?.copied ?? 0} alert(s) ` +
            `from ${this.backup.label} into ${this.primary.label} (${reason})`,
        );
        return result;
      } catch (e) {
        counters.lastResyncError = errDetail(e);
        this.log(`[link] re-sync failed: ${counters.lastResyncError}`);
        return null;
      } finally {
        this.resyncInflight = null;
      }
    })();

    return this.resyncInflight;
  }
}

/** Identity of an alert input/record — mirrors transfer.alertKey without the import cycle. */
function alertKeyOf(
  a: Pick<AlertInput, 'source' | 'chatId' | 'webhookUrl' | 'condition' | 'targetRate'>,
): string {
  return [a.source, a.chatId ?? '', a.webhookUrl ?? '', a.condition, a.targetRate ?? ''].join('|');
}

/** Reuse the runtime state of a configuration, or start a fresh one. */
function stateFor(sig: string, primary: RateStore, backup: RateStore): LinkState {
  const state =
    g.__wingrateLinkState && g.__wingrateLinkState.sig === sig
      ? g.__wingrateLinkState
      : (g.__wingrateLinkState = newState(sig, primary, backup));
  state.primary.kind = primary.kind;
  state.primary.label = primary.label;
  state.backup.kind = backup.kind;
  state.backup.label = backup.label;
  return state;
}

/**
 * Join two existing stores. `init()` on the result connects both sides and
 * decides who serves; failover then happens per request.
 */
export function linkStores(
  primary: RateStore,
  backup: RateStore,
  options: LinkOptions,
  sig: string,
  opts: { probeMs?: number; log?: (msg: string) => void } = {},
): LinkedStore {
  return new LinkedStore(primary, backup, options, stateFor(sig, primary, backup), opts);
}

/**
 * Build the linked store: create both databases and join them. `init()` on the
 * result connects both sides and decides who serves.
 */
export async function createLinkedStore(args: LinkedStoreArgs): Promise<LinkedStore> {
  const [primary, backup] = await Promise.all([args.create(args.primaryConfig), args.create(args.backupConfig)]);
  return linkStores(primary, backup, args.options, args.sig, { probeMs: args.probeMs, log: args.log });
}
