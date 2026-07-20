/**
 * Time-based One-Time Password (TOTP) helper for human web-UI auth.
 *
 * Wraps the `otpauth` library with csuite's fixed parameters and
 * adds a replay guard on top. The replay guard is what makes this
 * usable — raw TOTP accepts a code for the entire 30-second window,
 * which means a code can be reused multiple times within that window.
 * We track the last accepted period counter per slot and reject any
 * subsequent code whose counter is ≤ the stored one.
 *
 * Parameters (fixed so every Authenticator app works without config):
 *   algorithm: SHA1
 *   digits:    6
 *   period:    30 seconds
 *   window:    ±1 period (tolerates mild clock skew)
 *
 * Secrets are 20 random bytes (160 bits) rendered as base32 — the
 * default for Google Authenticator compatibility. We never derive new
 * secrets from known material; enrollment always calls `generateSecret()`.
 */

import { Secret, TOTP } from 'otpauth';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** ±1 period tolerance for clock skew — 30s behind to 30s ahead. */
export const TOTP_WINDOW = 1;
const TOTP_ALGORITHM = 'SHA1';
/** 20 bytes = 160 bits, RFC 4226 / Google Authenticator compatible. */
const SECRET_BYTES = 20;

/**
 * Generate a fresh base32 secret suitable for pasting into an
 * authenticator app or encoding into an `otpauth://` URI.
 */
export function generateSecret(): string {
  return new Secret({ size: SECRET_BYTES }).base32;
}

/**
 * Build the `otpauth://totp/...` URI that Google Authenticator, Authy,
 * 1Password, etc. scan from a QR code. The `issuer` shows up as the
 * account group ("csuite"); `label` is the account name inside that
 * group (typically the name).
 */
export function otpauthUri(opts: { secret: string; issuer: string; label: string }): string {
  return new TOTP({
    issuer: opts.issuer,
    label: opts.label,
    secret: Secret.fromBase32(opts.secret),
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  }).toString();
}

/**
 * Compute the TOTP code for `secret` at `timestamp`. Only used by
 * tests and by the enrollment flow that lets members verify their
 * phone is set up before persisting the secret.
 */
export function currentCode(secret: string, timestamp: number = Date.now()): string {
  return TOTP.generate({
    secret: Secret.fromBase32(secret),
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    timestamp,
  });
}

export type VerifyResult =
  | { ok: true; counter: number }
  | { ok: false; reason: 'malformed' | 'invalid' | 'replay' };

/**
 * Verify `code` against `secret`, rejecting reuse. `lastCounter` is
 * the counter of the last code this slot accepted (0 for never). On
 * success the returned `counter` should be persisted as the new
 * `lastCounter` before the session is created.
 *
 * Returns:
 *   - `{ ok: true, counter }`                   — caller persists counter, creates session
 *   - `{ ok: false, reason: 'malformed' }`      — not 6 digits, or secret isn't valid base32
 *   - `{ ok: false, reason: 'invalid' }`        — code doesn't match for any period in window
 *   - `{ ok: false, reason: 'replay' }`         — code valid, but already accepted (or older)
 */
export function verifyCode(
  secret: string,
  code: string,
  lastCounter: number,
  now: number = Date.now(),
): VerifyResult {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) {
    return { ok: false, reason: 'malformed' };
  }

  let secretObj: Secret;
  try {
    secretObj = Secret.fromBase32(secret);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const delta = TOTP.validate({
    token: trimmed,
    secret: secretObj,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    timestamp: now,
    window: TOTP_WINDOW,
  });

  if (delta === null) {
    return { ok: false, reason: 'invalid' };
  }

  // TOTP.validate returns the delta in periods from the current period.
  // The accepted counter is floor(now_s / period) + delta. We store and
  // compare this so a code from period N can't be replayed, AND a code
  // from period N-1 can't be accepted after we already accepted a code
  // from period N (which would happen in the ±1 window otherwise).
  const currentCounter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  const counter = currentCounter + delta;

  if (counter <= lastCounter) {
    return { ok: false, reason: 'replay' };
  }

  return { ok: true, counter };
}
