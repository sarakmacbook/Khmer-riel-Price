import net from 'node:net';
import tls from 'node:tls';

// Dependency-free Redis transports:
//  - UpstashRest: Upstash REST API over fetch (KV_REST_API_URL / UPSTASH_REDIS_REST_URL)
//  - RespClient:  RESP2 over TCP/TLS for redis:// and rediss:// URLs (Redis Cloud, Upstash TCP, self-hosted)
// Both return replies in the same shape: string | number | null | array.

export type RedisArg = string | number;
export type RedisReply = string | number | null | RedisReply[];

export interface RedisTransport {
  cmd(...args: RedisArg[]): Promise<RedisReply>;
}

const TIMEOUT_MS = 10_000;

export class UpstashRest implements RedisTransport {
  constructor(
    private url: string,
    private token: string,
  ) {
    this.url = url.replace(/\/+$/, '');
  }

  async cmd(...args: RedisArg[]): Promise<RedisReply> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => null)) as { result?: RedisReply; error?: string } | null;
    if (!data) throw new Error(`Upstash REST: HTTP ${res.status}`);
    if (data.error) throw new Error(`Upstash: ${data.error}`);
    return data.result ?? null;
  }
}

class RedisReplyError extends Error {}

/** Parse one RESP2 value at `pos`. Returns null if the buffer doesn't hold a complete value yet. */
function parse(buf: Buffer, pos: number): [RedisReply | RedisReplyError, number] | null {
  if (pos >= buf.length) return null;
  const end = buf.indexOf('\r\n', pos);
  if (end === -1) return null;
  const type = buf[pos];
  const line = buf.toString('utf8', pos + 1, end);
  switch (type) {
    case 43: // +
      return [line, end + 2];
    case 45: // -
      return [new RedisReplyError(line), end + 2];
    case 58: // :
      return [Number(line), end + 2];
    case 36: {
      // $
      const len = Number(line);
      if (len < 0) return [null, end + 2];
      const start = end + 2;
      if (buf.length < start + len + 2) return null;
      return [buf.toString('utf8', start, start + len), start + len + 2];
    }
    case 42: {
      // *
      const n = Number(line);
      if (n < 0) return [null, end + 2];
      const out: RedisReply[] = [];
      let p = end + 2;
      for (let i = 0; i < n; i++) {
        const r = parse(buf, p);
        if (!r) return null;
        out.push(r[0] instanceof RedisReplyError ? null : r[0]);
        p = r[1];
      }
      return [out, p];
    }
    default:
      throw new Error(`Redis protocol error (unexpected byte ${type})`);
  }
}

const encode = (args: RedisArg[]) => {
  let s = `*${args.length}\r\n`;
  for (const a of args) {
    const v = String(a);
    s += `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
  }
  return s;
};

export class RespClient implements RedisTransport {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private queue: { resolve: (v: RedisReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

  constructor(private url: string) {}

  private fail(err: Error) {
    const q = this.queue.splice(0);
    q.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(err);
    });
    this.socket?.destroy();
    this.socket = null;
    this.connecting = null;
    this.buf = Buffer.alloc(0);
  }

  private onData(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let pos = 0;
    for (;;) {
      let r: ReturnType<typeof parse>;
      try {
        r = parse(this.buf, pos);
      } catch (e) {
        return this.fail(e as Error);
      }
      if (!r) break;
      pos = r[1];
      const p = this.queue.shift();
      if (!p) continue;
      clearTimeout(p.timer);
      if (r[0] instanceof RedisReplyError) p.reject(new Error(`Redis: ${r[0].message}`));
      else p.resolve(r[0]);
    }
    this.buf = pos >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(pos);
  }

  private raw(args: RedisArg[]): Promise<RedisReply> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('Redis not connected'));
      const timer = setTimeout(() => this.fail(new Error('Redis command timed out')), TIMEOUT_MS);
      this.queue.push({ resolve, reject, timer });
      this.socket.write(encode(args));
    });
  }

  private connect(): Promise<void> {
    if (this.socket && !this.connecting) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const u = new URL(this.url);
    const secure = u.protocol === 'rediss:';
    const host = u.hostname;
    const port = Number(u.port || 6379);

    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
      const timer = setTimeout(() => sock.destroy(new Error('Redis connect timed out')), TIMEOUT_MS);
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 30_000);
      sock.on('data', (c) => this.onData(c));
      sock.on('error', (e) => {
        clearTimeout(timer);
        this.fail(e);
        reject(e);
      });
      sock.on('close', () => this.fail(new Error('Redis connection closed')));
      sock.once(secure ? 'secureConnect' : 'connect', async () => {
        clearTimeout(timer);
        this.socket = sock;
        try {
          const user = decodeURIComponent(u.username || '');
          const pass = decodeURIComponent(u.password || '');
          if (pass) await this.raw(user && user !== 'default' ? ['AUTH', user, pass] : ['AUTH', pass]);
          const dbIndex = u.pathname.replace('/', '');
          if (dbIndex && dbIndex !== '0') await this.raw(['SELECT', dbIndex]);
          this.connecting = null;
          resolve();
        } catch (e) {
          this.fail(e as Error);
          reject(e);
        }
      });
    });
    return this.connecting;
  }

  async cmd(...args: RedisArg[]): Promise<RedisReply> {
    await this.connect();
    return this.raw(args);
  }
}

const g = globalThis as typeof globalThis & { __wingrateRedis?: Map<string, RespClient> };

/** One persistent TCP connection per URL per instance. */
export function respClient(url: string): RespClient {
  g.__wingrateRedis ??= new Map();
  let c = g.__wingrateRedis.get(url);
  if (!c) g.__wingrateRedis.set(url, (c = new RespClient(url)));
  return c;
}

/** HGETALL-style flat [k, v, k, v] → [[k, v], ...] (also accepts objects). */
export function pairs(reply: RedisReply | Record<string, string>): [string, string][] {
  if (!reply) return [];
  if (!Array.isArray(reply)) return Object.entries(reply as Record<string, string>);
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < reply.length; i += 2) out.push([String(reply[i]), String(reply[i + 1])]);
  return out;
}
