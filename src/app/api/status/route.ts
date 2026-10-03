import { NextRequest, NextResponse } from 'next/server';
import { storeStatus } from '@/lib/store';
import { linkJson } from '@/lib/db-http';
import { maskTarget, redactError } from '@/lib/store/env';
import { fetchWingBankQuote } from '@/lib/scraper';
import { REFRESH_MS } from '@/lib/rates';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Deployment diagnostics. Open /api/status (fast) or /api/status?check=1
 * (also performs a live Wing Bank fetch and reports timing / errors).
 * Never prints secrets — only env var NAMES.
 */
export async function GET(req: NextRequest) {
  const out: Record<string, unknown> = {
    platform: process.env.VERCEL ? 'vercel' : 'node',
    region: process.env.VERCEL_REGION ?? null,
    time: new Date().toISOString(),
  };

  // ---- Storage ----
  // Reports the database actually in use, including one connected at runtime
  // from the Telegram 🗄 menu (POST /api/database), plus how it was chosen.
  const s = await storeStatus();
  const storage: Record<string, unknown> = {
    kind: s.configuredKind,
    label: s.activeLabel,
    envVars: s.detected.find((d) => d.kind === s.configuredKind)?.envVars ?? [],
    forced: process.env.STORAGE ?? null,
    mode: s.choice.mode,
    source: s.source,
    activeKind: s.activeKind,
    reachable: s.reachable,
    persistent: s.persistent,
    ms: s.ms,
    stats: s.stats,
    detected: s.detected.map((c) => ({ kind: c.kind, label: c.label, envVars: c.envVars })),
    configPath: s.configPath,
    configWarning: s.configWarning,
  };
  if (s.error) storage.error = redactError(s.error);
  if (s.choice.mode === 'custom') {
    storage.target = maskTarget(s.choice.spec.url); // masked — never the password/token
  }
  // Linked backup database: which side is serving, health of both, sync state.
  if (s.link) storage.link = linkJson(s.link);
  if (storage.activeKind === 'memory') {
    storage.note =
      s.choice.mode === 'memory'
        ? 'Database disconnected (in-memory store) — the live rate works; history & saved alerts reset on restart.'
        : 'No database connected — the live rate works; history & saved alerts need any storage integration. Open the Telegram /database menu to connect one.';
  }
  out.storage = storage;

  // ---- Wing Bank (only when ?check=1, since it can take several seconds) ----
  if (req.nextUrl.searchParams.get('check')) {
    const t2 = Date.now();
    try {
      out.wingbank = { ok: true, ms: Date.now() - t2, ...(await fetchWingBankQuote()) };
      (out.wingbank as Record<string, unknown>).ms = Date.now() - t2;
    } catch (e) {
      const err = e as Error & { kind?: string };
      out.wingbank = { ok: false, ms: Date.now() - t2, kind: err.kind ?? 'unknown', error: err.message };
    }
  } else {
    out.wingbank = 'add ?check=1 to test a live fetch';
  }

  out.config = {
    telegramBotToken: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    cronSecret: Boolean(process.env.CRON_SECRET),
    siteUrl: process.env.SITE_URL ?? null,
    refreshSeconds: REFRESH_MS / 1000,
    wingbankUrlOverride: Boolean(process.env.WINGBANK_URL),
  };

  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } });
}
