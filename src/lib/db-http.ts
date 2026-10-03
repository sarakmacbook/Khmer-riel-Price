/**
 * Shared plumbing for the database HTTP endpoints (`/api/database`,
 * `/api/database/link`): admin-secret checks and a sanitised view of the
 * linked backup pair. Connection strings never leave the server unmasked.
 */

import type { NextRequest } from 'next/server';
import { maskTarget, redactError } from './store/env';
import type { LinkSideStatus, LinkStatus } from './store';

/** Secret that authorises database changes over HTTP (ADMIN_SECRET or CRON_SECRET). */
export const adminSecret = (): string => process.env.ADMIN_SECRET?.trim() || process.env.CRON_SECRET?.trim() || '';

/** true when the request carries the admin secret as a header or Bearer token. */
export function authorized(req: NextRequest): boolean {
  const secret = adminSecret();
  if (!secret) return false;
  const header = req.headers.get('x-admin-secret')?.trim() ?? '';
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? '';
  return header === secret || bearer === secret;
}

/** Why write access is refused — used verbatim in 403 responses. */
export function forbiddenReason(): string {
  return adminSecret()
    ? 'Unauthorized — send the admin secret in the x-admin-secret header or as a Bearer token.'
    : 'Database changes over HTTP are disabled because neither ADMIN_SECRET nor CRON_SECRET is set. Use the Telegram /database menu, or set ADMIN_SECRET.';
}

const sideJson = (side: LinkSideStatus) => ({
  kind: side.kind,
  label: side.label,
  target: side.target,
  reachable: side.reachable,
  ms: side.ms,
  rows: side.rows,
  latest: side.latest,
  alerts: side.alerts,
  stats: side.stats,
  error: side.error ? redactError(side.error) : null,
  /** Health the running app observed while serving requests */
  runtime: side.runtime
    ? {
        ok: side.runtime.ok,
        latencyMs: side.runtime.latencyMs,
        downSince: side.runtime.downSince,
        lastOkAt: side.runtime.lastOkAt,
        error: side.runtime.error ? redactError(side.runtime.error) : null,
      }
    : null,
});

/** Public, secret-free view of the linked pair (also used by /api/status). */
export function linkJson(status: LinkStatus | null): Record<string, unknown> | null {
  if (!status) return null;
  return {
    linked: true,
    source: status.source,
    /** true = this process actually joined the two databases (not just configured) */
    active: status.active,
    serving: status.serving,
    reason: status.reason,
    options: status.options,
    primary: sideJson(status.primary),
    backup: sideJson(status.backup),
    counters: {
      ...status.counters,
      lastMirrorError: status.counters.lastMirrorError ? redactError(status.counters.lastMirrorError) : null,
      lastResyncError: status.counters.lastResyncError ? redactError(status.counters.lastResyncError) : null,
    },
    drift: status.drift,
    checkedAt: status.checkedAt,
  };
}

/** Masked description of a spec for responses/messages. */
export const maskedTarget = (url: string | null | undefined): string | null => (url ? maskTarget(url) : null);
