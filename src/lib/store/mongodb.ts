import type { Collection, Db, MongoClient, ObjectId as ObjectIdType } from 'mongodb';
import {
  type AlertInput,
  type AlertRecord,
  type Point,
  type RateRow,
  type RateStore,
  type RecordResult,
  needsNewRow,
  sameQuote,
  toAlertRecord,
  tzOffsetString,
} from './types';

// MongoDB Atlas (M0 free) / any MongoDB 5+.
// The driver is imported lazily, so it's only loaded when MongoDB is the configured store.

type RateDoc = { seq: number; bid: number; ask: number; t: Date; c: Date };
type AlertDoc = Omit<AlertRecord, 'id'> & { _id?: ObjectIdType };
type MetaDoc = { _id: string; until: Date };

const g = globalThis as typeof globalThis & { __wingrateMongo?: Map<string, Promise<MongoClient>> };

function dbNameFrom(uri: string) {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i);
  return process.env.MONGODB_DB || (m ? decodeURIComponent(m[1]) : 'wingrate');
}

const toRow = (d: RateDoc): RateRow => ({ bid: d.bid, ask: d.ask, t: d.t.getTime(), c: d.c.getTime() });
const toPoint = (d: Pick<RateDoc, 'bid' | 'ask' | 't'>): Point => ({ bid: d.bid, ask: d.ask, t: new Date(d.t).getTime() });
const toAlert = (d: AlertDoc & { _id: ObjectIdType }): AlertRecord => {
  const { _id, ...rest } = d;
  return { ...rest, id: _id.toHexString() };
};
const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

export class MongoStore implements RateStore {
  readonly kind = 'mongodb' as const;
  readonly persistent = true;
  readonly readTtlMs = 5_000;
  private db!: Db;
  private ObjectId!: typeof ObjectIdType;

  constructor(
    private uri: string,
    readonly label: string,
  ) {}

  private get rates(): Collection<RateDoc> {
    return this.db.collection<RateDoc>('exchange_rates');
  }
  private get alerts(): Collection<AlertDoc> {
    return this.db.collection<AlertDoc>('telegram_alerts');
  }
  private get meta(): Collection<MetaDoc> {
    return this.db.collection<MetaDoc>('wingrate_meta');
  }

  async init() {
    const mod = await import('mongodb');
    this.ObjectId = mod.ObjectId;
    g.__wingrateMongo ??= new Map();
    const cached = g.__wingrateMongo.get(this.uri);
    const clientP = cached ?? new mod.MongoClient(this.uri, {
      maxPoolSize: process.env.VERCEL ? 3 : 10,
      serverSelectionTimeoutMS: 8_000,
      appName: 'wingrate',
    }).connect();
    if (!cached) {
      g.__wingrateMongo.set(this.uri, clientP);
      clientP.catch(() => g.__wingrateMongo?.delete(this.uri));
    }
    this.db = (await clientP).db(dbNameFrom(this.uri));
    await Promise.all([this.rates.createIndex({ seq: 1 }, { unique: true }), this.rates.createIndex({ t: 1 })]);
  }

  private latestDoc() {
    return this.rates.find().sort({ seq: -1 }).limit(1).next();
  }

  async latest() {
    const d = await this.latestDoc();
    return d ? toRow(d) : null;
  }

  async record(q: { bid: number; ask: number }, now: number): Promise<RecordResult> {
    const prevDoc = await this.latestDoc();
    const prev = prevDoc ? toRow(prevDoc) : null;
    const at = new Date(now);
    if (needsNewRow(prev, q, now)) {
      const doc: RateDoc = { seq: (prevDoc?.seq ?? 0) + 1, bid: q.bid, ask: q.ask, t: at, c: at };
      try {
        await this.rates.insertOne(doc);
        return { row: toRow(doc), prev, changed: !prev || !sameQuote(prev, q) };
      } catch (e) {
        // Another instance inserted the same seq at the same moment — it owns this change.
        if (!isDup(e)) throw e;
        const cur = (await this.latest())!;
        return { row: cur, prev, changed: false };
      }
    }
    await this.rates.updateOne({ _id: prevDoc!._id }, { $set: { c: at } });
    return { row: { ...prev!, c: now }, prev, changed: false };
  }

  async claimRefresh(now: number, refreshMs: number) {
    try {
      await this.meta.updateOne(
        { _id: 'refresh', until: { $lt: new Date(now) } },
        { $set: { until: new Date(now + refreshMs - 1000) } },
        { upsert: true },
      );
      return true;
    } catch (e) {
      if (isDup(e)) return false; // lock held (doc exists and not expired)
      throw e;
    }
  }

  async range(since: number) {
    const docs = await this.rates.find({ t: { $gte: new Date(since) } }).sort({ t: 1 }).limit(5000).toArray();
    return docs.map(toPoint);
  }

  async before(ts: number) {
    const d = await this.rates.find({ t: { $lt: new Date(ts) } }).sort({ t: -1 }).limit(1).next();
    return d ? toPoint(d) : null;
  }

  async daily(since: number | null) {
    const docs = await this.rates
      .aggregate<{ bid: number; ask: number; t: Date }>([
        ...(since !== null ? [{ $match: { t: { $gte: new Date(since) } } }] : []),
        { $sort: { t: 1 } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$t', timezone: tzOffsetString() } },
            bid: { $last: '$bid' },
            ask: { $last: '$ask' },
            t: { $last: '$t' },
          },
        },
        { $sort: { t: 1 } },
      ])
      .toArray();
    return docs.map(toPoint);
  }

  async listAlerts() {
    const docs = await this.alerts.find().sort({ createdAt: 1 }).toArray();
    return docs.map((d) => toAlert(d as AlertDoc & { _id: ObjectIdType }));
  }

  async saveAlert(a: AlertInput) {
    const { id, ...rest } = toAlertRecord(a, a.id ?? '');
    if (a.id) {
      const { createdAt, ...fields } = rest;
      void createdAt;
      const _id = new this.ObjectId(a.id);
      await this.alerts.updateOne({ _id }, { $set: fields });
      const d = await this.alerts.findOne({ _id });
      return toAlert(d as AlertDoc & { _id: ObjectIdType });
    }
    void id;
    const res = await this.alerts.insertOne({ ...rest });
    return { ...rest, id: res.insertedId.toHexString() };
  }

  async stats() {
    const [rows, first, last] = await Promise.all([
      this.rates.estimatedDocumentCount(),
      this.rates.find().sort({ t: 1 }).limit(1).next(),
      this.rates.find().sort({ t: -1 }).limit(1).next(),
    ]);
    return { rows, first: first?.t ?? null, last: last?.t ?? null, database: this.db.databaseName };
  }
}
