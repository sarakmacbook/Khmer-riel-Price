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

/**
 * A database the user typed in (Telegram /admin or POST /api/database).
 * Stored as the runtime override next to the env-detected configuration.
 */
export interface DbSpec {
  kind: StoreKind;
  url: string;
  token?: string | null;
  /** Optional custom name shown instead of the auto-detected one */
  label?: string | null;
}

export interface DbKindMeta {
  kind: StoreKind;
  name: string;
  emoji: string;
  /** one line explaining what this backend is */
  hint: string;
  /** copy-paste example of what to send */
  example: string;
  /** second value the user must send (token / auth secret) */
  tokenLabel?: string;
  /** a pasted value matching this pattern identifies the backend */
  urlPattern?: RegExp;
  /** accepted URL schemes */
  schemes?: RegExp;
  /** env vars this backend normally comes from (diagnostics only, never values) */
  envHints: string[];
}

/** Everything the Telegram connect menu knows about each backend. Order = detection order. */
export const KIND_META: DbKindMeta[] = [
  {
    kind: 'postgres',
    name: 'PostgreSQL',
    emoji: '🐘',
    hint: 'Neon · Supabase · Vercel Postgres · any Postgres server',
    example: 'postgresql://user:password@host:5432/dbname',
    urlPattern: /^postgres(ql)?:\/\//i,
    schemes: /^postgres(ql)?:\/\//i,
    envHints: ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'SUPABASE_DB_URL'],
  },
  {
    kind: 'turso',
    name: 'Turso / libSQL',
    emoji: '🗂',
    hint: 'Turso free tier — tables are created automatically',
    example: 'libsql://my-db-org.turso.io',
    tokenLabel: 'Turso auth token',
    urlPattern: /^(libsql|wss?):\/\/|^(https?):\/\/.*\.turso\.io/i,
    schemes: /^(libsql|wss?|https?):\/\//i,
    envHints: ['TURSO_DATABASE_URL', 'LIBSQL_URL', 'TURSO_AUTH_TOKEN'],
  },
  {
    kind: 'mongodb',
    name: 'MongoDB',
    emoji: '🍃',
    hint: 'MongoDB Atlas M0 or any MongoDB 5+',
    example: 'mongodb+srv://user:password@cluster.mongodb.net/wingrate',
    urlPattern: /^mongodb(\+srv)?:\/\//i,
    schemes: /^mongodb(\+srv)?:\/\//i,
    envHints: ['MONGODB_URI', 'MONGO_URL'],
  },
  {
    kind: 'upstash',
    name: 'Upstash Redis (REST)',
    emoji: '⚡',
    hint: 'Upstash / Vercel KV REST endpoint + token',
    example: 'https://xxx.upstash.io',
    tokenLabel: 'Upstash REST token',
    urlPattern: /^https?:\/\/[^/]*\.upstash\.io(\/.*)?$/i,
    schemes: /^https?:\/\//i,
    envHints: ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  },
  {
    kind: 'redis',
    name: 'Redis (TCP)',
    emoji: '🧱',
    hint: 'Redis Cloud, Upstash TCP or self-hosted redis:// / rediss://',
    example: 'rediss://default:password@host:6379',
    urlPattern: /^rediss?:\/\//i,
    schemes: /^rediss?:\/\//i,
    envHints: ['REDIS_URL', 'KV_URL', 'REDIS_TLS_URL'],
  },
  {
    kind: 'blob',
    name: 'Vercel Blob',
    emoji: '📦',
    hint: 'One private JSON document — no tables, uses a read/write token',
    example: 'vercel_blob_rw_xxxxxxxx_yyyyyyyy',
    urlPattern: /^vercel_blob_rw_/i,
    envHints: ['BLOB_READ_WRITE_TOKEN'],
  },
];

export const kindMeta = (kind: StoreKind): DbKindMeta => KIND_META.find((m) => m.kind === kind) ?? KIND_META[0];

/** Infer the backend from a pasted connection string / token. */
export function detectKindFromUrl(value: string): StoreKind | null {
  const v = value.trim();
  return KIND_META.find((m) => m.urlPattern?.test(v))?.kind ?? null;
}

/** Validate one user-supplied value for a backend. Throws a friendly Error. */
export function validateSpec(spec: DbSpec): DbSpec {
  const meta = KIND_META.find((m) => m.kind === spec.kind);
  if (!meta) throw new Error(`Unknown database type "${spec.kind}".`);
  const url = (spec.url ?? '').trim();
  if (!url) throw new Error(`Missing connection string for ${meta.name}.`);
  if (meta.schemes && !meta.schemes.test(url)) {
    throw new Error(`${meta.name} expects a value like: ${meta.example}`);
  }
  if (meta.tokenLabel) {
    const token = (spec.token ?? '').trim();
    if (/^https?:\/\//i.test(token)) throw new Error(`That looks like a URL, not the ${meta.tokenLabel}.`);
    if (spec.kind !== 'turso' && !token) throw new Error(`${meta.name} also needs the ${meta.tokenLabel}.`);
  }
  return { ...spec, url, token: (spec.token ?? '').trim() || null };
}

export function labelForSpec(spec: DbSpec): string {
  if (spec.label?.trim()) return spec.label.trim();
  switch (spec.kind) {
    case 'postgres':
      return postgresLabel(spec.url);
    case 'turso':
      return 'Turso (libSQL)';
    case 'mongodb':
      return /mongodb\.net$/i.test(hostOf(spec.url)) ? 'MongoDB Atlas' : 'MongoDB';
    case 'upstash':
      return 'Upstash Redis (REST)';
    case 'redis':
      return 'Redis';
    case 'blob':
      return 'Vercel Blob';
    default:
      return kindMeta(spec.kind).name;
  }
}

/** Turn a user-supplied database into the StoreConfig the factory understands. */
export function configFromSpec(spec: DbSpec, envVars: string[] = []): StoreConfig {
  const s = validateSpec(spec);
  // Blob has no URL: the value the user pastes IS the read/write token.
  if (s.kind === 'blob') return { kind: s.kind, label: labelForSpec(s), token: s.url, envVars };
  return { kind: s.kind, label: labelForSpec(s), url: s.url, token: s.token ?? undefined, envVars };
}

// ---------------------------------------------------------------------------
// Redaction helpers — connection strings are never echoed with secrets intact.
// ---------------------------------------------------------------------------

/** "postgresql://user:•••@host:5432/db" */
export function maskUrl(url: string): string {
  const raw = (url ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.password) u.password = '•••';
    for (const key of [...u.searchParams.keys()]) {
      if (/token|password|secret|key/i.test(key)) u.searchParams.set(key, '•••');
    }
    return u.toString();
  } catch {
    return raw.replace(/:\/\/([^:@/]+):[^@/]+@/, '://$1:•••@');
  }
}

/**
 * Mask any stored connection value. URLs keep their shape but lose the
 * password; opaque values (a Vercel Blob read/write token *is* the connection
 * string) are shortened to `head…tail` so they can never be read back out of
 * a chat message or an API response.
 */
export function maskTarget(value: string | null | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? maskUrl(raw) : maskToken(raw);
}

export function maskToken(token: string | null | undefined): string {
  const t = (token ?? '').trim();
  if (!t) return '—';
  if (t.length <= 8) return '•••';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

export const redactError = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  // Some drivers echo the full URL (with password) in error messages.
  return msg.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s@/]+):[^\s@/]+@/gi, '$1:•••@');
};


export const DETECTION_ORDER: StoreKind[] = ['postgres', 'turso', 'mongodb', 'upstash', 'redis', 'blob'];

type Entry = [key: string, value: string];

/**
 * Env vars whose name marks them as the *linked backup* database rather than
 * the primary one — `BACKUP_DATABASE_URL`, `SECONDARY_TURSO_DATABASE_URL`,
 * `REPLICA_MONGODB_URI`, … Without this split, a backup URL ending in
 * `_DATABASE_URL` would simply look like the primary database.
 */
const BACKUP_KEY_RE = /(^|_)(BACKUP|SECONDARY|STANDBY|REPLICA|FALLBACK)(_|$)/i;
export const isBackupEnvKey = (key: string) => BACKUP_KEY_RE.test(key);

type KeyFilter = (key: string) => boolean;
/** Primary scope: never the backup vars. Backup scope: only the backup vars. */
export const primaryKeys: KeyFilter = (k) => !isBackupEnvKey(k);
export const backupKeys: KeyFilter = isBackupEnvKey;

function envEntries(): Entry[] {
  return Object.entries(process.env).filter((e): e is Entry => typeof e[1] === 'string' && e[1].trim() !== '');
}

/** Find env vars whose name equals/ends with one of `suffixes` and whose value matches `test`. Exact names first. */
function find(suffixes: string[], test: RegExp, allow: KeyFilter): Entry | null {
  const rank = (k: string) => {
    const i = suffixes.findIndex((s) => k === s || k.endsWith(`_${s}`));
    return i * 2 + (suffixes.includes(k) ? 0 : 1) + (/UNPOOLED|NON_POOLING|DIRECT/.test(k) ? 100 : 0);
  };
  const hits = envEntries().filter(
    ([k, v]) => allow(k) && test.test(v.trim()) && suffixes.some((s) => k === s || k.endsWith(`_${s}`)),
  );
  hits.sort((a, b) => rank(a[0]) - rank(b[0]));
  return hits[0] ? [hits[0][0], hits[0][1].trim()] : null;
}

/** Token that pairs with `urlKey` (same prefix preferred). */
function findToken(urlKey: string, urlSuffix: string, tokenSuffixes: string[], allow: KeyFilter): Entry | null {
  const prefix = urlKey.slice(0, urlKey.length - urlSuffix.length);
  for (const s of tokenSuffixes) {
    const v = process.env[prefix + s]?.trim();
    if (v) return [prefix + s, v];
  }
  return find(tokenSuffixes, /.+/, allow);
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

/**
 * Detectors parameterised by env-var scope, so the same logic finds either the
 * primary database (plain names) or the linked backup database (`BACKUP_*`,
 * `SECONDARY_*`, `REPLICA_*`, `STANDBY_*`, `FALLBACK_*` prefixed names).
 */
function makeDetectors(allow: KeyFilter): Record<Exclude<StoreKind, 'memory'>, () => StoreConfig | null> {
  return {
    postgres() {
      const hit = find(
        ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'NEON_DATABASE_URL', 'NILEDB_URL', 'SUPABASE_DB_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING'],
        /^postgres(ql)?:\/\//i,
        allow,
      );
      return hit && { kind: 'postgres', label: postgresLabel(hit[1]), envVars: [hit[0]], url: hit[1] };
    },
    turso() {
      const suffixes = ['TURSO_DATABASE_URL', 'LIBSQL_URL', 'TURSO_URL', 'LIBSQL_DATABASE_URL'];
      const hit = find(suffixes, /^(libsql|https?|wss?):\/\//i, allow);
      if (!hit) return null;
      const suffix = suffixes.find((s) => hit[0] === s || hit[0].endsWith(`_${s}`))!;
      const tok = findToken(hit[0], suffix, ['TURSO_AUTH_TOKEN', 'LIBSQL_AUTH_TOKEN', 'TURSO_TOKEN'], allow);
      return { kind: 'turso', label: 'Turso (libSQL)', envVars: [hit[0], ...(tok ? [tok[0]] : [])], url: hit[1], token: tok?.[1] };
    },
    mongodb() {
      const hit = find(['MONGODB_URI', 'MONGODB_URL', 'MONGO_URL', 'MONGO_URI', 'DATABASE_URL'], /^mongodb(\+srv)?:\/\//i, allow);
      return hit && { kind: 'mongodb', label: /mongodb\.net$/.test(hostOf(hit[1])) ? 'MongoDB Atlas' : 'MongoDB', envVars: [hit[0]], url: hit[1] };
    },
    upstash() {
      const suffixes = ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'REDIS_REST_API_URL', 'REDIS_REST_URL'];
      const hit = find(suffixes, /^https?:\/\//i, allow);
      if (!hit) return null;
      const suffix = suffixes.find((s) => hit[0] === s || hit[0].endsWith(`_${s}`))!;
      const tok = findToken(hit[0], suffix, [suffix.replace(/URL$/, 'TOKEN')], allow);
      if (!tok) return null;
      return { kind: 'upstash', label: 'Upstash Redis (REST)', envVars: [hit[0], tok[0]], url: hit[1], token: tok[1] };
    },
    redis() {
      const hit = find(['REDIS_URL', 'KV_URL', 'REDIS_TLS_URL', 'REDISCLOUD_URL'], /^rediss?:\/\//i, allow);
      if (!hit) return null;
      const h = hostOf(hit[1]);
      const label = /upstash\.io$/.test(h) ? 'Upstash Redis (TCP)' : /redis(labs|-cloud)|rlrcp\.com|redns\.redis-cloud\.com/.test(h) ? 'Redis Cloud' : 'Redis';
      return { kind: 'redis', label, envVars: [hit[0]], url: hit[1] };
    },
    blob() {
      const hit = find(['BLOB_READ_WRITE_TOKEN'], /^vercel_blob_rw_/, allow);
      return hit && { kind: 'blob', label: 'Vercel Blob', envVars: [hit[0]], token: hit[1] };
    },
  };
}

const DETECTORS = makeDetectors(primaryKeys);
const BACKUP_DETECTORS = makeDetectors(backupKeys);

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

/**
 * The backup database described by the environment: `BACKUP_DATABASE_URL`,
 * `SECONDARY_TURSO_DATABASE_URL`, `FALLBACK_MONGODB_URI`, … (or any other
 * `BACKUP|SECONDARY|STANDBY|REPLICA|FALLBACK` prefixed var).
 *
 * Never mixed up with the primary detection above — a deployment can point the
 * app at one database and hand it a second one as its hot standby. `null` when
 * the environment describes no second database. Honours `BACKUP_STORAGE=<kind>`.
 */
export function detectBackupStore(): StoreConfig | null {
  const forced = (process.env.BACKUP_STORAGE ?? process.env.SECONDARY_STORAGE)?.trim().toLowerCase() as StoreKind | undefined;
  if (forced) {
    if (forced === 'memory') return null;
    const det = BACKUP_DETECTORS[forced as Exclude<StoreKind, 'memory'>];
    if (!det) throw new Error(`BACKUP_STORAGE="${forced}" is not supported. Use one of: ${DETECTION_ORDER.join(', ')}`);
    const cfg = det();
    if (!cfg) throw new Error(`BACKUP_STORAGE="${forced}" is set, but its (BACKUP_/SECONDARY_ prefixed) env vars were not found`);
    return cfg;
  }
  for (const kind of DETECTION_ORDER) {
    const cfg = BACKUP_DETECTORS[kind as Exclude<StoreKind, 'memory'>]();
    if (cfg) return cfg;
  }
  return null;
}
