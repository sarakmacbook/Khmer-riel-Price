import { createHash } from 'node:crypto';
import {
  type AlertInput,
  type AlertRecord,
  type Point,
  type RateRow,
  type RateStore,
  type RecordResult,
  dayKey,
  sameQuote,
  toAlertRecord,
} from './types';

// Vercel Blob (first-party, Hobby free tier) — the whole dataset is ONE small private JSON
// document. Writes happen only when the price changes, on the first check of a new day, or
// when alert settings change (a few per day), keeping far inside the free operation limits.
// Concurrent writers are safe: conditional PUT with If-Match (ETag), retried on conflict.
// REST protocol per @vercel/blob v2 source (API version 12). No SDK dependency.

type Doc = {
  v: 1;
  latest: RateRow | null;
  rows: Point[];
  daily: Record<string, Point>;
  alerts: AlertRecord[];
  seq: number;
};

const EMPTY: Doc = { v: 1, latest: null, rows: [], daily: {}, alerts: [], seq: 0 };
const MAX_ROWS = 20_000;
const API_VERSION = '12';

export class BlobStore implements RateStore {
  readonly kind = 'blob' as const;
  readonly label = 'Vercel Blob';
  readonly persistent = true;
  /** Re-read the document at most every 10 min per instance (reads count as operations). */
  readonly readTtlMs = 600_000;

  private pathname: string;
  private readUrl: string;
  private apiUrl: string;
  private doc: Doc | null = null;
  private etag: string | null = null;
  private loadedAt = 0;
  private claimedAt = 0;

  constructor(private token: string) {
    // Token format: vercel_blob_rw_<storeId>_<secret>
    const storeId = token.split('_')[3] ?? '';
    // Unguessable pathname derived from the secret token (the blob is also private).
    const id = createHash('sha256').update(token).digest('hex').slice(0, 24);
    this.pathname = `wingrate/data-${id}.json`;
    const readBase = process.env.VERCEL_BLOB_READ_URL || `https://${storeId}.private.blob.vercel-storage.com`;
    this.readUrl = `${readBase.replace(/\/+$/, '')}/${this.pathname}?cache=0`;
    this.apiUrl = process.env.VERCEL_BLOB_API_URL || process.env.NEXT_PUBLIC_VERCEL_BLOB_API_URL || 'https://vercel.com/api/blob';
  }

  private async load(force = false): Promise<Doc> {
    if (this.doc && !force && Date.now() - this.loadedAt < this.readTtlMs) return this.doc;
    const res = await fetch(this.readUrl, {
      headers: { authorization: `Bearer ${this.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      this.doc = structuredClone(EMPTY);
      this.etag = null;
    } else if (!res.ok) {
      throw new Error(`Vercel Blob read failed: HTTP ${res.status}`);
    } else {
      this.doc = { ...structuredClone(EMPTY), ...((await res.json()) as Doc) };
      this.etag = res.headers.get('etag');
    }
    this.loadedAt = Date.now();
    return this.doc!;
  }

  private async put(doc: Doc): Promise<'ok' | 'conflict'> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      'x-api-version': API_VERSION,
      'x-vercel-blob-access': 'private',
      'x-add-random-suffix': '0',
      'x-allow-overwrite': '1',
      'x-content-type': 'application/json',
      'x-cache-control-max-age': '60',
    };
    if (this.etag) headers['x-if-match'] = this.etag;
    const res = await fetch(`${this.apiUrl}/?${new URLSearchParams({ pathname: this.pathname })}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(doc),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 412) return 'conflict';
    if (!res.ok) throw new Error(`Vercel Blob write failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const body = (await res.json().catch(() => ({}))) as { etag?: string };
    this.etag = body.etag ?? res.headers.get('etag') ?? null;
    this.doc = doc;
    this.loadedAt = Date.now();
    return 'ok';
  }

  /** Read-modify-write with optimistic concurrency. `mutate` returns false to skip writing. */
  private async update<T>(mutate: (d: Doc) => { write: boolean; result: T }): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = structuredClone(await this.load(attempt > 0));
      const { write, result } = mutate(doc);
      if (!write) {
        this.doc = doc; // keep in-memory changes such as latest.c
        return result;
      }
      if ((await this.put(doc)) === 'ok') return result;
    }
    throw new Error('Vercel Blob: too many concurrent writes');
  }

  async init() {
    await this.load(true);
  }

  async latest() {
    return (await this.load()).latest;
  }

  async record(q: { bid: number; ask: number }, now: number): Promise<RecordResult> {
    return this.update((d) => {
      const prev = d.latest;
      const changed = !prev || !sameQuote(prev, q);
      const day = dayKey(now);
      const today = d.daily[day];
      const newDay = !today || !sameQuote(today, q);
      d.latest = { bid: q.bid, ask: q.ask, t: changed ? now : prev!.t, c: now };
      if (changed) {
        d.rows.push({ bid: q.bid, ask: q.ask, t: now });
        if (d.rows.length > MAX_ROWS) d.rows.splice(0, d.rows.length - MAX_ROWS);
      }
      if (newDay) d.daily[day] = { bid: q.bid, ask: q.ask, t: now };
      // Only "last checked" changed → keep it in memory, don't spend a write
      return { write: changed || newDay, result: { row: { ...d.latest }, prev, changed } };
    });
  }

  async claimRefresh(now: number, refreshMs: number) {
    // Per-instance only (a shared lock would cost a write per minute).
    if (now - this.claimedAt < refreshMs) return false;
    this.claimedAt = now;
    return true;
  }

  async range(since: number) {
    return (await this.load()).rows.filter((p) => p.t >= since);
  }

  async before(ts: number) {
    const rows = (await this.load()).rows;
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].t < ts) return rows[i];
    return null;
  }

  async daily(since: number | null) {
    return Object.values((await this.load()).daily)
      .filter((p) => since === null || p.t >= since)
      .sort((a, b) => a.t - b.t);
  }

  async listAlerts() {
    return (await this.load(true)).alerts;
  }

  async saveAlert(a: AlertInput) {
    return this.update((d) => {
      const i = a.id ? d.alerts.findIndex((x) => x.id === a.id) : -1;
      const id = a.id ?? String(++d.seq);
      const rec = toAlertRecord({ ...a, createdAt: i >= 0 ? d.alerts[i].createdAt : a.createdAt }, id);
      if (i >= 0) d.alerts[i] = rec;
      else d.alerts.push(rec);
      return { write: true, result: rec };
    });
  }

  async stats() {
    const d = await this.load();
    return { rows: d.rows.length, days: Object.keys(d.daily).length, pathname: this.pathname, bytes: JSON.stringify(d).length };
  }
}
