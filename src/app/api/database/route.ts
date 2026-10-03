import { NextRequest, NextResponse } from 'next/server';
import { connectDatabase, disconnectDatabase, specificationFromBody } from '@/lib/db-actions';
import { storeStatus } from '@/lib/store';
import { redactError } from '@/lib/store/env';
import { errMsg } from '@/lib/store/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Database management over HTTP — the same operations as the Telegram 🗄 menu.
 *
 *   GET    /api/database              → current database, reachability, saved choice
 *   POST   /api/database  {kind,url,token}  → connect & switch (probe first)
 *          /api/database  {"mode":"memory"|"auto"} → disconnect
 *   DELETE /api/database[?mode=memory|auto]   → disconnect
 *
 * Writes require `x-admin-secret: <ADMIN_SECRET|CRON_SECRET>` (or an
 * `Authorization: Bearer <secret>` header). Without either env var set, write
 * access is disabled and the Telegram menu remains the only way to change the
 * database — an unauthenticated endpoint that re-points the whole app's
 * storage would be a remote takeover.
 */
const adminSecret = () => process.env.ADMIN_SECRET?.trim() || process.env.CRON_SECRET?.trim() || '';

function authorized(req: NextRequest): boolean {
  const secret = adminSecret();
  if (!secret) return false;
  const header = req.headers.get('x-admin-secret')?.trim() ?? '';
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  return header === secret || bearer === secret;
}

const forbidden = () =>
  NextResponse.json(
    {
      ok: false,
      error: adminSecret()
        ? 'Unauthorized — send the admin secret in the x-admin-secret header or as a Bearer token.'
        : 'Database changes over HTTP are disabled because neither ADMIN_SECRET nor CRON_SECRET is set. Use the Telegram /database menu, or set ADMIN_SECRET.',
    },
    { status: 403 },
  );

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
      writable: Boolean(adminSecret()),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

async function applyChoice(req: NextRequest, mode: 'auto' | 'memory' | null) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const effectiveMode = mode ?? (typeof body.mode === 'string' ? (body.mode.trim().toLowerCase() as 'auto' | 'memory') : null);

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
  });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return forbidden();
  try {
    return await applyChoice(req, null);
  } catch (e) {
    return NextResponse.json({ ok: false, error: redactError(errMsg(e)) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!authorized(req)) return forbidden();
  try {
    const requested = (req.nextUrl.searchParams.get('mode') ?? 'memory').toLowerCase();
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
