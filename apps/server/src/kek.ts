/**
 * Key-encryption-key (KEK) resolution + field-level AES-256-GCM
 * primitives for wrapping TOTP secrets and the VAPID private key
 * at rest.
 *
 * The team config file (`csuite.json`) stores bearer tokens as
 * SHA-256 hashes, but until this module landed it stored TOTP secrets
 * (base32) and the VAPID private key (PEM) as plaintext. That was the
 * second HIGH-severity finding in the 2026-04-16 audit: a read-only
 * exfiltration of `csuite.json` leaked every member's web-login
 * credential permanently (rotating would have required re-enrolling
 * every member from scratch).
 *
 * This module provides two building blocks:
 *
 *   1. `resolveKek()` — returns the 32-byte key to use for field
 *      encryption. Order of precedence:
 *        (a) `CSUITE_KEK` env var — base64 / base64url of exactly 32 bytes
 *        (b) a persisted key file at `<configDir>/csuite-kek.bin`
 *            (`0o600`). Auto-generated on first resolve if missing.
 *      Either source alone is enough; operators who want the KEK
 *      managed by their OS keychain / secret manager inject it via
 *      `CSUITE_KEK`. Zero-config self-host users get the file-based
 *      default.
 *
 *   2. `encryptField()` / `decryptField()` — wrap a plaintext value
 *      with AES-256-GCM (12-byte random IV, 16-byte auth tag) and
 *      emit / parse a single opaque string of shape
 *      `enc-v1:<base64url(iv)>:<base64url(tag)>:<base64url(ct)>`.
 *      The `enc-v1:` prefix makes it trivial to distinguish from
 *      the legacy plaintext formats (base32 TOTP secret, PEM VAPID
 *      key) when migrating.
 *
 * Design notes:
 *
 *   - AES-256-GCM is authenticated: a tampered ciphertext fails
 *     decrypt with a clear error, not a silent bit flip. This closes
 *     the "attacker also has write access to the config file" sub-
 *     case of the same threat model.
 *   - The KEK is never persisted alongside the config file — the
 *     default key location is `<configDir>/csuite-kek.bin`, and we
 *     recommend operators chmod the containing directory (`0o700`)
 *     rather than relying on the individual file's `0o600`. Fresh
 *     bootstraps get this for free — the wizard paths create the
 *     `./csuite/` server directory with mode `0o700`.
 *   - Single format version (`enc-v1`). A future format will bump
 *     the prefix (`enc-v2:`...) and both loaders will coexist for
 *     one release window.
 *   - `resolveKek` is synchronous — called once at server boot.
 *     Callers that run without a server (e.g. the CLI `rotate`
 *     subcommand) don't need it.
 */

import {
  type CipherGCM,
  type CipherGCMTypes,
  createCipheriv,
  createDecipheriv,
  type DecipherGCM,
  randomBytes,
} from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const KEK_ENV_VAR = 'CSUITE_KEK';
const KEK_FILE_NAME = 'csuite-kek.bin';
const KEK_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ALGORITHM: CipherGCMTypes = 'aes-256-gcm';

export const ENCRYPTED_FIELD_PREFIX = 'enc-v1:';

export class KekResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KekResolutionError';
  }
}

export class EncryptedFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedFieldError';
  }
}

/**
 * Resolve the KEK to use for field-level encryption.
 *
 * @param configPath Absolute path of the team config file — used
 *   only to derive the default key-file location (alongside the
 *   config, in the same directory). Not read.
 * @param env Process env map; defaults to `process.env`. Allows tests
 *   to pin a specific KEK via `CSUITE_KEK`.
 */
export function resolveKek(configPath: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const envVal = env[KEK_ENV_VAR];
  if (envVal && envVal.length > 0) {
    return parseKekFromString(envVal, `${KEK_ENV_VAR} env var`);
  }
  const keyFilePath = join(dirname(configPath), KEK_FILE_NAME);
  if (existsSync(keyFilePath)) {
    const raw = readFileSync(keyFilePath);
    if (raw.length !== KEK_BYTES) {
      throw new KekResolutionError(
        `KEK file at ${keyFilePath} has ${raw.length} bytes; expected exactly ${KEK_BYTES}. ` +
          `Delete the file to regenerate, or set ${KEK_ENV_VAR} to an explicit base64-encoded 32-byte key.`,
      );
    }
    return raw;
  }
  // First-boot auto-generate. Same atomic-ish posture as the config:
  // write with 0o600 so a broker user's key file isn't world-readable.
  const fresh = randomBytes(KEK_BYTES);
  writeFileSync(keyFilePath, fresh, { mode: 0o600 });
  try {
    chmodSync(keyFilePath, 0o600);
  } catch {
    // best-effort; some filesystems ignore chmod
  }
  return fresh;
}

/**
 * Parse a user-supplied KEK string into exactly 32 raw bytes. Accepts
 * base64 and base64url. Throws `KekResolutionError` on any length or
 * encoding mismatch — never silently truncates or extends.
 */
function parseKekFromString(value: string, source: string): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value.trim(), 'base64');
  } catch (err) {
    throw new KekResolutionError(
      `${source}: failed to base64-decode KEK (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (decoded.length !== KEK_BYTES) {
    throw new KekResolutionError(
      `${source}: KEK must decode to exactly ${KEK_BYTES} bytes; got ${decoded.length}`,
    );
  }
  return decoded;
}

/**
 * Encrypt a plaintext string with AES-256-GCM and return the opaque
 * `enc-v1:...` wrapper. Null/undefined input pass through as-is so
 * callers don't have to branch before invoking.
 */
export function encryptField(plaintext: string | null | undefined, kek: Buffer): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  if (plaintext.startsWith(ENCRYPTED_FIELD_PREFIX)) {
    // Already encrypted — idempotent. Lets `encryptTotpSecret` be
    // called on a member that was loaded in already-encrypted form
    // without re-wrapping.
    return plaintext;
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, kek, iv) as CipherGCM;
  const ctParts = [cipher.update(plaintext, 'utf8'), cipher.final()];
  const ciphertext = Buffer.concat(ctParts);
  const authTag = cipher.getAuthTag();
  return [
    ENCRYPTED_FIELD_PREFIX.slice(0, -1), // "enc-v1"
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Decrypt an `enc-v1:...` wrapper back to plaintext. If the input is
 * null/undefined, returns null — same shape as `encryptField`. If the
 * input does NOT start with `enc-v1:`, returns it unchanged (plaintext
 * passthrough for the migration path). Throws `EncryptedFieldError`
 * only when the input looks encrypted but fails to parse or
 * authenticate — in which case the config is either corrupt, the
 * wrong KEK is in use, or the file was tampered with.
 */
export function decryptField(value: string | null | undefined, kek: Buffer): string | null {
  if (value === null || value === undefined) return null;
  if (!value.startsWith(ENCRYPTED_FIELD_PREFIX)) {
    return value;
  }
  const parts = value.split(':');
  if (parts.length !== 4) {
    throw new EncryptedFieldError(
      `encrypted field is malformed: expected 4 colon-separated parts, got ${parts.length}`,
    );
  }
  const [, ivB64, tagB64, ctB64] = parts;
  let iv: Buffer;
  let authTag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(ivB64 ?? '', 'base64url');
    authTag = Buffer.from(tagB64 ?? '', 'base64url');
    ciphertext = Buffer.from(ctB64 ?? '', 'base64url');
  } catch (err) {
    throw new EncryptedFieldError(
      `encrypted field base64url decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (iv.length !== IV_BYTES) {
    throw new EncryptedFieldError(`encrypted field IV must be ${IV_BYTES} bytes; got ${iv.length}`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new EncryptedFieldError(
      `encrypted field auth tag must be ${AUTH_TAG_BYTES} bytes; got ${authTag.length}`,
    );
  }
  const decipher = createDecipheriv(ALGORITHM, kek, iv) as DecipherGCM;
  decipher.setAuthTag(authTag);
  try {
    const parts = [decipher.update(ciphertext), decipher.final()];
    return Buffer.concat(parts).toString('utf8');
  } catch (err) {
    throw new EncryptedFieldError(
      `encrypted field failed authentication (wrong KEK or tampered data): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Test helper — mint a random 32-byte KEK for use in tests that
 * need a real key without going through file/env resolution.
 */
export function testKek(): Buffer {
  return randomBytes(KEK_BYTES);
}
