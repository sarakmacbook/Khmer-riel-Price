import { type RedisTransport, pairs } from './redis-client';
import {
  type AlertInput,
  type AlertRecord,
  type Point,
  type RateRow,
  type RateStore,
  type RecordResult,
  dayKey,
  toAlertRecord,
} from './types';

// Redis layout (prefix configurable with REDIS_PREFIX, default "wingrate:"):
//   latest         JSON {bid, ask, t, c}         current price
//   rates          ZSET score=t member=JSON       one entry per price change
//   daily          HASH day → JSON {bid, ask, t}  last price of each local day
//   refresh        lock key (SET NX PX)          refresh claim
//   alerts         HASH id → JSON                 Telegram alert settings
//   alerts:seq     counter
// ~2 commands per refresh + 1 per cached read → fits Upstash / Redis Cloud free tiers.

// Atomic record: compare with latest, append on change, always update today's snapshot.
// All values are strings inside JSON so there is no float formatting ambiguity.
const RECORD_LUA = `
local prevRaw = redis.call('GET', KEYS[1])
local changed = 1
local t = ARGV[3]
if prevRaw then
  local p = cjson.decode(prevRaw)
  if p.bid == ARGV[1] and p.ask == ARGV[2] then
    changed = 0
    t = p.t
  end
end
redis.call('SET', KEYS[1], cjson.encode({bid=ARGV[1], ask=ARGV[2], t=t, c=ARGV[3]}))
if changed == 1 then
  redis.call('ZADD', KEYS[2], ARGV[3], cjson.encode({bid=ARGV[1], ask=ARGV[2], t=ARGV[3]}))
end
redis.call('HSET', KEYS[3], ARGV[4], cjson.encode({bid=ARGV[1], ask=ARGV[2], t=ARGV[3]}))
return {changed, prevRaw or ''}
`;

type Raw = { bid: string; ask: string; t: string; c?: string };
const toRow = (r: Raw): RateRow => ({ bid: Number(r.bid), ask: Number(r.ask), t: Number(r.t), c: Number(r.c ?? r.t) });
const toPoint = (r: Raw): Point => ({ bid: Number(r.bid), ask: Number(r.ask), t: Number(r.t) });
const parseJson = <T>(s: unknown): T | null => {
  if (typeof s !== 'string' || !s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

export class RedisStore implements RateStore {
  readonly persistent = true;
  readonly readTtlMs = 10_000;
  private k: (name: string) => string;

  constructor(
    private r: RedisTransport,
    readonly kind: 'upstash' | 'redis',
    readonly label: string,
  ) {
    const prefix = process.env.REDIS_PREFIX ?? 'wingrate:';
    this.k = (name) => prefix + name;
  }

  async init() {
    const pong = await this.r.cmd('PING');
    if (pong !== 'PONG') throw new Error(`Unexpected PING reply: ${String(pong)}`);
  }

  async latest() {
    const raw = parseJson<Raw>(await this.r.cmd('GET', this.k('latest')));
    return raw ? toRow(raw) : null;
  }

  async record(q: { bid: number; ask: number }, now: number): Promise<RecordResult> {
    const reply = (await this.r.cmd(
      'EVAL',
      RECORD_LUA,
      3,
      this.k('latest'),
      this.k('rates'),
      this.k('daily'),
      String(q.bid),
      String(q.ask),
      String(now),
      dayKey(now),
    )) as [number, string];
    const prevRaw = parseJson<Raw>(reply?.[1]);
    const prev = prevRaw ? toRow(prevRaw) : null;
    const changed = Number(reply?.[0]) === 1;
    return { row: { bid: q.bid, ask: q.ask, t: changed || !prev ? now : prev.t, c: now }, prev, changed };
  }

  async claimRefresh(_now: number, refreshMs: number) {
    const ok = await this.r.cmd('SET', this.k('refresh'), '1', 'NX', 'PX', Math.max(1000, refreshMs - 1000));
    return ok === 'OK';
  }

  async range(since: number) {
    const list = (await this.r.cmd('ZRANGEBYSCORE', this.k('rates'), since, '+inf')) as string[] | null;
    return (list ?? []).map((s) => parseJson<Raw>(s)).filter((x): x is Raw => !!x).map(toPoint);
  }

  async before(ts: number) {
    const list = (await this.r.cmd('ZREVRANGEBYSCORE', this.k('rates'), `(${ts}`, '-inf', 'LIMIT', 0, 1)) as string[] | null;
    const raw = parseJson<Raw>(list?.[0]);
    return raw ? toPoint(raw) : null;
  }

  async daily(since: number | null) {
    const all = pairs(await this.r.cmd('HGETALL', this.k('daily')))
      .map(([, v]) => parseJson<Raw>(v))
      .filter((x): x is Raw => !!x)
      .map(toPoint)
      .filter((p) => since === null || p.t >= since);
    return all.sort((a, b) => a.t - b.t);
  }

  async listAlerts() {
    return pairs(await this.r.cmd('HGETALL', this.k('alerts')))
      .map(([, v]) => parseJson<AlertRecord>(v))
      .filter((x): x is AlertRecord => !!x)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async saveAlert(a: AlertInput) {
    let createdAt = a.createdAt;
    if (a.id && createdAt === undefined) {
      createdAt = parseJson<AlertRecord>(await this.r.cmd('HGET', this.k('alerts'), a.id))?.createdAt;
    }
    const id = a.id ?? String(await this.r.cmd('INCR', this.k('alerts:seq')));
    const rec = toAlertRecord({ ...a, createdAt }, id);
    await this.r.cmd('HSET', this.k('alerts'), id, JSON.stringify(rec));
    return rec;
  }

  async stats() {
    const [rows, days] = await Promise.all([this.r.cmd('ZCARD', this.k('rates')), this.r.cmd('HLEN', this.k('daily'))]);
    return { rows, days, prefix: this.k('') };
  }
}
