import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

// Postgres connection used by the Postgres storage adapter (src/lib/store/postgres.ts).
// Works with Neon, Supabase, Prisma Postgres (direct URL), Nile, AWS, local/Docker Postgres.

const MANAGED_HOSTS =
  /(neon\.tech|supabase\.(co|com)|prisma\.io|thenile\.dev|vercel-storage\.com|rds\.amazonaws\.com|render\.com|railway\.app|aivencloud\.com|digitalocean\.com)$/i;

function poolConfig(url: string): PoolConfig {
  const isServerless = Boolean(process.env.VERCEL);
  const base: PoolConfig = {
    max: isServerless ? 3 : 10,
    idleTimeoutMillis: isServerless ? 5_000 : 30_000,
    connectionTimeoutMillis: 10_000,
  };
  try {
    const u = new URL(url);
    const mode = u.searchParams.get('sslmode');
    const wantsTls = (mode !== null && mode !== 'disable') || MANAGED_HOSTS.test(u.hostname);
    // Params pg can't use / would misinterpret
    ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'channel_binding', 'pgbouncer', 'connect_timeout', 'supa'].forEach((p) =>
      u.searchParams.delete(p),
    );
    if (!wantsTls) return { ...base, connectionString: u.toString() };
    // Managed providers require TLS; some poolers use a private CA that strict verification rejects.
    return { ...base, connectionString: u.toString(), ssl: { rejectUnauthorized: false } };
  } catch {
    return { ...base, connectionString: url };
  }
}

export type Db = NodePgDatabase<typeof schema>;

const g = globalThis as typeof globalThis & { __wingratePg?: Map<string, { pool: Pool; db: Db }> };

/** One pool per connection string per instance (reused across requests / hot reloads). */
export function connectPostgres(url: string): { pool: Pool; db: Db } {
  g.__wingratePg ??= new Map();
  let conn = g.__wingratePg.get(url);
  if (!conn) {
    const pool = new Pool(poolConfig(url));
    pool.on('error', (err) => console.error('[postgres] pool error', err.message)); // never crash on idle errors
    conn = { pool, db: drizzle(pool, { schema }) };
    g.__wingratePg.set(url, conn);
  }
  return conn;
}
