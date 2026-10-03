import { NextRequest, NextResponse } from 'next/server';
import {
  connectDatabase,
  disconnectDatabase,
  linkBackup,
  promoteBackup,
  specificationFromBody,
  syncDatabases,
  unlinkBackup,
  updateLinkOptions,
  type SyncTarget,
} from '@/lib/db-actions';
import { linkJson, adminSecret, authorized, forbiddenReason } from '@/lib/db-http';
import { storeStatus } from '@/lib/store';
import { redactError } from '@/lib/store/env';
import { summarizeTransfer } from '@/lib/store/transfer';
import { errMsg, type LinkOptions } from '@/lib/store/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Database management over HTTP — the same operations as the Telegram 🗄 menu.
 *
 *   GET    /api/database              → current database + linked backup & failover state
 *   POST   /api/database  {kind,url,token}        → connect & switch (probe first)
 *          /api/database  {action:"link", backup:{kind,url,token}, options?, syncNow?}
 *                                                        → link a 2nd database as a live backup
 *          /api/database  {action:"unlink"}                      → remove the link
 *          /api/database  {action:"sync", target?, from?, to?, mode?, dryRun?}
 *                                                        → copy history/alerts between databases
 *          /api/database  {action:"promote"}                     → make the backup the primary
 *          /api/database  {action:"options", mirror?, autoFailover?, autoReturn?, autoResync?}
 *   DELETE /api/database[?mode=memory|auto]   → disconnect
 *          /api/database?link=1               → unlink the backup
 *
 * Writes require `x-admin-secret: <ADMIN_SECRET|CRON_SECRET>` (or an
 * `Authorization: Bearer <secret>` header). Without either env var set, write
 * access is disabled and the Telegram menu remains the only way to change the
 * database — an unauthenticated endpoint that re-points the whole app's
 * storage would be a remote takeover.
 */
const forbidden = () => NextResponse.json({ ok: false, error: forbiddenReason() }, { status: 403 });

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** "to"/"push"/"backup" → toBackup, "from"/"pull"/"restore" → fromBackup, … */
function syncTarget(raw: unknown): SyncTarget {
  const s = str(raw).toLowerCase();
  if (['to', 'tobackup', 'backup', 'push', 'copy', 'out'].includes(s)) return 'toBackup';
  if (['from', 'frombackup', 'restore', 'pull', 'in'].includes(s)) return 'fromBackup';
  if (['both', 'reconcile', 'merge', 'sync'].includes(s)) return 'both';
  return 'auto';
}

/** Current database + how it was chosen (never returns passwords or tokens). */
export async function GET() {
  const s = await storeStatus();
  return NextResponse.json(
    {
      ok: true,
      mode: s.choice.mode,
      source: s.source,
      kind: s.configuredKind,
      label: s.configuredLabel,
      activeKind: s.activeKind,
      activeLabel: s.activeLabel,
      reachable: s.reachable,
      ms: s.ms,
      persistent: s.persistent,
      stats: s.stats,
      error: s.error ? redactError(s.error) : null,
      configPath: s.configPath,
      configWarning: s.configWarning,
      detected: s.detected.map((d) => ({ kind: d.kind, label: d.label, envVars: d.envVars })),
      link: linkJson(s.link),
      writable: Boolean(adminSecret()),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** One entry point for every write action; the body says which one. */
async function applyBody(req: NextRequest, mode: 'auto' | 'memory' | null) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = str(body.action).toLowerCase();
  const effectiveMode = mode ?? (typeof body.mode === 'string' ? (body.mode.trim().toLowerCase() as 'auto' | 'memory') : null);

  // ---- backup database actions ------------------------------------------
  if (action === 'link' || action === 'link-backup' || action === 'backup') {
    const raw = (body.backup && typeof body.backup === 'object' ? body.backup : body) as Record<string, unknown>;
    const parsed = specificationFromBody(raw);
    if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

    const outcome = await linkBackup(parsed.spec, {
      by: 'api',
      source: 'dashboard',
      options: (body.options ?? body) as Partial<LinkOptions>,
      syncNow: body.syncNow === false || body.sync === false ? false : true,
    });
    if (!outcome.ok) return NextResponse.json({ ok: false, error: redactError(outcome.error ?? 'connection failed'), ms: outcome.ms }, { status: 400 });

    return NextResponse.json({
      ok: true,
      label: outcome.label,
      options: outcome.options,
      ms: outcome.ms,
      sync: outcome.sync ? { ok: outcome.sync.ok, summary: summarizeTransfer(outcome.sync), error: outcome.sync.error ?? null, counts: { history: outcome.sync.history, alerts: outcome.sync.alerts } } : null,
      persisted: outcome.save.persisted,
      configPath: outcome.save.path,
      warning: outcome.save.warning,
      link: linkJson(outcome.status),
    });
  }

  if (action === 'unlink' || action === 'unlink-backup') {
    const { save, status } = await unlinkBackup('api');
    return NextResponse.json({
      ok: true,
      mode: 'unlinked',
      label: status.activeLabel,
      kind: status.activeKind,
      persisted: save.persisted,
      configPath: save.path,
      warning: save.warning,
      link: null,
    });
  }

  if (action === 'sync' || action === 'copy' || action === 'migrate') {
    const from = body.from && typeof body.from === 'object' ? specificationFromBody(body.from as Record<string, unknown>) : null;
    const to = body.to && typeof body.to === 'object' ? specificationFromBody(body.to as Record<string, unknown>) : null;
    if (from && !from.ok) return NextResponse.json({ ok: false, error: `"from": ${from.error}` }, { status: 400 });
    if (to && !to.ok) return NextResponse.json({ ok: false, error: `"to": ${to.error}` }, { status: 400 });

    const outcome = await syncDatabases(
      {
        target: syncTarget(body.target ?? body.direction),
        from: from?.ok ? from.spec : undefined,
        to: to?.ok ? to.spec : undefined,
        mode: body.mode === 'replace' ? 'replace' : 'merge',
        dryRun: Boolean(body.dryRun),
        history: body.history === false ? false : undefined,
        alerts: body.alerts === false ? false : undefined,
        since: num(body.since) ?? (body.since === null ? null : undefined),
        limit: num(body.limit),
      },
      { by: 'api' },
    );

    return NextResponse.json(
      {
        ok: outcome.ok,
        target: outcome.target,
        summary: outcome.summary,
        error: outcome.error ? redactError(outcome.error) : null,
        results: outcome.results.map((r) => ({ ...r, error: r.error ? redactError(r.error) : undefined })),
        link: linkJson(outcome.status),
      },
      { status: outcome.ok ? 200 : 400 },
    );
  }

  if (action === 'promote' || action === 'swap' || action === 'failback') {
    const outcome = await promoteBackup({ by: 'api', source: 'dashboard', syncNow: body.syncNow !== false });
    if (!outcome.ok) return NextResponse.json({ ok: false, error: redactError(outcome.error ?? 'promote failed') }, { status: 400 });
    return NextResponse.json({
      ok: true,
      label: outcome.label,
      summary: outcome.summary ?? null,
      persisted: outcome.save?.persisted ?? false,
      configPath: outcome.save?.path ?? null,
      warning: outcome.save?.warning,
      link: linkJson(outcome.status ?? null),
    });
  }

  if (action === 'options' || action === 'link-options') {
    const outcome = await updateLinkOptions(body.options ?? body, 'api');
    if (!outcome.ok) return NextResponse.json({ ok: false, error: outcome.error }, { status: 400 });
    return NextResponse.json({
      ok: true,
      options: outcome.options,
      persisted: outcome.save?.persisted ?? false,
      configPath: outcome.save?.path ?? null,
      warning: outcome.save?.warning,
      link: linkJson(outcome.status ?? null),
    });
  }

  // ---- connect / disconnect (unchanged behaviour) -----------------------
  if (effectiveMode === 'auto' || effectiveMode === 'memory') {
    const { status, save } = await disconnectDatabase(effectiveMode, 'api');
    return NextResponse.json({
      ok: true,
      mode: effectiveMode,
      label: status.activeLabel,
      kind: status.activeKind,
      reachable: status.reachable,
      persisted: save.persisted,
      configPath: save.path,
      warning: save.warning,
    });
  }

  const parsed = specificationFromBody(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  const outcome = await connectDatabase(parsed.spec, { by: 'api', source: 'dashboard' });
  if (!outcome.ok) {
    return NextResponse.json({ ok: false, error: redactError(outcome.error ?? 'connection failed'), ms: outcome.ms }, { status: 400 });
  }
  const status = await storeStatus().catch(() => null);
  return NextResponse.json({
    ok: true,
    mode: 'custom',
    kind: parsed.spec.kind,
    label: outcome.label,
    ms: outcome.ms,
    stats: outcome.stats ?? null,
    persisted: outcome.save.persisted,
    configPath: outcome.save.path,
    warning: outcome.save.warning,
    link: linkJson(status?.link ?? null),
  });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return forbidden();
  try {
    return await applyBody(req, null);
  } catch (e) {
    return NextResponse.json({ ok: false, error: redactError(errMsg(e)) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!authorized(req)) return forbidden();
  try {
    const params = req.nextUrl.searchParams;
    const wantLink = ['1', 'true', 'link', 'backup'].includes((params.get('link') ?? params.get('action') ?? '').toLowerCase());
    if (wantLink) {
      const { save, status } = await unlinkBackup('api');
      return NextResponse.json({
        ok: true,
        mode: 'unlinked',
        label: status.activeLabel,
        kind: status.activeKind,
        reachable: status.reachable,
        persisted: save.persisted,
        configPath: save.path,
        warning: save.warning,
        link: null,
      });
    }

    const requested = (params.get('mode') ?? 'memory').toLowerCase();
    const mode = requested === 'auto' ? 'auto' : 'memory';
    const { status, save } = await disconnectDatabase(mode, 'api');
    return NextResponse.json({
      ok: true,
      mode,
      label: status.activeLabel,
      kind: status.activeKind,
      reachable: status.reachable,
      persisted: save.persisted,
      configPath: save.path,
      warning: save.warning,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: redactError(errMsg(e)) }, { status: 500 });
  }
}
