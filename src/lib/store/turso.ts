import {
  type AlertInput,
  type AlertRecord,
  type Point,
  type RateRow,
  type RateStore,
  type RecordResult,
  TZ_OFFSET_MS,
  dayStart,
  sameQuote,
  toAlertRecord,
} from './types';

// Turso / libSQL over the Hrana-over-HTTP protocol (POST /v2/pipeline) — plain fetch, no SDK.

type Value = null | number | string;
type HranaValue =
  | { type: 'null' }
  | { type: 'integer'; value: string }
  | { type: 'float'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; base64: string };
type Stmt = { sql: string; args?: Value[] };
type Result = { cols: { name: string }[]; rows: HranaValue[][]; affected_row_count: number; last_insert_rowid: string | null };

const encode = (v: Value): HranaValue =>
  v === null || v === undefined
    ? { type: 'null' }
    : typeof v === 'number'
      ? Number.isInteger(v)
        ? { type: 'integer', value: String(v) }
        : { type: 'float', value: v }
      : { type: 'text', value: String(v) };

const decode = (v: HranaValue): Value =>
  v.type === 'null' ? null : v.type === 'integer' ? Number(v.value) : v.type === 'float' ? v.value : v.type === 'text' ? v.value : v.base64;

const objects = (r: Result) =>
  r.rows.map((row) => Object.fromEntries(r.cols.map((c, i) => [c.name, decode(row[i])])) as Record<string, Value>);

const SCHEMA: Stmt[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS exchange_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bid REAL NOT NULL, ask REAL NOT NULL,
      ts INTEGER NOT NULL, checked_at INTEGER NOT NULL)`,
  },
  { sql: 'CREATE INDEX IF NOT EXISTS exchange_rates_ts_idx ON exchange_rates (ts)' },
  {
    sql: `CREATE TABLE IF NOT EXISTS telegram_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL DEFAULT 'web', webhook_url TEXT, chat_id TEXT,
      bot_token TEXT, condition TEXT NOT NULL DEFAULT 'change', target_rate REAL, custom_message TEXT,
      active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_alert_at INTEGER)`,
  },
];

const LATEST = 'SELECT id, bid, ask, ts, checked_at FROM exchange_rates ORDER BY ts DESC, id DESC LIMIT 1';

const toRow = (r: Record<string, Value>): RateRow => ({ bid: Number(r.bid), ask: Number(r.ask), t: Number(r.ts), c: Number(r.checked_at) });
const toPoint = (r: Record<string, Value>): Point => ({ bid: Number(r.bid), ask: Number(r.ask), t: Number(r.ts) });
const toAlert = (r: Record<string, Value>): AlertRecord => ({
  id: String(r.id),
  source: r.source === 'bot' ? 'bot' : 'web',
  webhookUrl: (r.webhook_url as string) ?? null,
  chatId: (r.chat_id as string) ?? null,
  botToken: (r.bot_token as string) ?? null,
  condition: ((r.condition as string) ?? 'change') as AlertRecord['condition'],
  targetRate: r.target_rate === null || r.target_rate === undefined ? null : Number(r.target_rate),
  customMessage: (r.custom_message as string) ?? null,
  active: Number(r.active) === 1,
  createdAt: Number(r.created_at),
  lastAlertAt: r.last_alert_at === null || r.last_alert_at === undefined ? null : Number(r.last_alert_at),
});

export class TursoStore implements RateStore {
  readonly kind = 'turso' as const;
  readonly label = 'Turso (libSQL)';
  readonly persistent = true;
  readonly readTtlMs = 10_000;
  private endpoint: string;

  constructor(
    url: string,
    private token?: string,
  ) {
    // libsql://db-org.turso.io → https://db-org.turso.io ; ws(s):// → http(s)://
    const base = url.replace(/^libsql:\/\//i, 'https://').replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
    const u = new URL(base);
    if (!this.token && u.searchParams.get('authToken')) this.token = u.searchParams.get('authToken')!;
    this.endpoint = `${u.origin}${u.pathname.replace(/\/+$/, '')}/v2/pipeline`;
  }

  /** Run statements sequentially on one stream (atomic when wrapped in BEGIN/COMMIT). */
  private async pipeline(stmts: Stmt[]): Promise<Result[]> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({
        baton: null,
        requests: [
          ...stmts.map((s) => ({ type: 'execute', stmt: { sql: s.sql, args: (s.args ?? []).map(encode) } })),
          { type: 'close' },
        ],
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = (await res.json()) as {
      results: ({ type: 'ok'; response: { type: string; result?: Result } } | { type: 'error'; error: { message: string } })[];
    };
    return data.results.slice(0, stmts.length).map((r, i) => {
      if (r.type === 'error') throw new Error(`Turso: ${r.error.message} (in: ${stmts[i].sql.slice(0, 60)}…)`);
      return r.response.result!;
    });
  }

  private async one(sql: string, args: Value[] = []) {
    return objects((await this.pipeline([{ sql, args }]))[0]);
  }

  async init() {
    await this.pipeline(SCHEMA);
    // SQLite has no `ADD COLUMN IF NOT EXISTS` — migrate databases created
    // before the custom_message column existed.
    try {
      const cols = await this.one(`SELECT name FROM pragma_table_info('telegram_alerts')`);
      if (!cols.some((c) => c.name === 'custom_message')) {
        await this.pipeline([{ sql: `ALTER TABLE telegram_alerts ADD COLUMN custom_message TEXT` }]);
      }
    } catch (e) {
      console.warn('[turso] custom_message migration skipped:', e instanceof Error ? e.message : e);
    }
  }

  async latest() {
    const [r] = await this.one(LATEST);
    return r ? toRow(r) : null;
  }

  async record(q: { bid: number; ask: number }, now: number): Promise<RecordResult> {
    // One atomic round trip: insert only if price changed or no row yet today, else just bump checked_at.
    const res = await this.pipeline([
      { sql: 'BEGIN IMMEDIATE' },
      { sql: LATEST },
      {
        sql: `INSERT INTO exchange_rates (bid, ask, ts, checked_at)
              SELECT ?1, ?2, ?3, ?3 WHERE NOT EXISTS (
                SELECT 1 FROM (${LATEST}) l WHERE l.bid = ?1 AND l.ask = ?2 AND l.ts >= ?4)`,
        args: [q.bid, q.ask, now, dayStart(now)],
      },
      { sql: `UPDATE exchange_rates SET checked_at = ?1 WHERE id = (SELECT id FROM (${LATEST}))`, args: [now] },
      { sql: LATEST },
      { sql: 'COMMIT' },
    ]);
    const [prevObj] = objects(res[1]);
    const prev = prevObj ? toRow(prevObj) : null;
    const inserted = res[2].affected_row_count > 0;
    const row = toRow(objects(res[4])[0]);
    return { row, prev, changed: inserted && (!prev || !sameQuote(prev, q)) };
  }

  async claimRefresh(now: number, refreshMs: number) {
    const res = await this.pipeline([
      {
        sql: `UPDATE exchange_rates SET checked_at = ?1 WHERE id = (SELECT id FROM (${LATEST})) AND checked_at < ?2`,
        args: [now, now - refreshMs],
      },
    ]);
    return res[0].affected_row_count > 0;
  }

  async range(since: number) {
    return (await this.one('SELECT bid, ask, ts FROM exchange_rates WHERE ts >= ? ORDER BY ts ASC LIMIT 5000', [since])).map(toPoint);
  }

  async before(ts: number) {
    const [r] = await this.one('SELECT bid, ask, ts FROM exchange_rates WHERE ts < ? ORDER BY ts DESC LIMIT 1', [ts]);
    return r ? toPoint(r) : null;
  }

  async daily(since: number | null) {
    const rows = await this.one(
      `SELECT bid, ask, ts FROM (
         SELECT bid, ask, ts, ROW_NUMBER() OVER (PARTITION BY CAST((ts + ?1) / 86400000 AS INTEGER) ORDER BY ts DESC, id DESC) AS rn
         FROM exchange_rates WHERE ts >= ?2
       ) WHERE rn = 1 ORDER BY ts ASC`,
      [TZ_OFFSET_MS, since ?? 0],
    );
    return rows.map(toPoint);
  }

  async listAlerts() {
    return (await this.one('SELECT * FROM telegram_alerts ORDER BY id ASC')).map(toAlert);
  }

  async saveAlert(a: AlertInput) {
    const v = toAlertRecord(a, a.id ?? '');
    const cols = [v.source, v.webhookUrl, v.chatId, v.botToken, v.condition, v.targetRate, v.customMessage, v.active ? 1 : 0, v.lastAlertAt];
    const [row] = a.id
      ? await this.one(
          `UPDATE telegram_alerts SET source=?, webhook_url=?, chat_id=?, bot_token=?, condition=?, target_rate=?, custom_message=?, active=?, last_alert_at=?
           WHERE id=? RETURNING *`,
          [...cols, Number(a.id)],
        )
      : await this.one(
          `INSERT INTO telegram_alerts (source, webhook_url, chat_id, bot_token, condition, target_rate, custom_message, active, last_alert_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          [...cols, v.createdAt],
        );
    return toAlert(row);
  }

  async stats() {
    const [r] = await this.one('SELECT count(*) AS rows, min(ts) AS first, max(ts) AS last FROM exchange_rates');
    return { rows: r.rows, first: r.first ? new Date(Number(r.first)).toISOString() : null, last: r.last ? new Date(Number(r.last)).toISOString() : null };
  }
}
