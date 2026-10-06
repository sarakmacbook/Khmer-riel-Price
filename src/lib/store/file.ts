/**
 * A read-only `RateStore` backed by a parsed export file.
 *
 * `/import` deliberately does not have its own insert logic: the file is
 * exposed as an ordinary store and the data is written with the same copy
 * pipeline the backup feature uses (`transferStore`). That gives imports every
 * guarantee the copy already has — history rows are de-duplicated on
 * (timestamp, bid, ask) so importing the same file twice changes nothing,
 * alert subscriptions merge on their natural key (chat/webhook + condition +
 * target), and "replace" is refused when the target backend cannot erase its
 * own data.
 *
 * Writing to it is impossible by design: sampling a rate into an import is a
 * programming error, and the copy only ever reads from the source side.
 */

import type { ExportBundle } from '../export-file';
import {
  dailyFromPoints,
  toAlertRecord,
  type AlertInput,
  type AlertRecord,
  type Point,
  type RateStore,
  type RecordResult,
  type StoreKind,
} from './types';

export class ExportFileStore implements RateStore {
  /**
   * There is no dedicated "file" backend in the store union, and there is no
   * reason to add one: this store never becomes the active database, it is only
   * the source of a copy. Its label is what every message shows.
   */
  readonly kind: StoreKind = 'memory';
  readonly label: string;
  readonly persistent = false;
  readonly readTtlMs = Number.POSITIVE_INFINITY;

  private readonly points: Point[];
  private readonly alerts: AlertRecord[];

  constructor(bundle: ExportBundle, label?: string) {
    this.label = label ?? `📄 ${bundle.counts.history.toLocaleString()} rows from the file`;
    this.points = [...bundle.history].sort((a, b) => a.t - b.t);
    this.alerts = bundle.alerts.map((a, i) => toAlertRecord(a as AlertInput, `file-${i + 1}`, a.createdAt));
  }

  async init(): Promise<void> {}

  async latest() {
    const last = this.points[this.points.length - 1];
    return last ? { bid: last.bid, ask: last.ask, t: last.t, c: last.t } : null;
  }

  /** The file is immutable — the app may never record a live rate into it. */
  async record(_q: { bid: number; ask: number }, _now: number): Promise<RecordResult> {
    throw new Error('An imported file is read-only — import it into a database instead.');
  }

  async claimRefresh(_now: number, _refreshMs: number): Promise<boolean> {
    return false;
  }

  async range(since: number): Promise<Point[]> {
    return this.points.filter((p) => p.t >= since).map(({ bid, ask, t }) => ({ bid, ask, t }));
  }

  async before(ts: number): Promise<Point | null> {
    for (let i = this.points.length - 1; i >= 0; i--) {
      if (this.points[i].t < ts) {
        const { bid, ask, t } = this.points[i];
        return { bid, ask, t };
      }
    }
    return null;
  }

  async daily(since: number | null): Promise<Point[]> {
    return dailyFromPoints(await this.range(since ?? 0));
  }

  async listAlerts(): Promise<AlertRecord[]> {
    return this.alerts.map((a) => ({ ...a }));
  }

  async saveAlert(_a: AlertInput): Promise<AlertRecord> {
    throw new Error('An imported file is read-only — import it into a database instead.');
  }

  async stats(): Promise<Record<string, unknown>> {
    return {
      rows: this.points.length,
      alerts: this.alerts.length,
      first: this.points.length ? new Date(this.points[0].t).toISOString() : null,
      last: this.points.length ? new Date(this.points[this.points.length - 1].t).toISOString() : null,
      note: 'read from an export file',
    };
  }
}
