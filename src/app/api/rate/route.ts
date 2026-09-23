import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { exchangeRates } from '@/db/schema';
import { desc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const latest = await db.query.exchangeRates.findFirst({
      orderBy: [desc(exchangeRates.timestamp)],
    });

    if (!latest) {
      return NextResponse.json({ error: 'No rates found' }, { status: 404 });
    }

    const rate = parseFloat(latest.rate);
    const bid = latest.bid ? parseFloat(latest.bid) : rate;
    const ask = latest.ask ? parseFloat(latest.ask) : rate;

    return NextResponse.json({
      rate,
      bid,   // bank buys USD  -> baseline for your P2P SELL
      ask,   // bank sells USD  -> baseline for your P2P BUY
      timestamp: latest.timestamp,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
