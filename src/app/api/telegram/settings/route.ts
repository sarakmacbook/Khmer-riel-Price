import { NextRequest, NextResponse } from 'next/server';
import { getStoreOrMemory } from '@/lib/store';
import { errMsg } from '@/lib/store/types';
import { getWebAlert, normalizeAlertInput, saveWebAlert } from '@/lib/alerts';
import { TOKEN_MASK, isUsableSecret } from '@/lib/telegram';

export const dynamic = 'force-dynamic';

const DEFAULTS = {
  configured: false,
  active: false,
  webhookUrl: '',
  chatId: '',
  botToken: '',
  hasToken: false,
  condition: 'change',
  targetRate: '',
  customMessage: '',
  lastAlertAt: null as number | null,
  storage: '',
  persistent: false,
};

/**
 * Read the dashboard's Telegram alert.
 *
 * Works with ANY configured storage (Postgres, Turso, MongoDB, Upstash/Redis,
 * Vercel Blob, memory) through the RateStore abstraction — it used to answer
 * "not configured" on everything except Postgres, which silently broke the
 * whole Telegram panel on those deployments.
 *
 * The stored token is never returned; only `hasToken`.
 */
export async function GET() {
  try {
    const store = await getStoreOrMemory();
    const alert = await getWebAlert(store);

    if (!alert) {
      return NextResponse.json({
        ...DEFAULTS,
        hasToken: isUsableSecret(process.env.TELEGRAM_BOT_TOKEN),
        storage: store.label,
        persistent: store.persistent,
      });
    }

    return NextResponse.json({
      configured: true,
      active: alert.active,
      webhookUrl: alert.webhookUrl || '',
      chatId: alert.chatId || '',
      // Never echo the real token back to the browser.
      botToken: '',
      hasToken: isUsableSecret(alert.botToken) || isUsableSecret(process.env.TELEGRAM_BOT_TOKEN),
      condition: alert.condition,
      targetRate: alert.targetRate ? alert.targetRate.toString() : '',
      customMessage: alert.customMessage || '',
      lastAlertAt: alert.lastAlertAt,
      storage: store.label,
      persistent: store.persistent,
    });
  } catch (e) {
    // Store unreachable — report "not configured" instead of a 500, but say why.
    return NextResponse.json({ ...DEFAULTS, error: errMsg(e) });
  }
}

export async function POST(req: NextRequest) {
  try {
    const store = await getStoreOrMemory();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    let input;
    try {
      input = normalizeAlertInput(body);
    } catch (e) {
      return NextResponse.json({ success: false, error: errMsg(e) }, { status: 400 });
    }

    // Only a real token replaces the stored one: an absent field or the UI mask
    // ("••••••••") means "keep what you already have".
    const rawToken = typeof body.botToken === 'string' ? body.botToken.trim() : '';
    const botToken = isUsableSecret(rawToken) && rawToken !== TOKEN_MASK ? rawToken : undefined;

    const saved = await saveWebAlert(store, { ...input, botToken });

    return NextResponse.json({
      success: true,
      configured: true,
      active: saved.active,
      hasToken: isUsableSecret(saved.botToken) || isUsableSecret(process.env.TELEGRAM_BOT_TOKEN),
      storage: store.label,
      persistent: store.persistent,
      warning: store.persistent
        ? undefined
        : `${store.label} does not persist across restarts — connect a database to keep these alert settings.`,
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 });
  }
}
