// Storage abstraction: every supported database implements RateStore.
// Timestamps are epoch milliseconds throughout this layer.

export type StoreKind = 'postgres' | 'turso' | 'mongodb' | 'upstash' | 'redis' | 'blob' | 'memory';

/** A stored price. `t` = when this price was first seen, `c` = last time Wing Bank confirmed it. */
export interface RateRow {
  bid: number;
  ask: number;
  t: number;
  c: number;
}

export interface Point {
  bid: number;
  ask: number;
  t: number;
}

export interface RecordResult {
  row: RateRow;
  prev: RateRow | null;
  /** true when the price differs from the previous stored price (and this call stored it) */
  changed: boolean;
}

export type AlertCondition = 'change' | 'above' | 'below';

export interface AlertRecord {
  id: string;
  /** 'web' = configured on the website, 'bot' = subscribed via Telegram /alert */
  source: 'web' | 'bot';
  webhookUrl: string | null;
  chatId: string | null;
  botToken: string | null;
  condition: AlertCondition;
  targetRate: number | null;
  /** Optional custom message template (supports {bid} {ask} {diff} {arrow} {time} {link}). Null = default template. */
  customMessage: string | null;
  active: boolean;
  createdAt: number;
  lastAlertAt: number | null;
}

export type AlertInput = Omit<AlertRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: number };

export interface RateStore {
  readonly kind: StoreKind;
  /** Human label, e.g. "Postgres (Neon)" */
  readonly label: string;
  /** false only for the in-memory fallback */
  readonly persistent: boolean;
  /** How long an instance may reuse its cached latest row before re-reading (saves quota) */
  readonly readTtlMs: number;

  init(): Promise<void>;
  latest(): Promise<RateRow | null>;
  /**
   * Store a fresh quote. Implementations insert a new history row only when the
   * price changed or it's the first check of a new (local) day; otherwise they
   * just bump the "last checked" time.
   */
  record(q: { bid: number; ask: number }, now: number): Promise<RecordResult>;
  /** Atomically claim the right to refresh (so only one instance scrapes). */
  claimRefresh(now: number, refreshMs: number): Promise<boolean>;
  /** History rows with t >= since, ascending. */
  range(since: number): Promise<Point[]>;
  /** Last history row with t < ts. */
  before(ts: number): Promise<Point | null>;
  /** Last price of each local day with t >= since (or all), ascending. */
  daily(since: number | null): Promise<Point[]>;

  listAlerts(): Promise<AlertRecord[]>;
  saveAlert(a: AlertInput): Promise<AlertRecord>;

  stats(): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Daily snapshots are grouped by Cambodia local day (UTC+7) by default. */
export const TZ_OFFSET_HOURS = Number(process.env.TZ_OFFSET_HOURS ?? 7) || 0;
export const TZ_OFFSET_MS = TZ_OFFSET_HOURS * 3_600_000;
export const DAY_MS = 86_400_000;

export const dayKey = (t: number) => new Date(t + TZ_OFFSET_MS).toISOString().slice(0, 10);
/** Start of the local day containing t (epoch ms). */
export const dayStart = (t: number) => Math.floor((t + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
/** "+07:00" style offset string (MongoDB). */
export const tzOffsetString = () => {
  const m = Math.round(Math.abs(TZ_OFFSET_HOURS) * 60);
  return `${TZ_OFFSET_HOURS < 0 ? '-' : '+'}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export const sameQuote = (a: { bid: number; ask: number }, b: { bid: number; ask: number }) =>
  a.bid === b.bid && a.ask === b.ask;

/** Should a new history row be written? (price changed, or first check of a new local day) */
export const needsNewRow = (prev: RateRow | null, q: { bid: number; ask: number }, now: number) =>
  !prev || !sameQuote(prev, q) || dayKey(now) !== dayKey(prev.t);

/** Group ascending points into the last point of each local day. */
export function dailyFromPoints(points: Point[]): Point[] {
  const byDay = new Map<string, Point>();
  for (const p of points) byDay.set(dayKey(p.t), p);
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

export function toAlertRecord(a: AlertInput, id: string, now = Date.now()): AlertRecord {
  const customMessage = typeof a.customMessage === 'string' ? a.customMessage.trim() : '';
  return {
    id,
    source: a.source ?? 'web',
    webhookUrl: a.webhookUrl ?? null,
    chatId: a.chatId ?? null,
    botToken: a.botToken ?? null,
    condition: a.condition ?? 'change',
    targetRate: a.targetRate ?? null,
    // Normalise to null so "blank = use the default template" holds everywhere.
    customMessage: customMessage || null,
    active: a.active ?? true,
    createdAt: a.createdAt ?? now,
    lastAlertAt: a.lastAlertAt ?? null,
  };
}

export const num = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v)));
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
