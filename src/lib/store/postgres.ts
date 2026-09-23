import { and, asc, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { connectPostgres, type Db } from '@/db';
import { exchangeRates, telegramAlerts } from '@/db/schema';
import {
  type AlertInput,
  type AlertRecord,
  type Point,
  type RateRow,
  type RateStore,
  type RecordResult,
  TZ_OFFSET_HOURS,
  needsNewRow,
  sameQuote,
  toAlertRecord,
} from './types';

// Idempotent schema — created on first use, so no migration step is needed. Keep in sync with src/db/schema.ts.
const SCHEMA_SQL = `
SELECT pg_advisory_xact_lock(40544062);
CREATE TABLE IF NOT EXISTS exchange_rates (
  id          serial PRIMARY KEY,
  rate        numeric(12, 4) NOT NULL,
  bid         numeric(12, 4),
  ask         numeric(12, 4),
  "timestamp" timestamp NOT NULL DEFAULT now(),
  checked_at  timestamp
);
ALTER TABLE exchange_rates ADD COLUMN IF NOT EXISTS bid numeric(12, 4);
ALTER TABLE exchange_rates ADD COLUMN IF NOT EXISTS ask numeric(12, 4);
ALTER TABLE exchange_rates ADD COLUMN IF NOT EXISTS checked_at timestamp;
CREATE INDEX IF NOT EXISTS exchange_rates_timestamp_idx ON exchange_rates ("timestamp");
CREATE TABLE IF NOT EXISTS telegram_alerts (
  id            serial PRIMARY KEY,
  source        text NOT NULL DEFAULT 'web',
  webhook_url   text,
  chat_id       text,
  bot_token     text,
  condition     text NOT NULL DEFAULT 'change',
  target_rate   numeric(12, 4),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamp NOT NULL DEFAULT now(),
  last_alert_at timestamp
);
ALTER TABLE telegram_alerts ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'web';
`;

type Row = typeof exchangeRates.$inferSelect;
type AlertRow = typeof telegramAlerts.$inferSelect;

const toRow = (r: Row): RateRow => {
  const bid = parseFloat(r.bid ?? r.rate);
  return { bid, ask: r.ask ? parseFloat(r.ask) : bid, t: r.timestamp.getTime(), c: (r.checkedAt ?? r.timestamp).getTime() };
};
const toPoint = (r: { rate: string; bid: string | null; ask: string | null; timestamp: Date | string }): Point => {
  const bid = parseFloat(r.bid ?? r.rate);
  return { bid, ask: r.ask ? parseFloat(r.ask) : bid, t: new Date(r.timestamp).getTime() };
};
const toAlert = (a: AlertRow): AlertRecord => ({
  id: String(a.id),
  source: a.source === 'bot' ? 'bot' : 'web',
  webhookUrl: a.webhookUrl,
  chatId: a.chatId,
  botToken: a.botToken,
  condition: (a.condition as AlertRecord['condition']) ?? 'change',
  targetRate: a.targetRate ? parseFloat(a.targetRate) : null,
  active: a.active,
  createdAt: a.createdAt.getTime(),
  lastAlertAt: a.lastAlertAt ? a.lastAlertAt.getTime() : null,
});

export class PostgresStore implements RateStore {
  readonly kind = 'postgres' as const;
  readonly persistent = true;
  readonly readTtlMs = 5_000;
  private db: Db;
  private pool: ReturnType<typeof connectPostgres>['pool'];

  constructor(url: string, readonly label: string) {
    const c = connectPostgres(url);
    this.db = c.db;
    this.pool = c.pool;
  }

  async init() {
    await this.pool.query(SCHEMA_SQL); // multi-statement = one implicit transaction; lock auto-released
  }

  private latestRow(db: Pick<Db, 'query'> = this.db) {
    return db.query.exchangeRates.findFirst({ orderBy: [desc(exchangeRates.timestamp), desc(exchangeRates.id)] });
  }

  async latest() {
    const r = await this.latestRow();
    return r ? toRow(r) : null;
  }

  async record(q: { bid: number; ask: number }, now: number): Promise<RecordResult> {
    const at = new Date(now);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(40544063)`); // serialize concurrent refreshes
      const prevRow = await this.latestRow(tx);
      const prev = prevRow ? toRow(prevRow) : null;
      if (needsNewRow(prev, q, now)) {
        const [row] = await tx
          .insert(exchangeRates)
          .values({ rate: String(q.bid), bid: String(q.bid), ask: String(q.ask), timestamp: at, checkedAt: at })
          .returning();
        return { row: toRow(row), prev, changed: !prev || !sameQuote(prev, q) };
      }
      const [row] = await tx.update(exchangeRates).set({ checkedAt: at }).where(eq(exchangeRates.id, prevRow!.id)).returning();
      return { row: toRow(row), prev, changed: false };
    });
  }

  async claimRefresh(now: number, refreshMs: number) {
    const latest = await this.latestRow();
    if (!latest) return true;
    const claimed = await this.db
      .update(exchangeRates)
      .set({ checkedAt: new Date(now) })
      .where(and(eq(exchangeRates.id, latest.id), or(isNull(exchangeRates.checkedAt), lt(exchangeRates.checkedAt, new Date(now - refreshMs)))))
      .returning({ id: exchangeRates.id });
    return claimed.length > 0;
  }

  async range(since: number) {
    const rows = await this.db
      .select()
      .from(exchangeRates)
      .where(gte(exchangeRates.timestamp, new Date(since)))
      .orderBy(asc(exchangeRates.timestamp))
      .limit(5000);
    return rows.map(toPoint);
  }

  async before(ts: number) {
    const [r] = await this.db
      .select()
      .from(exchangeRates)
      .where(lt(exchangeRates.timestamp, new Date(ts)))
      .orderBy(desc(exchangeRates.timestamp))
      .limit(1);
    return r ? toPoint(r) : null;
  }

  async daily(since: number | null) {
    const where = since !== null ? sql`WHERE "timestamp" >= ${new Date(since).toISOString()}` : sql``;
    const offset = sql.raw(`interval '${TZ_OFFSET_HOURS} hours'`);
    const res = await this.db.execute<{ rate: string; bid: string | null; ask: string | null; timestamp: string }>(sql`
      SELECT rate, bid, ask, "timestamp" FROM (
        SELECT DISTINCT ON (date_trunc('day', "timestamp" + ${offset})) rate, bid, ask, "timestamp"
        FROM exchange_rates ${where}
        ORDER BY date_trunc('day', "timestamp" + ${offset}), "timestamp" DESC
      ) d ORDER BY "timestamp" ASC`);
    return res.rows.map(toPoint);
  }

  async listAlerts() {
    const rows = await this.db.select().from(telegramAlerts).orderBy(asc(telegramAlerts.id));
    return rows.map(toAlert);
  }

  async saveAlert(a: AlertInput) {
    const v = toAlertRecord(a, a.id ?? '');
    const values = {
      source: v.source,
      webhookUrl: v.webhookUrl,
      chatId: v.chatId,
      botToken: v.botToken,
      condition: v.condition,
      targetRate: v.targetRate !== null ? String(v.targetRate) : null,
      active: v.active,
      lastAlertAt: v.lastAlertAt ? new Date(v.lastAlertAt) : null,
    };
    const [row] = a.id
      ? await this.db.update(telegramAlerts).set(values).where(eq(telegramAlerts.id, Number(a.id))).returning()
      : await this.db.insert(telegramAlerts).values(values).returning();
    return toAlert(row);
  }

  async stats() {
    const r = await this.pool.query('SELECT count(*)::int AS rows, min("timestamp") AS first, max("timestamp") AS last FROM exchange_rates');
    return r.rows[0];
  }
}
