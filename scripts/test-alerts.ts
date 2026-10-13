/**
 * Tests for the automatic Telegram alert path.
 *
 * Runs the REAL code (lib/alerts → lib/telegram) against a local fake
 * "api.telegram.org", pointed at by TELEGRAM_API_URL, so the retry/backoff and
 * delivery behaviour are exercised end to end — no network, no real bot.
 *
 *   npm run test:alerts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { MemoryStore } from '@/lib/store/memory';
import type { RateStore } from '@/lib/store/types';
import type { WingBankQuote } from '@/lib/scraper';

// ---------------------------------------------------------------------------
// Fake Telegram server
// ---------------------------------------------------------------------------

interface RecordedCall {
  path: string;
  body: Record<string, unknown>;
}

interface FakeTelegram {
  url: string;
  calls: RecordedCall[];
  /** Replace the queue of canned replies (one per incoming request). */
  reply(...replies: Array<{ status: number; body: unknown }>): void;
  close(): Promise<void>;
}

async function startFakeTelegram(): Promise<FakeTelegram> {
  // Replies are consumed in order; the last one repeats for any extra call.
  let queue: Array<{ status: number; body: unknown }> = [{ status: 200, body: { ok: true, result: { message_id: 1 } } }];
  const calls: RecordedCall[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      calls.push({ path: req.url ?? '', body });
      const reply = queue.length > 1 ? queue.shift()! : queue[0];
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    reply(...replies) {
      queue = [...replies];
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// TELEGRAM_API_BASE is read once at import time, so point it at the fake
// server BEFORE the modules under test are loaded (hence the lazy import).
let telegram: FakeTelegram;
let notifyRateChange!: typeof import('@/lib/alerts').notifyRateChange;

before(async () => {
  telegram = await startFakeTelegram();
  process.env.TELEGRAM_API_URL = telegram.url;
  ({ notifyRateChange } = await import('@/lib/alerts'));
});
after(async () => {
  await telegram?.close();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A store with one active 'change' alert for chat 123, using token "tok". */
async function storeWithAlert(): Promise<RateStore> {
  const store = new MemoryStore();
  await store.init();
  // Seed the previous price so a move can be detected.
  await store.record({ bid: 4050, ask: 4058 }, Date.now() - 60_000);
  await store.saveAlert({
    source: 'web',
    chatId: '123',
    webhookUrl: null,
    botToken: 'tok',
    condition: 'change',
    targetRate: null,
    customMessage: null,
    active: true,
    lastAlertAt: null,
  });
  return store;
}

const quote = (bid: number, ask: number): WingBankQuote => ({
  bid,
  ask,
  rate: bid,
  fetchedAt: new Date().toISOString(),
});

const prev = { bid: 4050, ask: 4058 };

const okReply = { status: 200, body: { ok: true, result: { message_id: 7 } } };
const limitedReply = {
  status: 429,
  body: {
    ok: false,
    error_code: 429,
    description: 'Too Many Requests: retry after 1',
    parameters: { retry_after: 1 },
  },
};
const downReply = { status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } };
const badTokenReply = { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notifyRateChange', () => {
  it('delivers an alert when the price moves', async () => {
    telegram.calls.length = 0;
    telegram.reply(okReply);
    const store = await storeWithAlert();

    const res = await notifyRateChange(prev, quote(4055, 4063), store);

    assert.equal(res.matched, 1);
    assert.equal(res.delivered, 1);
    assert.equal(telegram.calls.length, 1);
    assert.match(telegram.calls[0].path, /\/bottok\/sendMessage$/);
    assert.equal(telegram.calls[0].body.chat_id, '123');
    assert.match(String(telegram.calls[0].body.text), /4,055/);
  });

  it('retries a Telegram 429 (retry_after) and still delivers', async () => {
    telegram.calls.length = 0;
    telegram.reply(limitedReply, okReply);
    const store = await storeWithAlert();

    const res = await notifyRateChange(prev, quote(4055, 4063), store);

    assert.equal(telegram.calls.length, 2, 'expected one retry after the 429');
    assert.equal(res.delivered, 1, 'the alert must survive a transient rate limit');
    assert.equal(res.failed, 0);
  });

  it('retries a 5xx from Telegram/proxy and still delivers', async () => {
    telegram.calls.length = 0;
    telegram.reply(downReply, okReply);
    const store = await storeWithAlert();

    const res = await notifyRateChange(prev, quote(4060, 4068), store);

    assert.equal(telegram.calls.length, 2, 'expected one retry after the 502');
    assert.equal(res.delivered, 1);
  });

  it('does not retry a permanent credential failure (401)', async () => {
    telegram.calls.length = 0;
    telegram.reply(badTokenReply);
    const store = await storeWithAlert();

    const res = await notifyRateChange(prev, quote(4055, 4063), store);

    assert.equal(telegram.calls.length, 1, 'a bad token must not be retried');
    assert.equal(res.delivered, 0);
    assert.equal(res.failed, 1);
    assert.match(res.error ?? '', /401/);
  });

  it('reports the failure when every attempt is rate limited', async () => {
    telegram.calls.length = 0;
    telegram.reply(limitedReply);
    const store = await storeWithAlert();

    const res = await notifyRateChange(prev, quote(4055, 4063), store);

    assert.equal(res.delivered, 0);
    assert.equal(res.failed, 1, 'an undeliverable alert must be counted, not silently dropped');
    assert.ok(telegram.calls.length >= 2, 'it should have been retried before giving up');
  });

  it('sends nothing when the price did not move, and says why', async () => {
    telegram.calls.length = 0;
    telegram.reply(okReply);
    const store = await storeWithAlert();

    const res = await notifyRateChange(prev, quote(4050, 4058), store);

    assert.equal(telegram.calls.length, 0);
    assert.equal(res.delivered, 0);
    assert.equal(res.reason, 'no-move');
  });

  it('sends nothing on the very first tick, and says why', async () => {
    telegram.calls.length = 0;
    telegram.reply(okReply);
    const store = await storeWithAlert();

    const res = await notifyRateChange(null, quote(4055, 4063), store);

    assert.equal(telegram.calls.length, 0);
    assert.equal(res.reason, 'no-previous');
  });

  it('sends nothing when no alert is configured, and says why', async () => {
    telegram.calls.length = 0;
    telegram.reply(okReply);
    const store = new MemoryStore();
    await store.init();

    const res = await notifyRateChange(prev, quote(4055, 4063), store);

    assert.equal(telegram.calls.length, 0);
    assert.equal(res.reason, 'no-alerts');
  });

  it('marks an inactive alert as not matched', async () => {
    telegram.calls.length = 0;
    telegram.reply(okReply);
    const store = await storeWithAlert();
    const [alert] = await store.listAlerts();
    await store.saveAlert({ ...alert, active: false });

    const res = await notifyRateChange(prev, quote(4055, 4063), store);

    assert.equal(telegram.calls.length, 0);
    assert.equal(res.matched, 0);
  });
});
