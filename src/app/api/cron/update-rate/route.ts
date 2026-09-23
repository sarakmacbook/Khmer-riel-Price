import { NextRequest, NextResponse } from 'next/server';
import { refreshRate } from '@/lib/rates';

export const dynamic = 'force-dynamic';
// Allow time for a slow Wing Bank response (background refresh runs after the reply is sent)
export const maxDuration = 60;

/**
 * Force a Wing Bank refresh (+ Telegram alerts on change).
 * Called by: Vercel daily cron, the Docker updater, or any external pinger
 * (e.g. cron-job.org every minute on Vercel Hobby).
 * Auth: `Authorization: Bearer <CRON_SECRET>` or `?secret=<CRON_SECRET>`.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const ok =
      req.headers.get('authorization') === `Bearer ${secret}` ||
      req.nextUrl.searchParams.get('secret') === secret;
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const latest = await refreshRate();
    return NextResponse.json({ success: true, ...latest }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
