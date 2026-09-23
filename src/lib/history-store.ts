/**
 * Storage adapter for price-history ticks.
 *
 * Automatically picks whichever free-tier database the deployment provides
 * (Vercel Marketplace integrations all expose their own env vars):
 *
 *   1. Turso / libSQL      → TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN)
 *   2. Upstash Redis       → UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *   3. Neon / Supabase /
 *      Vercel Postgres     → POSTGRES_URL | POSTGRES_PRISMA_URL | DATABASE_URL
 *   4. No database at all  → in-memory ring buffer (dev / demo only)
 *
 * All backends expose the same shape so /api/rate, /api/rate/history and the
 * cron job never care which one is configured.
 */
import { db, hasDatabase } from "@/db";
import { exchangeRates } from "@/db/schema";
import { desc, gte } from "drizzle-orm";
import type { Client as LibsqlClient } from "@libsql/client";
import { ensurePostgresSchema } from "./ensure-schema";

export interface Tick {
  rate: number;
  bid: number;
  ask: number;
  timestamp: Date | string;
}

export type StoreBackend = "turso" | "upstash" | "postgres" | "memory";

const TURSO_URL = process.env.TURSO_DATABASE_URL ?? process.env.LIBSQL_URL ?? process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN ?? process.env.LIBSQL_AUTH_TOKEN ?? process.env.TURSO_TOKEN;
// Upstash Redis direct integration OR Vercel KV (which is Upstash underneath)
const UP_URL =
  process.env.UPSTASH_REDIS_REST_URL ??
  process.env.KV_REST_API_URL ??
  process.env.REDIS_REST_URL;
const UP_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ??
  process.env.KV_REST_API_TOKEN ??
  process.env.REDIS_REST_TOKEN;
const PG_URL =
  process.env.POSTGRES_URL ??
  process.env.POSTGRES_PRISMA_URL ??
  process.env.DATABASE_URL ??
  process.env.SUPABASE_DB_URL ??
  process.env.POSTGRES_URL_NON_POOLING ??
  process.env.DATABASE_URL_UNPOOLED;

// Which env keys are present (for /api/health diagnostics — names only).
export function storeDiagnostics() {
  return {
    env: {
      turso: Boolean(TURSO_URL),
      upstash: Boolean(UP_URL && UP_TOKEN),
      postgres: Boolean(PG_URL),
    },
    backend: storeBackend(),
  };
}

export function storeBackend(): StoreBackend {
  if (TURSO_URL) return "turso";
  if (UP_URL && UP_TOKEN) return "upstash";
  if (PG_URL) return "postgres";
  return "memory";
}

// ---------------------------------------------------------------------------
// In-memory fallback (module/global cache)
// ---------------------------------------------------------------------------
const g = globalThis as typeof globalThis & {
  __wingMemoryTicks?: Tick[];
  __wingLatest?: { tick: Tick; at: number } | undefined;
};

function memoryTicks(): Tick[] {
  if (!g.__wingMemoryTicks) g.__wingMemoryTicks = [];
  return g.__wingMemoryTicks;
}

// ---------------------------------------------------------------------------
// Turso / libSQL (free tier) — SQLite dialect, table auto-created
// ---------------------------------------------------------------------------
let libsql: LibsqlClient | null = null;
async function getLibsql(): Promise<LibsqlClient> {
  if (!libsql) {
    const { createClient } = await import("@libsql/client");
    libsql = createClient({ url: TURSO_URL!, authToken: TURSO_TOKEN });
    await libsql.execute(
      `CREATE TABLE IF NOT EXISTS exchange_rates (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         rate REAL NOT NULL,
         bid REAL,
         ask REAL,
         timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       )`,
    );
  }
  return libsql;
}

// ---------------------------------------------------------------------------
// Upstash Redis (free tier) — plain REST, no SDK dependency
// ---------------------------------------------------------------------------
async function upstash(cmd: (string | number)[]): Promise<any> {
  const res = await fetch(UP_URL!, {
    method: "POST",
    headers: { Authorization: `Bearer ${UP_TOKEN!}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(data?.error || `Upstash HTTP ${res.status}`);
  return data.result;
}

const UP_KEY_LATEST = "wing:rate:latest";
const UP_KEY_TICKS = "wing:rate:ticks"; // list, newest first, capped
const UP_MAX_TICKS = 5000;
// Keep Upstash inside the free-tier command budget (10k/day).
const UP_HIST_MIN_INTERVAL_MS = 10 * 60 * 1000;
let upHistLastPush = 0;

function parseTick(raw: any): Tick | null {
  try {
    const t = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (t && typeof t.rate === "number") return t as Tick;
  } catch {
    /* ignore malformed entries */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Latest tick (5s module cache so 1s polling stays cheap on every backend)
// ---------------------------------------------------------------------------
const LATEST_CACHE_MS = 5000;

export async function getLatestTick(): Promise<Tick | null> {
  const cached = g.__wingLatest;
  if (cached && Date.now() - cached.at < LATEST_CACHE_MS) return cached.tick;

  const backend = storeBackend();
  let tick: Tick | null = null;

  if (backend === "memory") {
    const arr = memoryTicks();
    tick = arr.length ? arr[arr.length - 1] : null;
  } else if (backend === "upstash") {
    tick = parseTick(await upstash(["GET", UP_KEY_LATEST]));
  } else if (backend === "turso") {
    const res = await (await getLibsql()).execute({
      sql: "SELECT rate, bid, ask, timestamp FROM exchange_rates ORDER BY timestamp DESC LIMIT 1",
      args: [],
    });
    const r = res.rows[0] as any;
    if (r) tick = { rate: Number(r.rate), bid: Number(r.bid ?? r.rate), ask: Number(r.ask ?? r.rate), timestamp: String(r.timestamp) };
  } else {
    await ensurePostgresSchema();
    const rows = await db.query.exchangeRates.findFirst({
      orderBy: [desc(exchangeRates.timestamp)],
    });
    if (rows) {
      tick = {
        rate: parseFloat(rows.rate),
        bid: rows.bid ? parseFloat(rows.bid) : parseFloat(rows.rate),
        ask: rows.ask ? parseFloat(rows.ask) : parseFloat(rows.rate),
        timestamp: rows.timestamp,
      };
    }
  }

  if (tick) g.__wingLatest = { tick, at: Date.now() };
  return tick;
}

/** Persist a tick. No-ops safely when the backend is unavailable. */
export async function saveTick(q: { rate: number; bid: number; ask: number }): Promise<boolean> {
  const backend = storeBackend();
  // On Postgres (Neon/Supabase/Vercel) make sure the table exists first —
  // Vercel deployments have no `drizzle-kit push` step.
  if (backend === "postgres") {
    await ensurePostgresSchema();
  }
  const now = new Date().toISOString();
  const tick: Tick = { rate: q.rate, bid: q.bid, ask: q.ask, timestamp: now };

  try {
    const prev = await getLatestTick();
    const changed =
      !prev ||
      prev.bid !== q.bid ||
      prev.ask !== q.ask ||
      prev.rate !== q.rate;
    const lastPushAt = g.__wingLatest?.at ?? 0;
    const dueForHistoryPush =
      changed || Date.now() - lastPushAt > UP_HIST_MIN_INTERVAL_MS;

    if (backend === "memory") {
      if (changed) memoryTicks().push(tick);
      g.__wingLatest = { tick, at: Date.now() };
      return true;
    }

    if (backend === "upstash") {
      await upstash(["SET", UP_KEY_LATEST, JSON.stringify(tick)]);
      if (dueForHistoryPush) {
        await upstash(["LPUSH", UP_KEY_TICKS, JSON.stringify(tick)]);
        await upstash(["LTRIM", UP_KEY_TICKS, 0, UP_MAX_TICKS - 1]);
        upHistLastPush = Date.now();
      }
      g.__wingLatest = { tick, at: Date.now() };
      return true;
    }

    if (!changed) {
      g.__wingLatest = { tick, at: Date.now() };
      return true;
    }

    if (backend === "turso") {
      await (await getLibsql()).execute({
        sql: "INSERT INTO exchange_rates (rate, bid, ask, timestamp) VALUES (?, ?, ?, ?)",
        args: [q.rate, q.bid, q.ask, now],
      });
    } else {
      await db.insert(exchangeRates).values({
        rate: q.rate.toString(),
        bid: q.bid.toString(),
        ask: q.ask.toString(),
      });
    }

    g.__wingLatest = { tick, at: Date.now() };
    return true;
  } catch (error) {
    console.error("saveTick failed (continuing):", error);
    return false;
  }
}

/**
 * History ticks for a window, **newest first** (matches the old drizzle
 * query order that the route's `.reverse()` expects).
 */
export async function loadTicks(windowMs: number | null, limit = 3000): Promise<Tick[]> {
  const backend = storeBackend();

  if (backend === "memory") {
    const arr = memoryTicks();
    if (!windowMs) return arr.slice(-limit).reverse();
    const cutoff = Date.now() - windowMs;
    return arr.filter((t) => new Date(t.timestamp).getTime() >= cutoff).slice(-limit).reverse();
  }

  if (backend === "upstash") {
    const raws = (await upstash(["LRANGE", UP_KEY_TICKS, 0, limit - 1])) as any[];
    const ticks = (raws ?? []).map(parseTick).filter(Boolean) as Tick[];
    if (!windowMs) return ticks; // list already newest-first
    const cutoff = Date.now() - windowMs;
    return ticks.filter((t) => new Date(t.timestamp).getTime() >= cutoff);
  }

  if (backend === "turso") {
    const client = await getLibsql();
    const res = windowMs
      ? await client.execute({
          sql: "SELECT rate, bid, ask, timestamp FROM exchange_rates WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?",
          args: [new Date(Date.now() - windowMs).toISOString(), limit],
        })
      : await client.execute({
          sql: "SELECT rate, bid, ask, timestamp FROM exchange_rates ORDER BY timestamp DESC LIMIT ?",
          args: [limit],
        });
    return (res.rows as any[]).map((r) => ({
      rate: Number(r.rate),
      bid: Number(r.bid ?? r.rate),
      ask: Number(r.ask ?? r.rate),
      timestamp: String(r.timestamp),
    }));
  }

  // Postgres (Neon / Supabase / Vercel Postgres)
  await ensurePostgresSchema();
  const rows = windowMs
    ? await db.query.exchangeRates.findMany({
        where: gte(exchangeRates.timestamp, new Date(Date.now() - windowMs)),
        orderBy: [desc(exchangeRates.timestamp)],
        limit,
      })
    : await db.query.exchangeRates.findMany({
        orderBy: [desc(exchangeRates.timestamp)],
        limit,
      });

  return rows.map((r: any) => ({
    rate: parseFloat(r.rate),
    bid: r.bid ? parseFloat(r.bid) : parseFloat(r.rate),
    ask: r.ask ? parseFloat(r.ask) : parseFloat(r.rate),
    timestamp: r.timestamp,
  }));
}

// ---------------------------------------------------------------------------
// First-run seeding — fill ~365 daily snapshots on a freshly connected
// database so the chart is useful immediately on every backend type.
// ---------------------------------------------------------------------------
function buildDailySeed(): Tick[] {
  const now = new Date();
  const out: Tick[] = [];
  let currentVal = 4054;
  for (let i = 365; i >= 1; i--) {
    const dt = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    dt.setUTCHours(9, 0, 0, 0);
    const target = i < 30 ? 4054 : 4075;
    const noise = Math.sin(i * 0.3) * 3 + ((i % 5) - 2);
    currentVal = Math.round(currentVal + (target - currentVal) * 0.05 + noise);
    currentVal = Math.min(4105, Math.max(4040, currentVal));
    out.push({
      rate: currentVal,
      bid: currentVal,
      ask: currentVal + 8,
      timestamp: dt.toISOString(),
    });
  }
  return out;
}

let seededBackend: StoreBackend | null = null;

export async function seedHistoryIfEmpty(): Promise<void> {
  const backend = storeBackend();
  if (seededBackend === backend) return;

  try {
    let count = 0;
    if (backend === "memory") {
      count = memoryTicks().length;
    } else if (backend === "upstash") {
      count = Number((await upstash(["LLEN", UP_KEY_TICKS])) ?? 0);
    } else if (backend === "turso") {
      const client = await getLibsql();
      const res = await client.execute("SELECT COUNT(*) AS c FROM exchange_rates");
      count = Number((res.rows[0] as any)?.c ?? 0);
    } else {
      return; // Postgres seeding is handled by ensureDailyHistory
    }

    if (count >= 50) {
      seededBackend = backend;
      return;
    }

    const points = buildDailySeed();

    if (backend === "memory") {
      memoryTicks().push(...points);
    } else if (backend === "upstash") {
      // Single Redis command holding all points (newest-first).
      const values = [...points].reverse().map((t) => JSON.stringify(t));
      await upstash(["RPUSH", UP_KEY_TICKS, ...values.slice(0, UP_MAX_TICKS)]);
      await upstash(["SET", UP_KEY_LATEST, JSON.stringify(points[points.length - 1])]);
    } else if (backend === "turso") {
      const client = await getLibsql();
      const stmts = points.map((t) => ({
        sql: "INSERT INTO exchange_rates (rate, bid, ask, timestamp) VALUES (?, ?, ?, ?)",
        args: [t.rate, t.bid, t.ask, t.timestamp],
      }));
      await client.batch(stmts, "write");
    }

    seededBackend = backend;
  } catch (error) {
    console.error("history seeding skipped:", error);
  }
}

/** Cheap liveness probe used by /api/health. */
export async function pingStore(): Promise<boolean> {
  const backend = storeBackend();
  if (backend === "memory") return true;
  if (backend === "upstash") {
    await upstash(["PING"]);
    return true;
  }
  if (backend === "turso") {
    await (await getLibsql()).execute("SELECT 1");
    return true;
  }
  if (!hasDatabase) return false;
  await ensurePostgresSchema();
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`select 1`);
  return true;
}
