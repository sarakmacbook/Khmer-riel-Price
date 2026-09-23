import {
  type AlertInput,
  type AlertRecord,
  type Point,
  type RateRow,
  type RateStore,
  type RecordResult,
  dailyFromPoints,
  needsNewRow,
  sameQuote,
  toAlertRecord,
} from './types';

/**
 * Per-instance fallback used when no database is configured (or it is unreachable).
 * The live rate works; history/alerts are not persistent.
 */
export class MemoryStore implements RateStore {
  readonly kind = 'memory' as const;
  readonly label = 'In-memory (no database)';
  readonly persistent = false;
  readonly readTtlMs = Number.POSITIVE_INFINITY;

  private rows: RateRow[] = [];
  private alerts: AlertRecord[] = [];
  private claimedAt = 0;

  async init() {}

  async latest() {
    const r = this.rows[this.rows.length - 1];
    return r ? { ...r } : null;
  }

  async record(q: { bid: number; ask: number }, now: number): Promise<RecordResult> {
    const prev = (await this.latest()) ?? null;
    if (needsNewRow(prev, q, now)) {
      const row = { bid: q.bid, ask: q.ask, t: now, c: now };
      this.rows.push(row);
      if (this.rows.length > 5000) this.rows.shift();
      return { row: { ...row }, prev, changed: !prev || !sameQuote(prev, q) };
    }
    const last = this.rows[this.rows.length - 1];
    last.c = now;
    return { row: { ...last }, prev, changed: false };
  }

  async claimRefresh(now: number, refreshMs: number) {
    if (now - this.claimedAt < refreshMs) return false;
    this.claimedAt = now;
    return true;
  }

  async range(since: number): Promise<Point[]> {
    return this.rows.filter((r) => r.t >= since).map(({ bid, ask, t }) => ({ bid, ask, t }));
  }

  async before(ts: number) {
    const r = [...this.rows].reverse().find((x) => x.t < ts);
    return r ? { bid: r.bid, ask: r.ask, t: r.t } : null;
  }

  async daily(since: number | null) {
    return dailyFromPoints(await this.range(since ?? 0));
  }

  async listAlerts() {
    return this.alerts.map((a) => ({ ...a }));
  }

  async saveAlert(a: AlertInput) {
    const i = a.id ? this.alerts.findIndex((x) => x.id === a.id) : -1;
    const rec = toAlertRecord(a, a.id ?? String(this.alerts.length + 1), i >= 0 ? this.alerts[i].createdAt : Date.now());
    if (i >= 0) this.alerts[i] = rec;
    else this.alerts.push(rec);
    return { ...rec };
  }

  async stats() {
    return { rows: this.rows.length, note: 'not persistent — resets when the server instance restarts' };
  }
}
