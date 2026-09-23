import { getStore } from '@/lib/store';
import { detectStore } from '@/lib/store/env';

export const dynamic = 'force-dynamic';

export async function GET() {
  let kind = 'memory';
  try {
    kind = detectStore().kind;
    if (kind === 'memory') return Response.json({ ok: true, storage: kind });
    const store = await getStore();
    await store.latest();
    return Response.json({ ok: true, storage: kind });
  } catch (e) {
    return Response.json({ ok: false, storage: kind, error: (e as Error).message }, { status: 500 });
  }
}
