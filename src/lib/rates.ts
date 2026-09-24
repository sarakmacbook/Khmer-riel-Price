import { after } from 'next/server';
import { getStoreOrMemory, memoryStore, type RateRow, type RateStore, type StoreKind } from '@/lib/store';
import { errMsg } from '@/lib/store/types';
import { fetchWingBankQuote } from '@/lib/scraper';
import { notifyRateChange } from '@/lib/alerts';

/** Minimum seconds between Wing Bank checks. */
export const REFRESH_MS = Math.max(10, Number(process.env.REFRESH_SECONDS) || 60) * 1000;

export interface LatestRate {
  rate: number;
  bid: number;
  ask: number;
  /** When this price was first seen */
  timestamp: Date;
  /** Last time Wing Bank confirmed this price */
  checkedAt: Date;
  /** Which store served it ('memory' = no persistent database) */
  storage: StoreKind;
}

const toLatest = (r: RateRow, storage: StoreKind): LatestRate => ({
  rate: r.bid,
  bid: r.bid,
  ask: r.ask,
  timestamp: new Date(r.t),
  checkedAt: new Date(r.c),
  storage,
});

// Per-instance cache of the latest row: saves database reads/quota on warm instances.
const g = globalThis as typeof globalThis & {
  __wingrateCache?: { kind: StoreKind; row: RateRow; readAt: number };
  __wingrateLastClaim?: number;
};

// ---- Refresh (scrape + store) ----
let inflight: Promise<LatestRate> | null = null;

/** Deduplicated per instance: concurrent callers share one Wing Bank request. */
export function refreshRate(): Promise<LatestRate> {
  if (!inflight) inflight = doRefresh().finally(() => (inflight = null));
  return inflight;
}

async function recordIn(store: RateStore, q: { bid: number; ask: number }, now: number) {
  const res = await store.record(q, now);
  g.__wingrateCache = { kind: store.kind, row: res.row, readAt: Date.now() };
  if (res.prev && res.changed && store.persistent) {
    await notifyRateChange(res.prev.bid, { ...q, rate: q.bid, fetchedAt: new Date(now).toISOString() }).catch((e) =>
      console.error('[alerts]', errMsg(e)),
    );
  }
  return toLatest(res.row, store.kind);
}

async function doRefresh(): Promise<LatestRate> {
  const quote = await fetchWingBankQuote();
  const now = Date.now();
  const store = await getStoreOrMemory();
  try {
    return await recordIn(store, quote, now);
  } catch (e) {
    console.error(`[${store.kind}] could not store rate, keeping it in memory:`, errMsg(e));
    return recordIn(memoryStore(), quote, now);
  }
}

/** Run a task after the response is sent (Vercel keeps the function alive via waitUntil). */
function runAfterResponse(task: () => Promise<unknown>) {
  const safe = () => task().catch((e) => console.error('[refresh]', errMsg(e)));
  try {
    after(safe);
  } catch {
    void safe(); // outside a request scope
  }
}

/**
 * Latest rate, stale-while-revalidate:
 * 1. cached row on this instance (younger than the store's readTtl) or a fresh read from the store,
 * 2. if older than REFRESH_SECONDS → claim the refresh atomically and re-check Wing Bank in the background,
 * 3. only the very first request (empty store) waits for a live fetch.
 */
export async function getLatestRate(): Promise<LatestRate> {
  let store = await getStoreOrMemory();
  const now = Date.now();
  let row: RateRow | null = null;

  const cached = g.__wingrateCache;
  if (cached && cached.kind === store.kind && now - cached.readAt < store.readTtlMs) {
    row = cached.row;
  } else {
    try {
      row = await store.latest();
      if (row) g.__wingrateCache = { kind: store.kind, row, readAt: now };
    } catch (e) {
      console.error(`[${store.kind}] read failed, falling back to memory:`, errMsg(e));
      store = memoryStore();
      row = await store.latest();
    }
  }

  if (!row) return refreshRate();

  // Stale → at most one claim attempt per instance per 30s, then refresh in the background
  const lastClaim = g.__wingrateLastClaim ?? 0;
  if (now - row.c > REFRESH_MS && now - lastClaim > Math.min(REFRESH_MS, 30_000)) {
    g.__wingrateLastClaim = now;
    const claimed = await store.claimRefresh(now, REFRESH_MS).catch(() => false);
    if (claimed) runAfterResponse(refreshRate);
  }
  return toLatest(row, store.kind);
}
