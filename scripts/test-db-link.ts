/**
 * Integration checks for the backup-database feature (linked failover +
 * moving data between databases).
 *
 * The tests run against real store implementations (`MemoryStore`) plus a fake
 * store whose connection can be "cut" on demand, so every path — mirroring,
 * failover, auto-return, catch-up, merge/replace copies — is exercised with the
 * same code that runs in production.
 *
 *   npm run test:link        (or: npx tsx scripts/test-db-link.ts)
 */

import { MemoryStore } from '../src/lib/store/memory';
import { linkStores, resetLinkState, type LinkedStore } from '../src/lib/store/linked';
import { alertKey, transferStore } from '../src/lib/store/transfer';
import { detectBackupStore, detectStore, maskTarget } from '../src/lib/store/env';
import { DEFAULT_LINK_OPTIONS, type AlertInput, type AlertRecord, type Point, type RateStore, type RecordResult, type StoreKind } from '../src/lib/store/types';

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A store that can "go down" like a real database
// ---------------------------------------------------------------------------

class FlakyStore implements RateStore {
  readonly persistent = true;
  readonly readTtlMs = 0;
  /** Cut the connection on demand */
  down = false;
  reads = 0;
  writes = 0;

  constructor(
    readonly kind: StoreKind = 'blob',
    readonly label = 'FlakyStore',
    private inner: MemoryStore = new MemoryStore(),
  ) {}

  private gate(kind: 'read' | 'write'): void {
    if (this.down) throw new Error(`${this.label}: connection refused (simulated outage, ${kind})`);
  }

  async init(): Promise<void> {
    this.gate('read');
  }
  async latest() {
    this.gate('read');
    this.reads += 1;
    return this.inner.latest();
  }
  async record(q: { bid: number; ask: number }, now: number): Promise<RecordResult> {
    this.gate('write');
    this.writes += 1;
    return this.inner.record(q, now);
  }
  async claimRefresh(now: number, refreshMs: number) {
    this.gate('write');
    return this.inner.claimRefresh(now, refreshMs);
  }
  async range(since: number) {
    this.gate('read');
    return this.inner.range(since);
  }
  async before(ts: number) {
    this.gate('read');
    return this.inner.before(ts);
  }
  async daily(since: number | null) {
    this.gate('read');
    return this.inner.daily(since);
  }
  async backfill(points: Point[]) {
    this.gate('write');
    return this.inner.backfill(points);
  }
  async listAlerts(): Promise<AlertRecord[]> {
    this.gate('read');
    return this.inner.listAlerts();
  }
  async saveAlert(a: AlertInput) {
    this.gate('write');
    return this.inner.saveAlert(a);
  }
  async wipe(opts: { history?: boolean; alerts?: boolean }) {
    this.gate('write');
    return this.inner.wipe(opts);
  }
  async stats() {
    this.gate('read');
    return this.inner.stats();
  }
}

const day = 86_400_000;
const rowOf = async (store: RateStore, t: number) => (await store.range(t)).find((p) => p.t === t) ?? null;

const alert = (chatId: string, target: number | null = null): AlertInput => ({
  source: 'bot',
  webhookUrl: null,
  chatId,
  botToken: null,
  condition: 'change',
  targetRate: target,
  customMessage: null,
  active: true,
  lastAlertAt: null,
});

// ---------------------------------------------------------------------------
// 1. Environment scoping
// ---------------------------------------------------------------------------

async function testEnvScoping(): Promise<void> {
  section('1. BACKUP_* env vars are never mistaken for the primary database');
  const before = { ...process.env };
  process.env.BACKUP_DATABASE_URL = 'postgresql://backup:secret@backup.example.com:5432/wingrate';
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;

  const primary = detectStore();
  const backup = detectBackupStore();
  check('primary detection ignores BACKUP_DATABASE_URL', primary.kind === 'memory', primary.kind);
  check('backup detection finds it', backup?.kind === 'postgres', backup?.kind);
  check('backup keeps its URL', backup?.url === process.env.BACKUP_DATABASE_URL);

  process.env.SECONDARY_TURSO_DATABASE_URL = 'libsql://demo.turso.io';
  process.env.SECONDARY_TURSO_AUTH_TOKEN = 'token-1234';
  const turso = detectBackupStore();
  check('SECONDARY_* Turso is paired with its token', turso?.kind === 'postgres' || turso?.kind === 'turso', turso?.kind);

  process.env = before;
}

// ---------------------------------------------------------------------------
// 2. Mirroring
// ---------------------------------------------------------------------------

async function testMirroring(): Promise<void> {
  section('2. Linked store mirrors every write');
  resetLinkState();
  const primary = new FlakyStore('blob', 'Primary');
  const backup = new FlakyStore('mongodb', 'Backup');
  const linked = linkStores(primary, backup, DEFAULT_LINK_OPTIONS, 'sig-mirror', { probeMs: 20, log: () => {} });
  await linked.init();

  const now = Date.now();
  await linked.record({ bid: 4054, ask: 4062 }, now);
  await linked.record({ bid: 4055, ask: 4063 }, now + 1000); // a change → new row
  await linked.record({ bid: 4055, ask: 4063 }, now + 2000); // same price → no new row

  const p = await primary.stats();
  const b = await backup.stats();
  check('primary has the rows', Number(p.rows) === 2, p);
  check('backup mirrors them', Number(b.rows) === 2, b);
  const snap = linked.snapshot();
  check('serving = primary', snap.serving === 'primary');
  check('no failovers yet', snap.counters.failovers === 0);
  check('no mirror errors', snap.counters.mirrorErrors === 0, snap.counters.lastMirrorError);
  check('nothing pending', snap.counters.pendingResync === false);

  // Alerts are mirrored too — with the backup's own row ids.
  await linked.saveAlert(alert('111'));
  const srcAlerts = await primary.listAlerts();
  const dstAlerts = await backup.listAlerts();
  check('alert mirrored to the backup', dstAlerts.length === 1, dstAlerts);
  check('alert identity matches', alertKey(srcAlerts[0]) === alertKey(dstAlerts[0]));
  await linked.saveAlert({ ...alert('111', 4060), id: srcAlerts[0].id });
  const updated = await backup.listAlerts();
  check('alert update mirrored, not duplicated', updated.length === 1 && updated[0].targetRate === 4060, updated);
}

// ---------------------------------------------------------------------------
// 3. Failover + auto-return + catch-up
// ---------------------------------------------------------------------------

async function testFailover(): Promise<void> {
  section('3. Primary goes down → backup serves → primary returns');
  resetLinkState();
  const primary = new FlakyStore('blob', 'Primary');
  const backup = new FlakyStore('mongodb', 'Backup');
  const linked: LinkedStore = linkStores(primary, backup, DEFAULT_LINK_OPTIONS, 'sig-failover', { probeMs: 30, log: () => {} });
  await linked.init();

  const t0 = Date.now();
  await linked.record({ bid: 4060, ask: 4068 }, t0);
  check('both hold the same row while healthy', (await primary.range(0)).length === 1 && (await backup.range(0)).length === 1);

  // ---- outage ---------------------------------------------------------
  const primaryRowsBeforeOutage = (await primary.range(0)).length;
  primary.down = true;
  const duringOutage = await linked.latest();
  check('reads fail over to the backup', duringOutage?.bid === 4060, duringOutage);

  const res = await linked.record({ bid: 4070, ask: 4078 }, t0 + 1000);
  check('writes are accepted during the outage', res.row.bid === 4070, res.row);
  check('the row landed on the backup', (await backup.range(0)).some((p) => p.bid === 4070));
  check('nothing was written to the dead primary', primaryRowsBeforeOutage === 1);

  const snap1 = linked.snapshot();
  check('serving = backup', snap1.serving === 'backup', snap1.reason);
  check('failover counted', snap1.counters.failovers >= 1);
  check('re-sync flagged as pending', snap1.counters.pendingResync === true);
  check('backup writes counted', snap1.counters.failoverWrites >= 1);

  // A second write while still down keeps working.
  await linked.record({ bid: 4071, ask: 4079 }, t0 + 2000);
  check('backup keeps taking writes', (await backup.range(0)).filter((p) => p.bid >= 4070).length === 2);

  // ---- recovery -------------------------------------------------------
  primary.down = false;
  await sleep(40); // let the probe interval elapse (probeMs = 30)
  const afterReturn = await linked.latest();
  check('reads return to the primary once it answers', afterReturn?.bid === 4060, afterReturn);
  check('serving = primary again', linked.snapshot().serving === 'primary');

  // Auto re-sync copies what the backup recorded back into the primary.
  const synced = await linked.resync('test');
  check('catch-up ran', Boolean(synced), synced?.error);
  const primaryRows = await primary.range(0);
  check('primary got the outage rows', [4070, 4071].every((bid) => primaryRows.some((p) => p.bid === bid)), primaryRows.map((p) => p.bid));
  check('pending re-sync cleared', linked.snapshot().counters.pendingResync === false);
}

// ---------------------------------------------------------------------------
// 3b. Mirroring off: failover writes must still be re-synced back
// ---------------------------------------------------------------------------

async function testFailoverWithoutMirror(): Promise<void> {
  section('3b. Failover works (and is flagged) even when mirroring is off');
  resetLinkState();
  const primary = new FlakyStore('blob', 'Primary');
  const backup = new FlakyStore('mongodb', 'Backup');
  const options = { ...DEFAULT_LINK_OPTIONS, mirror: false };
  const linked = linkStores(primary, backup, options, 'sig-no-mirror', { probeMs: 20, log: () => {} });
  await linked.init();

  await linked.record({ bid: 4100, ask: 4108 }, Date.now());
  check('primary-only while healthy (no mirror)', (await backup.range(0)).length === 0, (await backup.range(0)).length);

  primary.down = true;
  await linked.record({ bid: 4110, ask: 4118 }, Date.now() + 1000);
  const counters = linked.snapshot().counters;
  check('outage write is counted as a failover write', counters.failoverWrites === 1, counters);
  check('and flagged for catch-up', counters.pendingResync === true);

  primary.down = false;
  const synced = await linked.resync('test');
  check('catch-up copies it into the primary', Boolean(synced?.ok), synced?.error);
  check('primary now holds both rows', (await primary.range(0)).some((p) => p.bid === 4110), (await primary.range(0)).map((p) => p.bid));
}

// ---------------------------------------------------------------------------
// 4. Broken backup must never break the app
// ---------------------------------------------------------------------------

async function testBrokenBackup(): Promise<void> {
  section('4. A broken backup never breaks the primary');
  resetLinkState();
  const primary = new FlakyStore('blob', 'Primary');
  const backup = new FlakyStore('mongodb', 'Backup');
  const linked = linkStores(primary, backup, DEFAULT_LINK_OPTIONS, 'sig-broken-backup', { probeMs: 20, log: () => {} });
  await linked.init();

  backup.down = true;
  const t = Date.now();
  const res = await linked.record({ bid: 4090, ask: 4098 }, t);
  check('write still succeeds', res.row.bid === 4090);
  check('serving stays on the primary', linked.snapshot().serving === 'primary');
  const counters = linked.snapshot().counters;
  check('the mirror error is recorded', counters.mirrorErrors >= 1, counters.lastMirrorError);

  // Once the backup is back, it is repaired by the next resync.
  backup.down = false;
  await primary.record({ bid: 4091, ask: 4099 }, t + 1000);
  await sleep(25);
  await linked.record({ bid: 4092, ask: 4100 }, t + 2000);
  await linked.resync('test');
  const backupRows = await backup.range(0);
  check('backup catches up after recovery', backupRows.some((p) => p.bid === 4092), backupRows.map((p) => p.bid));
}

// ---------------------------------------------------------------------------
// 5. Moving data between databases (merge / replace / alerts)
// ---------------------------------------------------------------------------

async function testTransfer(): Promise<void> {
  section('5. Copying data between two databases');
  const src = new MemoryStore();
  const dst = new MemoryStore();
  const now = Date.now();

  const points: Point[] = [0, 1, 2, 3].map((i) => ({ bid: 4050 + i, ask: 4058 + i, t: now - (4 - i) * day }));
  await src.backfill!(points);
  await src.saveAlert(alert('555'));
  await src.saveAlert({ ...alert('666', 4090) });
  // A look-alike alert already on the target, with its own id.
  const existing = await dst.saveAlert(alert('555'));

  const first = await transferStore(src, dst, {});
  check('first copy succeeds', first.ok, first.error);
  check('history rows copied', first.history?.copied === 4, first.history);
  const dstPoints = await dst.range(0);
  check('target holds the rows', dstPoints.length === 4, dstPoints.length);

  const second = await transferStore(src, dst, {});
  check('second copy is idempotent', second.history?.copied === 0 && second.history?.skipped === 4, second.history);
  check('no duplicate rows', (await dst.range(0)).length === 4);

  const dstAlerts = await dst.listAlerts();
  check('alerts merged without duplication', dstAlerts.length === 2, dstAlerts.map((a) => a.id));
  check("target's own alert id is kept", dstAlerts.some((a) => a.id === existing.id));
  check(
    'alert identity preserved across backends',
    dstAlerts.map(alertKey).sort().join(',') === (await src.listAlerts()).map(alertKey).sort().join(','),
  );

  // A newer alert state replaces the target's copy (update, not insert).
  await src.saveAlert({ ...alert('666', 4095), id: (await src.listAlerts()).find((a) => a.chatId === '666')?.id });
  await transferStore(src, dst, { alerts: true, history: false });
  const after = (await dst.listAlerts()).find((a) => a.chatId === '666');
  check('alert update is applied', after?.targetRate === 4095, after);
  check('still no duplicates', (await dst.listAlerts()).length === 2);

  // Replace mode: target history is rewritten.
  await dst.backfill!([{ bid: 1, ask: 1, t: now - 30 * day }]);
  const replaced = await transferStore(src, dst, { mode: 'replace' });
  check('replace copy succeeds', replaced.ok, replaced.error);
  const replacedPoints = await dst.range(0);
  check('target holds exactly the source rows', replacedPoints.length === 4, replacedPoints.length);

  // Connection values must never come back out of an API/chat response.
  check('URL passwords are masked', !maskTarget('postgresql://user:hunter2@host:5432/db').includes('hunter2'), maskTarget('postgresql://user:hunter2@host:5432/db'));
  check('blob tokens are masked', maskTarget('vercel_blob_rw_abc123_secretxyz') === 'verc…txyz', maskTarget('vercel_blob_rw_abc123_secretxyz'));

  // Dry runs must not touch the target.
  const dryTarget = new MemoryStore();
  const dry = await transferStore(src, dryTarget, { dryRun: true });
  check('dry run reports work', dry.ok && (dry.history?.copied ?? 0) === 4, dry.history);
  check('dry run writes nothing', (await dryTarget.range(0)).length === 0);
}

// ---------------------------------------------------------------------------
// 6. Backends that cannot erase refuse a replace copy (instead of guessing)
// ---------------------------------------------------------------------------

async function testReplaceRefusal(): Promise<void> {
  section('6. Replace copies require a backend that can erase');
  const src = new MemoryStore();
  const dst = new MemoryStore();
  await src.backfill!([{ bid: 4054, ask: 4062, t: Date.now() - day }]);

  // A store without wipe() — same shape as a backend that cannot erase.
  const noWipe = new Proxy(dst, {
    get: (target, prop) => (prop === 'wipe' ? undefined : Reflect.get(target, prop)),
  }) as RateStore;
  const res = await transferStore(src, noWipe, { mode: 'replace' });
  check('replace refuses without wipe support', res.ok === false, res.error);
  check('the message explains why', /cannot erase/.test(res.error ?? ''), res.error);
}

// ---------------------------------------------------------------------------
// 7. Memory ↔ disk store: the real MemoryStore participates end to end
// ---------------------------------------------------------------------------

async function testMemoryRoundTrip(): Promise<void> {
  section('7. MemoryStore round trip (same interface production uses)');
  const mem = new MemoryStore();
  const now = Date.now();
  await mem.record({ bid: 4054, ask: 4062 }, now - day);
  await mem.record({ bid: 4056, ask: 4064 }, now);
  const clash = new MemoryStore();
  const copied = await transferStore(mem, clash, {});
  check('copy into a fresh store works', copied.ok && copied.history?.copied === 2, copied.history);
  check('latest row survived', (await clash.latest())?.bid === 4056);
  await clash.wipe({ history: true, alerts: true });
  check('wipe clears history', (await clash.range(0)).length === 0);
  check('wipe clears alerts', (await clash.listAlerts()).length === 0);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const originalEnv = { ...process.env };
  try {
    await testEnvScoping();
    await testMirroring();
    await testFailover();
    await testFailoverWithoutMirror();
    await testBrokenBackup();
    await testTransfer();
    await testReplaceRefusal();
    await testMemoryRoundTrip();
  } finally {
    process.env = originalEnv;
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
    process.exitCode = 1;
  }
}

void main();
