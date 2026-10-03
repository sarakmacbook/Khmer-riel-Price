/**
 * Database operations shared by the Telegram bot menu and `POST /api/database`:
 * connect (probe first, then switch), disconnect, and health checks.
 *
 * Every operation is safe to run while the app is live: the probe happens
 * against a throwaway instance, and only a database that answers is saved and
 * made active.
 */

import { configFromSpec, redactError, type DbSpec } from './store/env';
import { specFromInput } from './db-config';
import { probeStore, resetStore, storeStatus, type ProbeResult, type StoreStatus } from './store';
import { saveChoice, type DbChoice, type SaveResult } from './db-config';

export interface ConnectInput {
  kind?: string | null;
  url: string;
  token?: string | null;
  label?: string | null;
}

export interface ConnectOutcome extends ProbeResult {
  label: string;
  /** How the choice is described back to the user */
  summary: string;
  save: SaveResult;
}

/** Probe a database and, only if it answers, make it the active one. */
export async function connectDatabase(
  spec: DbSpec,
  opts: { by?: string | null; source?: 'telegram' | 'dashboard' } = {},
): Promise<ConnectOutcome> {
  const cfg = configFromSpec(spec);
  const probe = await probeStore(cfg);

  if (!probe.ok) {
    return {
      ...probe,
      error: redactError(probe.error ?? 'unknown error'),
      label: cfg.label,
      summary: '',
      save: { persisted: false, path: null },
    };
  }

  const choice: DbChoice = {
    mode: 'custom',
    spec,
    source: opts.source ?? 'telegram',
    setAt: Date.now(),
    setBy: opts.by ?? null,
  };
  const save = await saveChoice(choice, opts.by ?? null);
  resetStore(); // next request connects with the new config

  return { ...probe, label: cfg.label, summary: cfg.label, save };
}

/** Switch back to the deployment's env database, or to no database at all. */
export async function disconnectDatabase(
  mode: 'auto' | 'memory',
  by: string | null = null,
): Promise<{ save: SaveResult; status: StoreStatus }> {
  const choice: DbChoice =
    mode === 'memory'
      ? { mode: 'memory', setAt: Date.now(), setBy: by }
      : { mode: 'auto' };
  const save = await saveChoice(choice, by);
  resetStore();
  return { save, status: await storeStatus() };
}

/** Ping the active database (creates the schema on a brand-new server too). */
export async function testActiveDatabase(): Promise<StoreStatus> {
  resetStore(); // always re-connect for a real "test", never a cached instance
  return storeStatus();
}

export type SpecParse = { ok: true; spec: DbSpec } | { ok: false; error: string };

/** Parse a JSON body into a validated spec — accepts a few common field spellings. */
export function specificationFromBody(body: Record<string, unknown>): SpecParse {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const url = str(body.url) || str(body.connectionString) || str(body.connection_string) || str(body.databaseUrl);
  const token = str(body.token) || str(body.authToken) || str(body.auth_token);
  const kind = str(body.kind) || str(body.type) || str(body.backend);
  const label = str(body.label) || str(body.name);
  if (!url) {
    return {
      ok: false,
      error: 'Missing "url" — send {"kind":"postgres","url":"postgresql://…","token":"…"} (kind may be omitted: it is detected from the URL).',
    };
  }
  try {
    return { ok: true, spec: specFromInput({ kind, url, token: token || null, label: label || null }) };
  } catch (e) {
    return { ok: false, error: redactError(e) };
  }
}
