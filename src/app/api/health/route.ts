import { pingStore, storeBackend, storeDiagnostics } from '@/lib/history-store';
import { storeStatus } from '@/lib/store';
import { linkJson } from '@/lib/db-http';
import { redactError } from '@/lib/store/env';

export const dynamic = 'force-dynamic';

/**
 * Health + database diagnostics. Works with ANY configured store
 * (Postgres / Turso / MongoDB / Upstash / Redis / Vercel Blob) — including one
 * connected at runtime from the Telegram 🗄 menu — and with none at all: the
 * live rate is scraped directly, so a missing database never reports the app
 * as down. Secrets are never printed, only host names (masked) and env var NAMES.
 */
export async function GET() {
  const store = storeBackend();
  const diagnostics = storeDiagnostics();
  const status = await storeStatus();
  let storeOk = false;
  let error: string | null = status.error ? redactError(status.error) : null;

  try {
    storeOk = await pingStore();
  } catch (err: unknown) {
    error = redactError(err);
  }

  return Response.json({
    ok: true,
    store,
    database: store !== 'memory',
    storeOk,
    error,
    ...diagnostics,
    // How the database was chosen (environment / Telegram / config file) and
    // where the choice is saved — handy when a deploy reconnects to the wrong one.
    source: status.source,
    mode: status.choice.mode,
    label: status.activeLabel,
    activeKind: status.activeKind,
    reachable: status.reachable,
    ms: status.ms,
    stats: status.stats,
    /** Backup database + failover state (null when only one database is used) */
    link: linkJson(status.link),
    configPath: status.configPath,
    configWarning: status.configWarning,
    timestamp: new Date().toISOString(),
  });
}
