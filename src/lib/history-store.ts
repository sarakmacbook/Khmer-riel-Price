/**
 * Price-history ticks.
 *
 * This used to be a second, independent storage path that read its own env
 * vars (Turso / Upstash / Postgres / memory) — so a database connected later
 * from Telegram would not have powered the chart. It now delegates to the one
 * active `RateStore` (see lib/store), which is exactly the store the Telegram
 * 🗄 menu and /api/database switch, and keeps the same exported API for the
 * routes that consume ticks:
 *
 *   /api/rate            → getLatestTick / saveTick
 *   /api/rate/history    → loadTicks + seedHistoryIfEmpty
 *   /api/cron/update-rate→ getLatestTick / saveTick
 *   /api/health          → pingStore / storeDiagnostics
 *   /api/telegram/test   → getLatestTick
 */

import { activeSignature, getStore, getStoreOrMemory, activeStoreKind, MEMORY_LABEL } from './store';
import { detectAll } from './store/env';
import { errMsg, type Point, type StoreKind } from './store/types';

export interface Tick {
  rate: number;
  bid: number;
  ask: number;
  timestamp: Date | string;
}

/** Superset of the old union — any backend the store layer supports. */
export type StoreBackend = StoreKind;

/**
 * Which backend is active. Synchronous (routes and diagnostics read it without
 * awaiting); after the first store call on an instance it reflects the database
 * actually in use, including a Telegram-connected one.
 */
export function storeBackend(): StoreBackend {
  return activeStoreKind();
}

/** Env keys that provide a database (names only — never values) + the active backend. */
export function storeDiagnostics() {
  const detected = (() => {
    try {
      return detectAll().map((c) => ({ kind: c.kind, label: c.label, envVars: c.envVars }));
    } catch {
      return [];
    }
  })();
  const backend = storeBackend();
  return {
    env: {
      // Backwards-compatible flags for the three "classic" integrations.
      turso: detected.some((d) => d.kind === 'turso'),
      upstash: detected.some((d) => d.kind === 'upstash' || d.kind === 'redis'),
      postgres: detected.some((d) => d.kind === 'postgres'),
    },
    detected,
    backend,
    label: backend === 'memory' ? MEMORY_LABEL : detected.find((d) => d.kind === backend)?.label ?? backend,
  };
}

/** Latest stored tick, or null when nothing has ever been recorded. */
export async function getLatestTick(): Promise<Tick | null> {
  const store = await getStoreOrMemory();
  const row = await store.latest();
  if (!row) return null;
  return { rate: row.bid, bid: row.bid, ask: row.ask, timestamp: new Date(row.t).toISOString() };
}

/** Persist a tick. No-ops safely (returns false) when the backend is unavailable. */
export async function saveTick(q: { rate: number; bid: number; ask: number }): Promise<boolean> {
  try {
    const store = await getStoreOrMemory();
    await store.record({ bid: q.bid, ask: q.ask }, Date.now());
    return true;
  } catch (error) {
    console.error('saveTick failed (continuing):', error);
    return false;
  }
}

/**
 * History ticks for a window, **newest first** (matches the order the history
 * route expects before it reverses them).
 */
export async function loadTicks(windowMs: number | null, limit = 3000): Promise<Tick[]> {
  const store = await getStoreOrMemory();
  const since = windowMs ? Date.now() - windowMs : 0;
  const points = await store.range(since);
  return points
    .slice(-limit)
    .reverse()
    .map((p) => ({ rate: p.bid, bid: p.bid, ask: p.ask, timestamp: new Date(p.t).toISOString() }));
}

// ---------------------------------------------------------------------------
// First-run seeding — fill ~365 daily snapshots on a freshly connected
// database so the chart is useful immediately on every backend type.
// ---------------------------------------------------------------------------
function buildDailySeed(): Point[] {
  const now = Date.now();
  const out: Point[] = [];
  let currentVal = 4054;
  for (let i = 365; i >= 1; i--) {
    const dt = new Date(now - i * 24 * 60 * 60 * 1000);
    dt.setUTCHours(9, 0, 0, 0);
    const target = i < 30 ? 4054 : 4075;
    const noise = Math.sin(i * 0.3) * 3 + ((i % 5) - 2);
    currentVal = Math.round(currentVal + (target - currentVal) * 0.05 + noise);
    currentVal = Math.min(4105, Math.max(4040, currentVal));
    out.push({ bid: currentVal, ask: currentVal + 8, t: dt.getTime() });
  }
  return out;
}

/** Signature of the store we already seeded, so a switch re-seeds the new one exactly once. */
let seededFor: string | null = null;

export async function seedHistoryIfEmpty(): Promise<void> {
  const sig = activeSignature();
  if (seededFor === sig) return;

  try {
    const store = await getStoreOrMemory();
    if (!store.backfill) {
      seededFor = sig; // backend cannot batch-insert — history accumulates from live ticks
      return;
    }
    const stats = (await store.stats().catch(() => null)) as Record<string, unknown> | null;
    const rows = Number(stats?.rows ?? 0);
    if (Number.isFinite(rows) && rows >= 50) {
      seededFor = sig;
      return;
    }

    const written = await store.backfill(buildDailySeed());
    console.log(`[history] seeded ${written} daily snapshots into ${store.label}`);
    seededFor = sig;
  } catch (error) {
    console.error('history seeding skipped:', errMsg(error));
  }
}

/** Cheap liveness probe used by /api/health — throws when the database is unreachable. */
export async function pingStore(): Promise<boolean> {
  const store = await getStore();
  await store.latest();
  return true;
}
