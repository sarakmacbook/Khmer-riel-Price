/**
 * Runtime auto-migration for Postgres.
 *
 * On Vercel there is no `drizzle-kit push` step, so connecting a database
 * left users with no tables and an empty chart. This creates every table
 * the app needs with plain idempotent `CREATE TABLE IF NOT EXISTS` DDL on
 * the first serverless invocation (cached per warm instance).
 */
import { getPool } from "@/db";

let schemaPromise: Promise<void> | null = null;

const DDL = `
CREATE TABLE IF NOT EXISTS exchange_rates (
  id        SERIAL PRIMARY KEY,
  rate      NUMERIC(12,4) NOT NULL,
  bid       NUMERIC(12,4),
  ask       NUMERIC(12,4),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exchange_rates_timestamp_idx
  ON exchange_rates (timestamp);

CREATE TABLE IF NOT EXISTS telegram_alerts (
  id           SERIAL PRIMARY KEY,
  webhook_url  TEXT,
  chat_id      TEXT,
  bot_token    TEXT,
  condition    TEXT NOT NULL DEFAULT 'change',
  target_rate  NUMERIC(12,4),
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_alert_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS telegram_alerts_active_idx
  ON telegram_alerts (active);
`;

export function ensurePostgresSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const pool = getPool();
      if (!pool) return; // no Postgres configured — nothing to create
      await pool.query(DDL);
    })().catch((err) => {
      // Allow retry on the next invocation if the database wasn't reachable.
      console.error("auto-migration failed (will retry):", err);
      schemaPromise = null;
    });
  }
  return schemaPromise;
}
