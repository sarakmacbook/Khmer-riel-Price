import type { StoreKind } from './types';

// ---------------------------------------------------------------------------
// Auto-detect the database from environment variables.
// Works with the exact names Vercel Marketplace integrations inject, and with
// custom prefixes chosen when connecting (e.g. MYDB_POSTGRES_URL).
// Force a specific backend with STORAGE=postgres|turso|mongodb|upstash|redis|blob|memory
// ---------------------------------------------------------------------------

export interface StoreConfig {
  kind: StoreKind;
  label: string;
  /** Env var names this config came from (never the values) */
  envVars: string[];
  url?: string;
  token?: string;
}

export const DETECTION_ORDER: StoreKind[] = ['postgres', 'turso', 'mongodb', 'upstash', 'redis', 'blob'];

type Entry = [key: string, value: string];

function envEntries(): Entry[] {
  return Object.entries(process.env).filter((e): e is Entry => typeof e[1] === 'string' && e[1].trim() !== '');
}

/** Find env vars whose name equals/ends with one of `suffixes` and whose value matches `test`. Exact names first. */
function find(suffixes: string[], test: RegExp): Entry | null {
  const rank = (k: string) => {
    const i = suffixes.findIndex((s) => k === s || k.endsWith(`_${s}`));
    return i * 2 + (suffixes.includes(k) ? 0 : 1) + (/UNPOOLED|NON_POOLING|DIRECT/.test(k) ? 100 : 0);
  };
  const hits = envEntries().filter(([k, v]) => test.test(v.trim()) && suffixes.some((s) => k === s || k.endsWith(`_${s}`)));
  hits.sort((a, b) => rank(a[0]) - rank(b[0]));
  return hits[0] ? [hits[0][0], hits[0][1].trim()] : null;
}

/** Token that pairs with `urlKey` (same prefix preferred). */
function findToken(urlKey: string, urlSuffix: string, tokenSuffixes: string[]): Entry | null {
  const prefix = urlKey.slice(0, urlKey.length - urlSuffix.length);
  for (const s of tokenSuffixes) {
    const v = process.env[prefix + s]?.trim();
    if (v) return [prefix + s, v];
  }
  return find(tokenSuffixes, /.+/);
}

function hostOf(url: string) {
  try {
    return new URL(url.replace(/^[a-z+]+:\/\//i, 'http://')).hostname;
  } catch {
    return '';
  }
}

function postgresLabel(url: string) {
  const h = hostOf(url);
  if (/neon\.tech$/.test(h)) return 'Postgres (Neon)';
  if (/supabase\.(co|com)$/.test(h)) return 'Postgres (Supabase)';
  if (/prisma\.io$/.test(h)) return 'Postgres (Prisma Postgres)';
  if (/thenile\.dev$|nile/.test(h)) return 'Postgres (Nile)';
  if (/rds\.amazonaws\.com$/.test(h)) return 'Postgres (AWS)';
  if (/^(localhost|127\.0\.0\.1|db|postgres)$/.test(h)) return 'Postgres (self-hosted)';
  return 'Postgres';
}

const DETECTORS: Record<Exclude<StoreKind, 'memory'>, () => StoreConfig | null> = {
  postgres() {
    const hit = find(
      ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'NEON_DATABASE_URL', 'NILEDB_URL', 'SUPABASE_DB_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING'],
      /^postgres(ql)?:\/\//i,
    );
    return hit && { kind: 'postgres', label: postgresLabel(hit[1]), envVars: [hit[0]], url: hit[1] };
  },
  turso() {
    const suffixes = ['TURSO_DATABASE_URL', 'LIBSQL_URL', 'TURSO_URL', 'LIBSQL_DATABASE_URL'];
    const hit = find(suffixes, /^(libsql|https?|wss?):\/\//i);
    if (!hit) return null;
    const suffix = suffixes.find((s) => hit[0] === s || hit[0].endsWith(`_${s}`))!;
    const tok = findToken(hit[0], suffix, ['TURSO_AUTH_TOKEN', 'LIBSQL_AUTH_TOKEN', 'TURSO_TOKEN']);
    return { kind: 'turso', label: 'Turso (libSQL)', envVars: [hit[0], ...(tok ? [tok[0]] : [])], url: hit[1], token: tok?.[1] };
  },
  mongodb() {
    const hit = find(['MONGODB_URI', 'MONGODB_URL', 'MONGO_URL', 'MONGO_URI', 'DATABASE_URL'], /^mongodb(\+srv)?:\/\//i);
    return hit && { kind: 'mongodb', label: /mongodb\.net$/.test(hostOf(hit[1])) ? 'MongoDB Atlas' : 'MongoDB', envVars: [hit[0]], url: hit[1] };
  },
  upstash() {
    const suffixes = ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'REDIS_REST_API_URL', 'REDIS_REST_URL'];
    const hit = find(suffixes, /^https?:\/\//i);
    if (!hit) return null;
    const suffix = suffixes.find((s) => hit[0] === s || hit[0].endsWith(`_${s}`))!;
    const tok = findToken(hit[0], suffix, [suffix.replace(/URL$/, 'TOKEN')]);
    if (!tok) return null;
    return { kind: 'upstash', label: 'Upstash Redis (REST)', envVars: [hit[0], tok[0]], url: hit[1], token: tok[1] };
  },
  redis() {
    const hit = find(['REDIS_URL', 'KV_URL', 'REDIS_TLS_URL', 'REDISCLOUD_URL'], /^rediss?:\/\//i);
    if (!hit) return null;
    const h = hostOf(hit[1]);
    const label = /upstash\.io$/.test(h) ? 'Upstash Redis (TCP)' : /redis(labs|-cloud)|rlrcp\.com|redns\.redis-cloud\.com/.test(h) ? 'Redis Cloud' : 'Redis';
    return { kind: 'redis', label, envVars: [hit[0]], url: hit[1] };
  },
  blob() {
    const hit = find(['BLOB_READ_WRITE_TOKEN'], /^vercel_blob_rw_/);
    return hit && { kind: 'blob', label: 'Vercel Blob', envVars: [hit[0]], token: hit[1] };
  },
};

export const MEMORY_CONFIG: StoreConfig = { kind: 'memory', label: 'In-memory (no database)', envVars: [] };

/** All databases that are configured in the environment (for diagnostics). */
export function detectAll(): StoreConfig[] {
  return DETECTION_ORDER.map((k) => DETECTORS[k as Exclude<StoreKind, 'memory'>]()).filter((c): c is StoreConfig => c !== null);
}

export function detectStore(): StoreConfig {
  const forced = process.env.STORAGE?.trim().toLowerCase() as StoreKind | undefined;
  if (forced) {
    if (forced === 'memory') return MEMORY_CONFIG;
    const det = DETECTORS[forced as Exclude<StoreKind, 'memory'>];
    if (!det) throw new Error(`STORAGE="${forced}" is not supported. Use one of: ${[...DETECTION_ORDER, 'memory'].join(', ')}`);
    const cfg = det();
    if (!cfg) throw new Error(`STORAGE="${forced}" is set, but its connection env vars were not found`);
    return cfg;
  }
  return detectAll()[0] ?? MEMORY_CONFIG;
}
