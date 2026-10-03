/**
 * Periodic caretaker for the linked backup database.
 *
 * The linked store mirrors writes and fails over on its own (see
 * lib/store/linked.ts). Two things still need a nudge, and both are cheap enough
 * to run from the 5-minute cron:
 *
 *  1. **Failover catch-up** — rows the backup recorded while the primary was
 *     down have to be copied back once it returns.
 *  2. **Mirror repair** — if the backup missed writes (it was down, a mirror
 *     timed out), copy the gap across so the second database is a live copy
 *     again instead of a stale one.
 *
 * Both are bounded by `LINK_RESYNC_LIMIT` (default 5 000 rows per run) and only
 * look at rows newer than the side that is behind, so a cron tick stays light.
 */

import { activeConfig, activeLink, createStore, currentLinkSignature } from './store';
import { linkStateOf } from './store/linked';
import { configFromSpec } from './store/env';
import { catchUp, describeStore, type TransferResult } from './store/transfer';
import { errDetail } from './store/types';

export interface LinkJobResult {
  /** true when data was actually copied */
  ran: boolean;
  reason?: string;
  actions: TransferResult[];
  error?: string;
}

/** How far behind the backup may be before the job repairs it. */
const MAX_LAG_MS = Number(process.env.LINK_MAX_LAG_SECONDS) * 1_000 || 15 * 60_000;

export async function runLinkMaintenance(): Promise<LinkJobResult> {
  try {
    const link = await activeLink();
    if (!link) return { ran: false, reason: 'no backup linked', actions: [] };
    if (!link.options.autoResync) return { ran: false, reason: 'auto re-sync is disabled', actions: [] };

    const { cfg, choice } = await activeConfig();
    if (choice.mode === 'memory' || cfg.kind === 'memory') {
      return { ran: false, reason: 'no primary database', actions: [] };
    }

    const backupCfg = configFromSpec(link.spec);
    const [primaryStore, backupStore] = await Promise.all([createStore(cfg), createStore(backupCfg)]);
    const [primary, backup] = await Promise.all([describeStore(primaryStore), describeStore(backupStore)]);

    if (!backup.reachable) return { ran: false, reason: 'backup unreachable', actions: [] };
    if (!primary.reachable) return { ran: false, reason: 'primary unreachable — the backup is serving', actions: [] };

    const state = linkStateOf(await currentLinkSignature());
    const actions: TransferResult[] = [];

    // 1. Rows written to the backup during a failover → back into the primary.
    if (state?.counters.pendingResync) {
      const since = primary.latest !== null ? Math.max(0, primary.latest - 1_000) : null;
      const result = await catchUp(backupStore, primaryStore, { since, alerts: true });
      actions.push(result);
      if (result.ok && state) {
        state.counters.pendingResync = false;
        state.counters.resyncs += 1;
        state.counters.lastResyncAt = Date.now();
        state.counters.lastResyncResult = result;
        state.counters.lastResyncError = null;
      } else if (state) {
        state.counters.lastResyncError = result.error ?? 'unknown error';
      }
    }

    // 2. Mirror repair: the backup is behind → copy the missing window across.
    const lagMs = primary.latest !== null && backup.latest !== null ? primary.latest - backup.latest : 0;
    if (lagMs > MAX_LAG_MS) {
      const since = Math.max(0, (backup.latest ?? 0) - 1_000);
      actions.push(await catchUp(primaryStore, backupStore, { since, alerts: true }));
    }

    const copied = actions.reduce((n, a) => n + (a.history?.copied ?? 0) + (a.alerts?.copied ?? 0), 0);
    return { ran: copied > 0, reason: copied > 0 ? undefined : 'already in sync', actions };
  } catch (e) {
    return { ran: false, error: errDetail(e), actions: [] };
  }
}
