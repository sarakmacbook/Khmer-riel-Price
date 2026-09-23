import { NextRequest, NextResponse } from 'next/server';
import { getStoreOrMemory } from '@/lib/store';
import { errMsg } from '@/lib/store/types';
import { getWebAlert, saveWebAlert } from '@/lib/alerts';

export const dynamic = 'force-dynamic';

const MASK = '••••••••';

export async function GET() {
  const store = await getStoreOrMemory();
  if (!store.persistent) {
    return NextResponse.json({ configured: false, active: false, databaseMissing: true });
  }
  try {
    const alert = await getWebAlert(store);
    if (!alert) {
      return NextResponse.json({ configured: false, active: false, webhookUrl: '', chatId: '', botToken: '', condition: 'change', targetRate: '', storage: store.kind });
    }
    return NextResponse.json({
      configured: true,
      active: alert.active,
      webhookUrl: alert.webhookUrl || '',
      chatId: alert.chatId || '',
      botToken: alert.botToken ? MASK : '',
      hasToken: Boolean(alert.botToken || process.env.TELEGRAM_BOT_TOKEN),
      condition: alert.condition,
      targetRate: alert.targetRate !== null ? String(alert.targetRate) : '',
      lastAlertAt: alert.lastAlertAt ? new Date(alert.lastAlertAt) : null,
      storage: store.kind,
    });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const store = await getStoreOrMemory();
  if (!store.persistent) {
    return NextResponse.json(
      {
        success: false,
        error: 'Saving alerts needs a database. Connect any Vercel storage (Neon, Supabase, Upstash, Turso, MongoDB, Blob…), then redeploy.',
      },
      { status: 503 },
    );
  }
  try {
    const { webhookUrl, chatId, botToken, condition, targetRate, active } = await req.json();
    await saveWebAlert(store, {
      webhookUrl: webhookUrl || null,
      chatId: chatId || null,
      botToken: botToken && botToken !== MASK ? botToken : botToken === '' ? null : undefined,
      condition: condition === 'above' || condition === 'below' ? condition : 'change',
      targetRate: targetRate !== null && targetRate !== undefined && targetRate !== '' ? Number(targetRate) : null,
      active: typeof active === 'boolean' ? active : true,
    });
    return NextResponse.json({ success: true, storage: store.kind });
  } catch (err) {
    return NextResponse.json({ success: false, error: errMsg(err) }, { status: 500 });
  }
}
