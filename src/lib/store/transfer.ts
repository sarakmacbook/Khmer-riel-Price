/**
 * Copying stored data between two databases — "move my data across cloud
 * storage".
 *
 * Used by the backup/link feature (see `linked.ts`) but deliberately generic:
 * it accepts any two `RateStore`s, so it can seed a fresh database, repair a
 * backup that missed a few writes, restore the primary after an outage, or
 * migrate from an old database to a brand-new one — including across different
 * backends (Postgres → Turso, MongoDB → Redis, …).
 *
 * Guarantees:
 *  • **Idempotent** — history rows are de-duplicated on (timestamp, bid, ask)
 *    and alert subscriptions on their natural key (chat/webhook + condition +
 *    target), so running a copy twice never doubles anything.
 *  • **Bounded** — never copies more than `limit` history points in one run
 *    (the newest are kept); the caller always gets an explicit `truncated` flag.
 *  • **Non-destructive by default** — `mode: 'merge'` only adds/updates.
 *    `mode: 'replace'` clears the target first and refuses to run if the
 *    target backend has no `wipe()`.
 *  • **Dry-run capable** — `dryRun: true` reports exactly what would happen.
 */

import {
  type AlertInput,
  type AlertRecord,
  type Point,
  type RateStore,
  type StoreKind,
  errDetail,
  errMsg,
} from './types';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Stable identity of an alert across backends (row ids are per-database). */
export function alertKey(a: Pick<AlertRecord, 'source' | 'chatId' | 'webhookUrl' | 'condition' | 'targetRate'>): string {
  return [a.source, a.chatId ?? '', a.webhookUrl ?? '', a.condition, a.targetRate ?? ''].join('|');
}

/** Stable identity of one history tick (timestamps are stored at ms precision). */
const pointKey = (p: Point) => `${p.t}|${p.bid}|${p.ask}`;

export const DEFAULT_TRANSFER_LIMIT = Number(process.env.LINK_COPY_LIMIT) || 20_000;

export type TransferMode = 'merge' | 'replace';

export interface TransferOptions {
  /** Copy price history (default true). */
  history?: boolean;
  /** Copy saved alerts / Telegram subscriptions (default true). */
  alerts?: boolean;
  /** Only history at/after this epoch ms (default: everything). */
  since?: number | null;
  mode?: TransferMode;
  dryRun?: boolean;
  /** Safety cap on history points copied per run (default 20 000). */
  limit?: number;
}

export interface TransferCounts {
  /** Rows/records found at the source */
  found: number;
  /** New rows/records written to the target */
  copied: number;
  /** Existing target rows/records updated (alerts only) */
  updated: number;
  /** Records already present at the target — nothing to do */
  skipped: number;
  /** Records present at the target but not at the source (merge mode leaves them) */
  targetOnly: number;
}

export interface TransferResult {
  ok: boolean;
  dryRun: boolean;
  mode: TransferMode;
  ms: number;
  source: { kind: StoreKind; label: string };
  target: { kind: StoreKind; label: string };
  history: (TransferCounts & { truncated: boolean }) | null;
  alerts: TransferCounts | null;
  /** Human-readable notes (truncation, skipped capabilities, replace warnings). */
  warnings: string[];
  error?: string;
}

const emptyCounts = (): TransferCounts => ({ found: 0, copied: 0, updated: 0, skipped: 0, targetOnly: 0 });

// ---------------------------------------------------------------------------
// Store summaries (used by the status cards)
// ---------------------------------------------------------------------------

export interface StoreSummary {
  kind: StoreKind;
  label: string;
  reachable: boolean;
  ms: number;
  error: string | null;
  stats: Record<string, unknown> | null;
  /** Row count when the backend reports one. */
  rows: number | null;
  /** Newest stored price time (epoch ms) when known. */
  latest: number | null;
  alerts: number | null;
}

const rowsOf = (stats: Record<string, unknown> | null): number | null => {
  const raw = stats?.rows ?? stats?.count;
  const n = typeof raw === 'number' ? raw : raw === undefined || raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Reachability + contents of one database, never throwing: every field is
 * filled best-effort so a status card can always be rendered.
 */
export async function describeStore(store: RateStore, opts: { timeoutMs?: number } = {}): Promise<StoreSummary> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.LINK_PROBE_TIMEOUT_MS) || 8_000);
  const out: StoreSummary = {
    kind: store.kind,
    label: store.label,
    reachable: false,
    ms: 0,
    error: null,
    stats: null,
    rows: null,
    latest: null,
    alerts: null,
  };

  const withTimeout = <T>(p: Promise<T>, what: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs}ms`)), timeoutMs);
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

  try {
    await withTimeout(store.init(), 'connect');
    const [latest, stats, alerts] = await Promise.all([
      withTimeout(store.latest(), 'read latest').catch(() => null),
      withTimeout(store.stats(), 'read stats').catch(() => null),
      withTimeout(store.listAlerts(), 'read alerts').catch(() => null),
    ]);
    out.reachable = true;
    out.stats = (stats ?? null) as Record<string, unknown> | null;
    out.rows = rowsOf(out.stats);
    out.latest = latest?.t ?? null;
    out.alerts = alerts ? alerts.length : null;
  } catch (e) {
    out.error = errDetail(e);
  }
  out.ms = Date.now() - started;
  return out;
}

/** Alert-merge helper: find the target record that corresponds to `alert`. */
function matchAlert(target: AlertRecord[], alert: AlertRecord): AlertRecord | null {
  const byId = target.find((t) => t.id === alert.id);
  if (byId) return byId;
  const key = alertKey(alert);
  return target.find((t) => alertKey(t) === key) ?? null;
}

// ---------------------------------------------------------------------------
// The transfer
// ---------------------------------------------------------------------------

/**
 * Copy history and/or alerts from `source` into `target`.
 * Never throws: failures are returned as `{ ok: false, error }` together with
 * whatever was achieved before the failure.
 */
export async function transferStore(
  source: RateStore,
  target: RateStore,
  opts: TransferOptions = {},
): Promise<TransferResult> {
  const started = Date.now();
  const mode: TransferMode = opts.mode === 'replace' ? 'replace' : 'merge';
  const dryRun = Boolean(opts.dryRun);
  const wantHistory = opts.history !== false;
  const wantAlerts = opts.alerts !== false;
  const limit = Math.max(1, opts.limit ?? DEFAULT_TRANSFER_LIMIT);
  const since = typeof opts.since === 'number' && Number.isFinite(opts.since) ? opts.since : null;

  const result: TransferResult = {
    ok: true,
    dryRun,
    mode,
    ms: 0,
    source: { kind: source.kind, label: source.label },
    target: { kind: target.kind, label: target.label },
    history: wantHistory ? { ...emptyCounts(), truncated: false } : null,
    alerts: wantAlerts ? emptyCounts() : null,
    warnings: [],
  };

  try {
    await Promise.all([source.init(), target.init()]);

    // A "replace" copy must be able to erase the target (and write history back)
    // — checked before anything is touched, so a refusal changes nothing.
    if (mode === 'replace' && !dryRun) {
      if (!target.wipe) {
        throw new Error(
          `${target.label} cannot erase its stored data (no wipe support), so a replace copy is not possible. Use mode "merge" instead.`,
        );
      }
      if (!target.backfill) {
        throw new Error(`${target.label} cannot bulk-insert history, so a replace copy is not possible. Use mode "merge" instead.`);
      }
    }

    // ---- history ---------------------------------------------------------
    if (wantHistory && result.history) {
      const found = await source.range(since ?? 0);
      const truncated = found.length > limit;
      const points = truncated ? found.slice(found.length - limit) : found; // newest win
      result.history.found = found.length;
      if (truncated) {
        result.warnings.push(
          `Only the newest ${limit.toLocaleString()} of ${found.length.toLocaleString()} history rows are copied in one run (LINK_COPY_LIMIT).`,
        );
      }

      const from = points.length ? points[0].t : (since ?? 0);
      const existing = new Set((await target.range(from)).map(pointKey));
      const missing = points.filter((p) => !existing.has(pointKey(p)));
      result.history.skipped = points.length - missing.length;

      if (mode === 'replace') {
        // Erase the target's history, then write the source rows: the result is
        // an exact copy of the source's history (within the copy limit).
        result.history.copied = points.length;
        if (!dryRun) {
          await target.wipe!({ history: true, alerts: false });
          if (points.length) await target.backfill!(points);
        }
        if (truncated) {
          result.warnings.push(
            `Replace erased ${target.label} but only the newest ${limit.toLocaleString()} rows were written back — raise LINK_COPY_LIMIT for a full copy.`,
          );
        }
      } else {
        result.history.copied = missing.length;
        if (!dryRun && missing.length) {
          if (!target.backfill) {
            result.warnings.push(
              `${target.label} cannot bulk-insert history — its rows are written one tick at a time, so only alerts were copied.`,
            );
            result.history.copied = 0;
          } else {
            result.history.copied = await target.backfill(missing);
          }
        }
      }
    }

    // ---- alerts ----------------------------------------------------------
    if (wantAlerts && result.alerts) {
      const sourceAlerts = await source.listAlerts();
      result.alerts.found = sourceAlerts.length;

      if (mode === 'replace' && !dryRun) await target.wipe!({ history: false, alerts: true });

      const targetAlerts = mode === 'replace' && !dryRun ? [] : await target.listAlerts();
      const consumed = new Set<string>();

      for (const alert of sourceAlerts) {
        const match = matchAlert(targetAlerts, alert);
        if (match) consumed.add(match.id);

        if (!match) {
          result.alerts.copied += 1;
          if (!dryRun) await target.saveAlert({ ...alert, id: undefined } as AlertInput);
          continue;
        }

        const same =
          alert.active === match.active &&
          alert.condition === match.condition &&
          alert.targetRate === match.targetRate &&
          (alert.customMessage ?? null) === (match.customMessage ?? null) &&
          (alert.chatId ?? null) === (match.chatId ?? null) &&
          (alert.webhookUrl ?? null) === (match.webhookUrl ?? null) &&
          (alert.botToken ?? null) === (match.botToken ?? null);
        if (same) {
          result.alerts.skipped += 1;
          continue;
        }

        result.alerts.updated += 1;
        if (!dryRun) {
          await target.saveAlert({
            ...alert,
            id: match.id, // keep the target's own id format (serial / ObjectId / sequence)
            createdAt: match.createdAt,
          } as AlertInput);
        }
      }

      result.alerts.targetOnly = targetAlerts.filter((a) => !consumed.has(a.id)).length;
      if (result.alerts.targetOnly && mode === 'merge') {
        result.warnings.push(
          `${result.alerts.targetOnly} alert(s) exist only in ${target.label} and were left untouched (merge mode never deletes).`,
        );
      }
    }
  } catch (e) {
    result.ok = false;
    result.error = errDetail(e) || errMsg(e);
  }

  result.ms = Date.now() - started;
  return result;
}

/**
 * Bring `target` up to date with `source`, copying only what changed recently.
 * Used after a failover to move the ticks the backup recorded back into the
 * primary (and by the cron to heal a lagging mirror).
 */
export async function catchUp(
  source: RateStore,
  target: RateStore,
  opts: { since?: number | null; limit?: number; alerts?: boolean; dryRun?: boolean } = {},
): Promise<TransferResult> {
  return transferStore(source, target, {
    since: opts.since ?? null,
    limit: opts.limit ?? (Number(process.env.LINK_RESYNC_LIMIT) || 5_000),
    alerts: opts.alerts ?? true,
    history: true,
    mode: 'merge',
    dryRun: opts.dryRun,
  });
}

/** Compact one-line description of a transfer, for logs and chat replies. */
export function summarizeTransfer(r: TransferResult): string {
  const parts: string[] = [];
  if (r.history) {
    parts.push(`${r.history.copied} history row${r.history.copied === 1 ? '' : 's'} copied`);
    if (r.history.skipped) parts.push(`${r.history.skipped} already there`);
  }
  if (r.alerts) {
    parts.push(`${r.alerts.copied} alert${r.alerts.copied === 1 ? '' : 's'} added`);
    if (r.alerts.updated) parts.push(`${r.alerts.updated} updated`);
  }
  const head = `${r.source.label} → ${r.target.label}`;
  return `${head}: ${parts.join(', ') || 'nothing to copy'} (${r.ms} ms)${r.dryRun ? ' [dry run]' : ''}`;
}
