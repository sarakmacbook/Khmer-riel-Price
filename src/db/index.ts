import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

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

// Local/self-hosted Postgres usually rejects TLS; hosted (Neon, Supabase,
// Vercel Postgres, Railway) requires it.
const isLocal = !databaseUrl || /localhost|127\.0\.0\.1|::1|@db:/.test(databaseUrl);

// Cache the pool on globalThis: serverless invocations reuse the same
// container, so this keeps connection usage to a handful per warm instance
// instead of exhausting the database limit on every cold start.
const globalForDb = globalThis as typeof globalThis & { __wingRatePool?: Pool };

export function getPool(): Pool | null {
  if (!databaseUrl) return null;
  if (!globalForDb.__wingRatePool) {
    globalForDb.__wingRatePool = new Pool({
      connectionString: databaseUrl,
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalForDb.__wingRatePool;
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
