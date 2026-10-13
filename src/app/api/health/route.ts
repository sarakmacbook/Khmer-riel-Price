import { pingStore, storeBackend, storeDiagnostics } from '@/lib/history-store';
import { storeStatus, getStoreOrMemory } from '@/lib/store';
import { linkJson } from '@/lib/db-http';
import { redactError } from '@/lib/store/env';
import { effectiveBotToken, getWebAlert, hasDeliveryTarget } from '@/lib/alerts';
import { isUsableSecret, normalizeChatId } from '@/lib/telegram';

export const dynamic = 'force-dynamic';

/**
 * Can the automatic Telegram alerts actually deliver right now?
 *
 * "The bot never alerts" has a handful of causes that are invisible from the
 * outside (no persistent database, no alert saved, no bot token), so they are
 * reported here as plain reasons instead of being left to guesswork.
 */
async function alertReadiness() {
  try {
    const store = await getStoreOrMemory();
    const alerts = await store.listAlerts();
    const deliverable = alerts.filter((a) => a.active && hasDeliveryTarget(a));
    const web = await getWebAlert(store);
    const hasToken = effectiveBotToken(web ?? { botToken: null }) !== null;

    const problems: string[] = [];
    if (!store.persistent) {
      problems.push(
        `${store.label} does not persist between serverless invocations, so a price move cannot be compared with the previous one`,
      );
    }
    if (deliverable.length === 0) problems.push('no active alert with a Chat ID or Webhook URL is saved');
    // Bot-mode alerts (a chat id, no webhook relay) need a token of their own or TELEGRAM_BOT_TOKEN.
    else if (!hasToken && deliverable.some((a) => normalizeChatId(a.chatId) && !isUsableSecret(a.botToken))) {
      problems.push('a Chat ID alert has no bot token (set TELEGRAM_BOT_TOKEN or save one in the dashboard)');
    }

    return {
      ready: problems.length === 0,
      deliverable: deliverable.length,
      hasToken,
      persistent: store.persistent,
      problems,
    };
  } catch (e) {
    return { ready: false, deliverable: 0, hasToken: false, persistent: false, problems: [redactError(e)] };
  }
}

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

  const alerts = await alertReadiness();

  return Response.json({
    ok: true,
    store,
    database: store !== 'memory',
    /** Whether automatic Telegram alerts can currently deliver, and why not. */
    alerts,
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
