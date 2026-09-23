import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { telegramAlerts } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const alert = await db.query.telegramAlerts.findFirst({
      orderBy: [desc(telegramAlerts.id)],
    });

    if (!alert) {
      return NextResponse.json({
        configured: false,
        active: false,
        webhookUrl: '',
        chatId: '',
        botToken: '',
        condition: 'change',
        targetRate: '',
      });
    }

    return NextResponse.json({
      configured: true,
      active: alert.active,
      webhookUrl: alert.webhookUrl || '',
      chatId: alert.chatId || '',
      botToken: alert.botToken ? '••••••••' : '',
      hasToken: Boolean(alert.botToken || process.env.TELEGRAM_BOT_TOKEN),
      condition: alert.condition,
      targetRate: alert.targetRate ? alert.targetRate.toString() : '',
      lastAlertAt: alert.lastAlertAt,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { webhookUrl, chatId, botToken, condition, targetRate, active } = body;

    // Find latest row or insert new
    const existing = await db.query.telegramAlerts.findFirst({
      orderBy: [desc(telegramAlerts.id)],
    });

    const valuesToUpdate: Record<string, any> = {
      webhookUrl: webhookUrl || null,
      chatId: chatId || null,
      condition: condition || 'change',
      targetRate: targetRate ? targetRate.toString() : null,
      active: typeof active === 'boolean' ? active : true,
    };

    if (botToken && botToken !== '••••••••') {
      valuesToUpdate.botToken = botToken;
    }

    if (existing) {
      await db.update(telegramAlerts)
        .set(valuesToUpdate)
        .where(eq(telegramAlerts.id, existing.id));
    } else {
      await db.insert(telegramAlerts).values(valuesToUpdate);
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
