import { detectStore, type StoreConfig } from './env';
import { MemoryStore } from './memory';
import { errMsg, type RateStore } from './types';

export type { RateStore, RateRow, Point, AlertRecord, AlertInput, StoreKind } from './types';

const g = globalThis as typeof globalThis & {
  __wingrateStore?: Promise<RateStore> | null;
  __wingrateMemory?: MemoryStore;
  __wingrateStoreError?: string | null;
};

async function create(cfg: StoreConfig): Promise<RateStore> {
  switch (cfg.kind) {
    case 'postgres': {
      const { PostgresStore } = await import('./postgres');
      return new PostgresStore(cfg.url!, cfg.label);
    }
    case 'turso': {
      const { TursoStore } = await import('./turso');
      return new TursoStore(cfg.url!, cfg.token);
    }
    case 'mongodb': {
      const { MongoStore } = await import('./mongodb');
      return new MongoStore(cfg.url!, cfg.label);
    }
    case 'upstash': {
      const [{ RedisStore }, { UpstashRest }] = await Promise.all([import('./redis'), import('./redis-client')]);
      return new RedisStore(new UpstashRest(cfg.url!, cfg.token!), 'upstash', cfg.label);
    }
    case 'redis': {
      const [{ RedisStore }, { respClient }] = await Promise.all([import('./redis'), import('./redis-client')]);
      return new RedisStore(respClient(cfg.url!), 'redis', cfg.label);
    }
    case 'blob': {
      const { BlobStore } = await import('./blob');
      return new BlobStore(cfg.token!);
    }
    default:
      return memoryStore();
  }
}

/** Per-instance in-memory store (also used as fallback when the database is unreachable). */
export function memoryStore(): MemoryStore {
  return (g.__wingrateMemory ??= new MemoryStore());
}

/** The configured store, initialized once per instance (schema/indexes created on first use). Throws if unreachable. */
export function getStore(): Promise<RateStore> {
  if (!g.__wingrateStore) {
    g.__wingrateStore = (async () => {
      const store = await create(detectStore());
      await store.init();
      g.__wingrateStoreError = null;
      return store;
    })();
    g.__wingrateStore.catch((e) => {
      g.__wingrateStoreError = errMsg(e);
      g.__wingrateStore = null; // retry on next request
    });
  }
  return g.__wingrateStore;
}

/** Like getStore(), but falls back to the in-memory store instead of throwing. */
export async function getStoreOrMemory(): Promise<RateStore> {
  try {
    return await getStore();
  } catch (e) {
    console.error('[store] unavailable, using memory:', errMsg(e));
    return memoryStore();
  }
}

export const lastStoreError = () => g.__wingrateStoreError ?? null;
