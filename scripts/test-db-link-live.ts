/**
 * Live end-to-end check of the linked backup feature — no mocks in the storage
 * layer: two real `BlobStore`s talk HTTP to `scripts/fake-blob-server.mjs`
 * (which stands in for Vercel Blob), and the *production* wiring is used
 * (`@/lib/store` factory, env-var detection, failover store, maintenance job).
 *
 *   node scripts/fake-blob-server.mjs &
 *   npm run test:link:live
 *
 * It proves, through real network calls:
 *   1. both databases are detected from env vars (BLOB_READ_WRITE_TOKEN +
 *      BACKUP_BLOB_READ_WRITE_TOKEN) and joined by `getStore()`;
 *   2. every tick is mirrored into the second database;
 *   3. when the primary host starts answering 503, requests keep succeeding
 *      (served by the backup) and the failure is reported in the status;
 *   4. when the primary comes back, traffic returns to it automatically and the
 *      maintenance job copies the outage rows back into the primary.
 */

import { createHash } from 'node:crypto';
import { getStore, linkStatus, resetStore, storeStatus } from '@/lib/store';
import { runLinkMaintenance } from '@/lib/link-jobs';

const BASE = process.env.FAKE_BLOB_URL ?? 'http://127.0.0.1:4321';
const PRIMARY_TOKEN = 'vercel_blob_rw_primary_aaaaaaa1';
const BACKUP_TOKEN = 'vercel_blob_rw_backup_bbbbbbb2';
const pathname = (token: string) => `wingrate/data-${createHash('sha256').update(token).digest('hex').slice(0, 24)}.json`;

let passed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
  }
};

const control = async (down: string[], reset = false) => {
  const res = await fetch(`${BASE}/_control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ down, reset }),
  });
  return (await res.json()) as { down: string[] };
};

const snapshot = async () => {
  const res = await fetch(`${BASE}/_control`);
  return (await res.json()) as { pathnames: string[]; rows: Record<string, number> };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // ---- production configuration, exactly as a deployment would set it -----
  process.env.BLOB_READ_WRITE_TOKEN = PRIMARY_TOKEN;
  process.env.BACKUP_BLOB_READ_WRITE_TOKEN = BACKUP_TOKEN;
  process.env.VERCEL_BLOB_READ_URL = `${BASE}/read`;
  process.env.VERCEL_BLOB_API_URL = `${BASE}/api/blob`;
  process.env.DB_CONFIG_FILE = '/tmp/wingrate-live-test-config.json';
  process.env.LINK_PROBE_SECONDS = '5';
  process.env.LINK_STATUS_TTL_MS = '0';
  delete process.env.DATABASE_URL;
  delete process.env.STORAGE;

  const primaryPath = pathname(PRIMARY_TOKEN);
  const backupPath = pathname(BACKUP_TOKEN);
  await control([], true); // start from empty databases

  console.log('\n1. Status before linking (env-only configuration)');
  const status0 = await storeStatus();
  check('primary detected from BLOB_READ_WRITE_TOKEN', status0.configuredKind === 'blob', status0.configuredKind);
  check('link detected from BACKUP_BLOB_READ_WRITE_TOKEN', status0.link?.linked === true, status0.link);
  check('serving = primary', status0.link?.serving === 'primary', status0.link?.serving);

  console.log('\n2. Writes are mirrored into the second database');
  const store = await getStore();
  const t0 = Date.now();
  await store.record({ bid: 4054, ask: 4062 }, t0);
  await store.record({ bid: 4056, ask: 4064 }, t0 + 1000); // price moved → new row
  await store.saveAlert({
    source: 'bot', webhookUrl: null, chatId: '999', botToken: null, condition: 'change', targetRate: null,
    customMessage: null, active: true, lastAlertAt: null,
  });
  let snap = await snapshot();
  check('primary holds 2 rows', snap.rows[primaryPath] === 2, snap.rows);
  check('backup holds the mirrored 2 rows', snap.rows[backupPath] === 2, snap.rows);

  console.log('\n3. Primary host goes down → the backup serves the app');
  await control([primaryPath]);
  const duringOutage = await store.record({ bid: 4070, ask: 4078 }, t0 + 2000);
  check('write succeeded during the outage', duringOutage.row.bid === 4070, duringOutage.row);
  const latest = await store.latest();
  check('reads are served by the backup', latest?.bid === 4070, latest);

  const link = await linkStatus({ fresh: true });
  check('status reports the failover', link?.serving === 'backup', link?.serving);
  check('primary shown as unreachable', link?.primary.reachable === false, link?.primary.reachable);
  check('backup shown as reachable', link?.backup.reachable === true);
  check('failover counted', (link?.counters.failovers ?? 0) >= 1, link?.counters.failovers);
  check('re-sync pending', link?.counters.pendingResync === true);
  check('drift is unknown while the primary is unreachable', link?.drift.inSync === null, link?.drift);
  check('drift explains the pending rows', /holding rows/.test(link?.drift.note ?? ''), link?.drift.note);

  snap = await snapshot();
  check('the outage row exists only in the backup', (snap.rows[backupPath] ?? 0) === 3 && (snap.rows[primaryPath] ?? 0) === 2, snap.rows);

  console.log('\n4. Primary recovers → automatic return + catch-up');
  await control([]); // the primary host is healthy again
  await sleep(6_000); // one probe interval (LINK_PROBE_SECONDS=5)
  await store.latest(); // this request notices the primary is back and returns to it
  const returned = await linkStatus({ fresh: false });
  check('serving returns to the primary automatically', returned?.serving === 'primary', returned?.serving);

  // The failover rows are copied back in the background (bounded window).
  let pending = (await linkStatus())?.counters.pendingResync ?? false;
  for (let i = 0; i < 20 && pending; i++) {
    await sleep(250);
    pending = (await linkStatus())?.counters.pendingResync ?? false;
  }
  check('re-sync finished automatically', pending === false);
  snap = await snapshot();
  check('primary now holds all 3 rows', snap.rows[primaryPath] === 3, snap.rows);
  check('backup still holds all 3 rows', snap.rows[backupPath] === 3, snap.rows);

  const job = await runLinkMaintenance();
  check('maintenance job finds nothing left to do', job.ran === false && job.reason === 'already in sync', job);

  const finalLink = await linkStatus({ fresh: true });
  check('no pending re-sync left', finalLink?.counters.pendingResync === false);
  check('both sides in sync', finalLink?.drift.inSync === true, finalLink?.drift);

  console.log('\n5. Status surfaces (what /api/database and /api/status return)');
  const finalStatus = await storeStatus();
  check('store label mentions both databases', Boolean(finalStatus.activeLabel.includes('⇄')), finalStatus.activeLabel);
  check('link options carry the defaults', finalStatus.link?.options.mirror === true && finalStatus.link?.options.autoReturn === true);
  check('backup target is masked', !(finalStatus.link?.backup.target ?? '').includes('vercel_blob_rw'), finalStatus.link?.backup.target);

  resetStore();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
    process.exitCode = 1;
  }
}

void main();
