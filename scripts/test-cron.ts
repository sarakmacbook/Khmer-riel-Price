/**
 * Integration test for the cron route handler itself — the endpoint Vercel
 * Cron Jobs calls. Exercises the REAL `GET` in
 * `src/app/api/cron/update-rate/route.ts` (scrape → record → alert → report)
 * with only the Wing Bank scrape and the Telegram API faked, so the alert
 * diagnostics added for "the bot never alerts" are checked end to end.
 *
 *   npm run test:cron
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it, mock } from 'node:test';

// ---------------------------------------------------------------------------
// Fake Telegram (see scripts/test-alerts.ts for the same pattern)
// ---------------------------------------------------------------------------

interface RecordedCall {
  body: Record<string, unknown>;
}

let calls: RecordedCall[] = [];
let telegramUrl = '';
/** Canned replies, consumed in order; the last one repeats for extra calls. */
let queue: Array<{ status: number; body: unknown }> = [
  { status: 200, body: { ok: true, result: { message_id: 1 } } },
];

async function startFakeTelegram(): Promise<{ close(): Promise<void> }> {
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
      calls.push({ body });
      const reply = queue.length > 1 ? queue.shift()! : queue[0];
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  telegramUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Set the canned replies the fake Telegram will return, in order. */
const setReplies = (r: Array<{ status: number; body: unknown }>) => {
  queue = r;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let currentQuote = { bid: 4050, ask: 4058, rate: 4050, fetchedAt: new Date().toISOString() };

let GET!: (req: unknown) => Promise<{ json(): Promise<Record<string, unknown>> }>;
let getStoreOrMemory!: typeof import('@/lib/store').getStoreOrMemory;
let NextRequest!: typeof import('next/server').NextRequest;
let fake!: { close(): Promise<void> };

before(async () => {
  fake = await startFakeTelegram();
  // Both are read at import time / by the modules under test.
  process.env.TELEGRAM_API_URL = telegramUrl;

  // Only the bank scrape is stubbed; everything else is the real code.
  mock.module('@/lib/scraper', {
    namedExports: {
      fetchWingBankQuote: async () => currentQuote,
      fetchWingBankRate: async () => currentQuote.rate,
      getFreshQuote: () => null,
    },
  });

  ({ GET } = (await import('@/app/api/cron/update-rate/route')) as unknown as {
    GET: typeof GET;
  });
  ({ getStoreOrMemory } = await import('@/lib/store'));
  ({ NextRequest } = await import('next/server'));
});

after(async () => {
  await fake?.close();
});

/** Run the real cron handler and parse its JSON body. */
async function runCron(): Promise<Record<string, unknown>> {
  const res = await GET(new NextRequest('http://localhost/api/cron/update-rate'));
  return (await res.json()) as Record<string, unknown>;
}

/** Seed the (singleton) memory store with a starting price + one active alert. */
async function seedStore(bid: number, ask: number) {
  const store = await getStoreOrMemory();
  await store.wipe?.({ history: true, alerts: true });
  await store.record({ bid, ask }, Date.now());
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/update-rate', () => {
  it('fires the Telegram alert on the same run that detects the move', async () => {
    calls = [];
    setReplies([{ status: 200, body: { ok: true, result: { message_id: 9 } } }]);
    await seedStore(4050, 4058);
    currentQuote = { bid: 4055, ask: 4063, rate: 4055, fetchedAt: new Date().toISOString() };

    const json = await runCron();

    assert.equal(json.success, true);
    assert.equal(json.moved, true);
    assert.equal(json.matched, 1);
    assert.equal(json.notified, 1, 'the alert must be delivered by the same cron run');
    assert.equal(json.failed, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.chat_id, '123');
    assert.match(String(calls[0].body.text), /4,055/);
  });

  it('still delivers when Telegram rate-limits the first attempt', async () => {
    calls = [];
    setReplies([
      {
        status: 429,
        body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } },
      },
      { status: 200, body: { ok: true, result: { message_id: 10 } } },
    ]);
    await seedStore(4055, 4063);
    currentQuote = { bid: 4060, ask: 4068, rate: 4060, fetchedAt: new Date().toISOString() };

    const json = await runCron();

    assert.equal(calls.length, 2, 'expected a retry after the 429');
    assert.equal(json.notified, 1);
    assert.equal(json.failed, 0);
  });

  it('reports an undeliverable alert instead of dropping it silently', async () => {
    calls = [];
    setReplies([{ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }]);
    await seedStore(4060, 4068);
    currentQuote = { bid: 4070, ask: 4078, rate: 4070, fetchedAt: new Date().toISOString() };

    const json = await runCron();

    assert.equal(json.matched, 1);
    assert.equal(json.notified, 0);
    assert.equal(json.failed, 1);
    assert.match(String(json.alertError), /401/);
    assert.ok(Array.isArray(json.warnings) && (json.warnings as string[]).some((w) => /failed to deliver/.test(w)));
  });

  it('explains a quiet run as "no-move" when the price is unchanged', async () => {
    calls = [];
    setReplies([{ status: 200, body: { ok: true, result: { message_id: 11 } } }]);
    await seedStore(4070, 4078);
    currentQuote = { bid: 4070, ask: 4078, rate: 4070, fetchedAt: new Date().toISOString() };

    const json = await runCron();

    assert.equal(json.moved, false);
    assert.equal(json.reason, 'no-move');
    assert.equal(calls.length, 0);
  });

  it('explains a quiet run as "no-alerts" when nothing is subscribed', async () => {
    calls = [];
    setReplies([{ status: 200, body: { ok: true, result: { message_id: 12 } } }]);
    const store = await getStoreOrMemory();
    await store.wipe?.({ history: true, alerts: true });
    await store.record({ bid: 4070, ask: 4078 }, Date.now());
    currentQuote = { bid: 4080, ask: 4088, rate: 4080, fetchedAt: new Date().toISOString() };

    const json = await runCron();

    assert.equal(json.moved, true, 'the price did move…');
    assert.equal(json.reason, 'no-alerts', '…but there is nobody to tell');
    assert.equal(json.notified, 0);
    assert.ok((json.warnings as string[]).some((w) => /no active alert/.test(w)));
  });

  it('warns when the store cannot persist (the silent-failure case on Vercel)', async () => {
    await seedStore(4080, 4088);
    currentQuote = { bid: 4085, ask: 4093, rate: 4085, fetchedAt: new Date().toISOString() };

    const json = await runCron();

    assert.equal(json.persistent, false);
    assert.ok(
      (json.warnings as string[]).some((w) => /does not persist between serverless invocations/.test(w)),
      'the operator must be told alerts cannot fire without a database',
    );
  });
});
