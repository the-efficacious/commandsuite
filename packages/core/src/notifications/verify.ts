/**
 * Inbound-signature verification for the `/hooks/:slug` ingress.
 *
 * Two schemes:
 *   - `hmac-sha256` — hex HMAC of the RAW request body carried in a
 *     header. Defaults are GitHub-compatible (`x-hub-signature-256`,
 *     value prefix `sha256=`); Stripe/Linear-style senders configure
 *     `headerName`/`prefix` to match their convention.
 *   - `header-secret` — the shared secret carried verbatim in a
 *     header (default `x-hook-secret`), for senders that can't sign.
 *
 * Both compare in constant time. HMAC is
 * computed over the exact received bytes — callers MUST pass the raw
 * body, never a re-serialized parse. Failure reasons are recorded on
 * the delivery receipt but never returned to the caller (the HTTP
 * response is a bare 401 — verification detail is a gift to
 * attackers).
 */

import { constantTimeEqual } from '../hashing.js';
import type { ResolvedVerification } from './store.js';

export const DEFAULT_HMAC_HEADER = 'x-hub-signature-256';
export const DEFAULT_HMAC_PREFIX = 'sha256=';
export const DEFAULT_HEADER_SECRET_HEADER = 'x-hook-secret';

export type VerifyResult = { ok: true } | { ok: false; reason: string };

async function hmacSha256Hex(secret: string, bytes: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes as BufferSource));
  let out = '';
  for (const b of mac) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function verifyInbound(
  verification: ResolvedVerification,
  rawBody: Uint8Array,
  getHeader: (name: string) => string | undefined,
): Promise<VerifyResult> {
  if (verification.secret === null) {
    // Fail closed: an endpoint without a secret accepts nothing.
    return { ok: false, reason: 'no signing secret configured' };
  }

  if (verification.kind === 'hmac-sha256') {
    const headerName = verification.headerName ?? DEFAULT_HMAC_HEADER;
    const prefix = verification.prefix ?? DEFAULT_HMAC_PREFIX;
    const headerValue = getHeader(headerName);
    if (headerValue === undefined) {
      return { ok: false, reason: `missing signature header ${headerName}` };
    }
    if (prefix.length > 0 && !headerValue.startsWith(prefix)) {
      return { ok: false, reason: 'signature header missing expected prefix' };
    }
    const provided = headerValue.slice(prefix.length).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(provided)) {
      return { ok: false, reason: 'signature is not a sha256 hex digest' };
    }
    const expected = await hmacSha256Hex(verification.secret, rawBody);
    if (!constantTimeEqual(provided, expected)) {
      return { ok: false, reason: 'signature mismatch' };
    }
    return { ok: true };
  }

  // header-secret
  const headerName = verification.headerName ?? DEFAULT_HEADER_SECRET_HEADER;
  const headerValue = getHeader(headerName);
  if (headerValue === undefined) {
    return { ok: false, reason: `missing secret header ${headerName}` };
  }
  if (!constantTimeEqual(headerValue, verification.secret)) {
    return { ok: false, reason: 'secret mismatch' };
  }
  return { ok: true };
}
