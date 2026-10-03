import { NextRequest, NextResponse } from 'next/server';
import { linkBackup, specificationFromBody, syncDatabases, testLink, unlinkBackup, updateLinkOptions } from '@/lib/db-actions';
import { adminSecret, authorized, forbiddenReason, linkJson } from '@/lib/db-http';
import { storeStatus } from '@/lib/store';
import { redactError } from '@/lib/store/env';
import { summarizeTransfer } from '@/lib/store/transfer';
import { errMsg, type LinkOptions } from '@/lib/store/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The backup database endpoint — tiny and safe to poll.
 *
 *   GET    /api/database/link            → link health: which side is serving,
 *                                          rows/latency on each, sync state
 *   GET    /api/database/link?fresh=1    → same, forcing a real re-check
 *   POST   /api/database/link  {kind,url,token, mirror?, autoFailover?, …}
 *                                        → link/attach a backup database
 *   POST   /api/database/link  {"action":"sync","target":"auto"}
 *                                        → copy data between the two databases
 *   DELETE /api/database/link            → unlink (neither database is changed)
 *
 * Reads need no secret (they contain no credentials); writes require
 * `x-admin-secret` / Bearer, exactly like /api/database.
 */
const forbidden = () => NextResponse.json({ ok: false, error: forbiddenReason() }, { status: 403 });

export async function GET(req: NextRequest) {
  const fresh = ['1', 'true', 'yes', 'force'].includes((req.nextUrl.searchParams.get('fresh') ?? '').toLowerCase());
  const status = fresh ? await testLink() : (await storeStatus()).link;

  if (!status) {
    return NextResponse.json(
      {
        ok: true,
        linked: false,
        note:
          'No backup database is linked. Add one with POST /api/database/link {"kind":"postgres","url":"postgresql://…"}, ' +
          'set DB_BACKUP_JSON, or use BACKUP_* / SECONDARY_* env vars.',
        writable: Boolean(adminSecret()),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    { ok: true, ...linkJson(status), writable: Boolean(adminSecret()) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return forbidden();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? '').trim().toLowerCase();

    if (action === 'sync' || action === 'copy' || action === 'reconcile') {
      const outcome = await syncDatabases(
        {
          target: (String(body.target ?? body.direction ?? 'auto').toLowerCase() as 'auto' | 'toBackup' | 'fromBackup' | 'both') ?? 'auto',
          mode: body.mode === 'replace' ? 'replace' : 'merge',
          dryRun: Boolean(body.dryRun),
        },
        { by: 'api' },
      );
      return NextResponse.json(
        {
          ok: outcome.ok,
          summary: outcome.summary,
          error: outcome.error ? redactError(outcome.error) : null,
          results: outcome.results.map((r) => ({ ...r, error: r.error ? redactError(r.error) : undefined })),
          ...linkJson(outcome.status),
        },
        { status: outcome.ok ? 200 : 400 },
      );
    }

    if (action === 'options') {
      const outcome = await updateLinkOptions(body.options ?? body, 'api');
      if (!outcome.ok) return NextResponse.json({ ok: false, error: outcome.error }, { status: 400 });
      return NextResponse.json({
        ok: true,
        options: outcome.options,
        persisted: outcome.save?.persisted ?? false,
        warning: outcome.save?.warning,
        ...linkJson(outcome.status ?? null),
      });
    }

    const raw = (body.backup && typeof body.backup === 'object' ? body.backup : body) as Record<string, unknown>;
    const parsed = specificationFromBody(raw);
    if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

    const outcome = await linkBackup(parsed.spec, {
      by: 'api',
      source: 'dashboard',
      options: (body.options ?? body) as Partial<LinkOptions>,
      syncNow: body.syncNow === false || body.sync === false ? false : true,
    });
    if (!outcome.ok) return NextResponse.json({ ok: false, error: redactError(outcome.error ?? 'connection failed') }, { status: 400 });

    return NextResponse.json({
      ok: true,
      label: outcome.label,
      options: outcome.options,
      ms: outcome.ms,
      sync: outcome.sync ? { ok: outcome.sync.ok, summary: summarizeTransfer(outcome.sync), error: outcome.sync.error ?? null } : null,
      persisted: outcome.save.persisted,
      configPath: outcome.save.path,
      warning: outcome.save.warning,
      ...linkJson(outcome.status),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: redactError(errMsg(e)) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  // Reads are public, but unlinking changes how the app stores data — it needs
  // the admin secret like every other write.
  if (!authorized(req)) return forbidden();
  const { save, status } = await unlinkBackup('api');
  return NextResponse.json({
    ok: true,
    linked: false,
    label: status.activeLabel,
    kind: status.activeKind,
    persisted: save.persisted,
    configPath: save.path,
    warning: save.warning,
  });
}
