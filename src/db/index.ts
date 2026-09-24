import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/** Drizzle client over `pg` with the app schema loaded (relational queries available). */
export type Db = NodePgDatabase<typeof schema>;

// Accept every name Vercel's database integrations use:
//  • Neon integration            → DATABASE_URL (+ DATABASE_URL_UNPOOLED)
//  • Vercel Postgres (legacy)     → POSTGRES_URL / POSTGRES_PRISMA_URL
//  • Supabase integration         → SUPABASE_DB_URL / POSTGRES_URL
//  • self-hosted / Docker / .env  → DATABASE_URL
// NOTE: we must NEVER throw at import time — a missing env var on Vercel
// would otherwise 500 every API route before a single line runs.
const databaseUrl =
  process.env.POSTGRES_URL ??
  process.env.POSTGRES_PRISMA_URL ??
  process.env.DATABASE_URL ??
  process.env.SUPABASE_DB_URL ??
  process.env.POSTGRES_URL_NON_POOLING ??
  undefined;

// Cache pools on globalThis (keyed by URL): serverless invocations reuse the
// same container, so this keeps connection usage to a handful per warm instance
// instead of exhausting the database limit on every cold start.
const globalForDb = globalThis as typeof globalThis & { __wingRatePools?: Map<string, Pool> };

function makePool(url: string): Pool {
  // Local/self-hosted Postgres usually rejects TLS; hosted (Neon, Supabase,
  // Vercel Postgres, Railway) requires it.
  const isLocal = /localhost|127\.0\.0\.1|::1|@db:/.test(url);
  return new Pool({
    connectionString: url,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
  });
}

function pooled(url: string): Pool {
  const pools = (globalForDb.__wingRatePools ??= new Map<string, Pool>());
  let pool = pools.get(url);
  if (!pool) {
    pool = makePool(url);
    pools.set(url, pool);
  }
  return pool;
}

/**
 * Connect (or reuse the cached pool) for an explicit Postgres URL — used by
 * the Postgres rate store, which may target a different database than the
 * env-configured one. Never throws at import time.
 */
export function connectPostgres(url: string): { db: Db; pool: Pool } {
  const pool = pooled(url);
  return { db: drizzle(pool, { schema }), pool };
}

export function getPool(): Pool | null {
  if (!databaseUrl) return null;
  return pooled(databaseUrl);
}

const pool = getPool();
const realDb = pool ? drizzle(pool, { schema }) : null;

// Fallback stub: any access throws a clear, catchable error so routes can
// gracefully degrade (live-scraper endpoints keep working with no database).
const missingDb = {
  query: new Proxy(
    {},
    {
      get() {
        throw new Error("DATABASE_URL/POSTGRES_URL not configured");
      },
    },
  ),
  insert: () => {
    throw new Error("DATABASE_URL/POSTGRES_URL not configured");
  },
  update: () => {
    throw new Error("DATABASE_URL/POSTGRES_URL not configured");
  },
  execute: () => {
    throw new Error("DATABASE_URL/POSTGRES_URL not configured");
  },
};

export const db: any = realDb ?? missingDb;
export const hasDatabase = Boolean(realDb);
