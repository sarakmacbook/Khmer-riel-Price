import { storeBackend, storeDiagnostics, pingStore } from "@/lib/history-store";

export const dynamic = "force-dynamic";

/**
 * Health + database diagnostics. Works with ANY configured store
 * (Postgres / Turso / Upstash) and with none at all — the live rate is
 * scraped directly, so a missing database never reports the app as down.
 */
export async function GET() {
  const store = storeBackend();
  const diagnostics = storeDiagnostics();
  let storeOk = false;
  let error: string | null = null;

  try {
    storeOk = await pingStore();
  } catch (err: any) {
    error = err?.message ?? String(err);
  }

  return Response.json({
    ok: true,
    store,
    database: store !== "memory",
    storeOk,
    error,
    ...diagnostics,
    timestamp: new Date().toISOString(),
  });
}
