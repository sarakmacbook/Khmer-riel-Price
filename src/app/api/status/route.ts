import { NextRequest, NextResponse } from 'next/server';
import { getStore, lastStoreError } from '@/lib/store';
import { detectAll, detectStore } from '@/lib/store/env';
import { errMsg } from '@/lib/store/types';
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
  const storage: Record<string, unknown> = {};
  try {
    const cfg = detectStore();
    Object.assign(storage, { kind: cfg.kind, label: cfg.label, envVars: cfg.envVars, forced: process.env.STORAGE ?? null });
  } catch (e) {
    storage.configError = errMsg(e);
  }
  storage.detected = detectAll().map((c) => ({ kind: c.kind, label: c.label, envVars: c.envVars }));

  const t = Date.now();
  try {
    const store = await getStore();
    Object.assign(storage, { reachable: true, persistent: store.persistent, ms: 0 });
    storage.stats = await store.stats();
    storage.ms = Date.now() - t;
  } catch (e) {
    Object.assign(storage, { reachable: false, ms: Date.now() - t, error: errMsg(e) || lastStoreError() });
  }
  if (storage.kind === 'memory') {
    storage.note = 'No database connected — the live rate works; history & saved alerts need any Vercel storage integration.';
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
