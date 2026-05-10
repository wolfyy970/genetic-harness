/**
 * @module server/auth
 *
 * Bearer-token middleware for the HTTP server. The token is read from
 * the `HARNESS_TOKEN` env var; when unset, requests are unconditionally
 * allowed (suitable for localhost-only binding). When set, every
 * `/api/*` request must include `Authorization: Bearer <token>`.
 *
 * Constant-time string comparison via Node's `timingSafeEqual` to avoid
 * trivial timing oracles.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

let configuredToken: string | null = process.env.HARNESS_TOKEN ?? null;

/** Override the configured token. Tests use this to flip auth on/off. */
export function setAuthToken(token: string | null): void {
  configuredToken = token && token.length > 0 ? token : null;
}

/** Read the configured token. Used by startup checks. */
export function getAuthToken(): string | null {
  return configuredToken;
}

/** True when the request has a valid Bearer token (or auth is disabled). */
export function isAuthorized(req: IncomingMessage): boolean {
  if (!configuredToken) return true;
  const header = req.headers['authorization'] ?? '';
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = header.slice('Bearer '.length).trim();
  if (supplied.length !== configuredToken.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(supplied, 'utf8'),
      Buffer.from(configuredToken, 'utf8'),
    );
  } catch {
    return false;
  }
}

/**
 * Validate the bind-host / token combination. Returns null when the
 * configuration is acceptable; an error message otherwise. Called once
 * at server startup so the operator gets a clear refusal instead of
 * accidentally exposing an unauth'd API to the network.
 */
export function validateBindHost(host: string, token: string | null): string | null {
  // Localhost is always fine, with or without a token.
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return null;
  if (!token || token.length < 16) {
    return `HARNESS_HOST=${host} requires HARNESS_TOKEN to be set (>=16 chars).`;
  }
  return null;
}
