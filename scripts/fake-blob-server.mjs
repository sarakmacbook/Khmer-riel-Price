/**
 * Minimal stand-in for the Vercel Blob REST API, used by
 * `scripts/test-db-link-live.ts` to exercise the linked-backup feature against
 * two *real* HTTP-backed databases without needing cloud credentials.
 *
 * Protocol used by src/lib/store/blob.ts:
 *   GET  <readBase>/<pathname>              → JSON document + etag (404 if new)
 *   PUT  <apiBase>/?pathname=<pathname>     → stores the JSON body, returns {etag}
 *
 * Control endpoint (test-only):
 *   POST /_control {"down":["<substring>", …]}  → those pathnames answer 503,
 *   which is exactly what a database outage looks like to the app.
 *
 * Run: node scripts/fake-blob-server.mjs [port]
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4321);
const docs = new Map(); // pathname -> { doc, etag }
let down = []; // pathname substrings that must fail

const pathnameFor = (token) => `wingrate/data-${createHash('sha256').update(token).digest('hex').slice(0, 24)}.json`;
const isDown = (pathname) => down.some((needle) => pathname.includes(needle));

const body = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

const json = (res, status, payload, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    // ---- test control ----------------------------------------------------
    if (url.pathname === '/_control') {
      if (req.method === 'POST') {
        const parsed = JSON.parse((await body(req)) || '{}');
        down = Array.isArray(parsed.down) ? parsed.down : [];
        // `{"reset":true}` empties every stored document, so a test run starts clean.
        if (parsed.reset) docs.clear();
      }
      return json(res, 200, {
        down,
        // Debug view: tokens the test uses, so it can address one store directly.
        pathnames: [...docs.keys()],
        rows: Object.fromEntries([...docs.entries()].map(([k, v]) => [k, v.doc?.rows?.length ?? 0])),
        alerts: Object.fromEntries([...docs.entries()].map(([k, v]) => [k, v.doc?.alerts?.length ?? 0])),
      });
    }

    if (url.pathname === '/_token') {
      const token = url.searchParams.get('token') ?? '';
      return json(res, 200, { pathname: pathnameFor(token) });
    }

    // ---- read ------------------------------------------------------------
    if (url.pathname.startsWith('/read/')) {
      const pathname = decodeURIComponent(url.pathname.slice('/read/'.length));
      if (isDown(pathname)) return json(res, 503, { error: 'simulated outage' });
      const entry = docs.get(pathname);
      if (!entry) return json(res, 404, { error: 'not found' });
      return json(res, 200, entry.doc, { etag: entry.etag });
    }

    // ---- write -----------------------------------------------------------
    if ((url.pathname === '/api/blob' || url.pathname === '/api/blob/') && req.method === 'PUT') {
      const pathname = url.searchParams.get('pathname') ?? '';
      if (isDown(pathname)) return json(res, 503, { error: 'simulated outage' });
      const entry = docs.get(pathname);
      const ifMatch = req.headers['x-if-match'];
      if (ifMatch && entry && entry.etag !== ifMatch) return json(res, 412, { error: 'conflict' });
      const parsed = JSON.parse((await body(req)) || '{}');
      const etag = `"${Math.random().toString(36).slice(2)}"`;
      docs.set(pathname, { doc: parsed, etag });
      return json(res, 200, { etag, url: `http://127.0.0.1:${port}/read/${pathname}` });
    }

    return json(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`fake blob server on http://0.0.0.0:${port}`);
});
