import { drizzle } from "drizzle-orm/node-postgres";
import { drizzle as drizzleVercel } from "drizzle-orm/vercel-postgres";
import { Pool } from "pg";
import { sql } from "@vercel/postgres";
import * as schema from './schema';

const databaseUrl = process.env.DATABASE_URL;

// Detect if we are on Vercel (where we should use the specialized vercel-postgres driver)
const isVercel = process.env.VERCEL === '1' || !!process.env.VERCEL_URL;

let db: any;

if (isVercel) {
  db = drizzleVercel(sql, { schema });
} else {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const globalForDb = globalThis as typeof globalThis & {
    __arenaNextJsPostgresqlPool?: Pool;
  };

  const pool =
    globalForDb.__arenaNextJsPostgresqlPool ??
    new Pool({
      connectionString: databaseUrl,
    });

  if (process.env.NODE_ENV !== "production") {
    globalForDb.__arenaNextJsPostgresqlPool = pool;
  }

  db = drizzle(pool, { schema });
}

export { db };
