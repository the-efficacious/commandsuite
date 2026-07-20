/**
 * On-disk persistence for TLS certs.
 *
 * csuite stores the active server cert + key next to its config
 * file at `<configDir>/certs/server.{crt,key}`. The files are written
 * at 0o600 via the same atomic-write helper the config file uses, so
 * a fresh generation is safe against crashes mid-write and never
 * leaks a readable key.
 *
 * Modes:
 *   - `self-signed`: load an existing cert if it's valid and not near
 *     expiry; otherwise generate a fresh one and persist it.
 *   - `custom`: load user-supplied cert/key from configured paths.
 *     No regeneration — the user manages renewal.
 *   - `off`: never called.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as FS,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { certExpiryMs, generateSelfSignedCert } from './cert.js';

export class HttpsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpsConfigError';
  }
}

export interface LoadedCert {
  cert: string;
  key: string;
  /** Path on disk (absolute) — null for ad-hoc generation with no persistence. */
  certPath: string | null;
  keyPath: string | null;
  /** UNIX ms notAfter, or null if indeterminate (custom cert failed to parse). */
  expiresAt: number | null;
  /** Short label for logs. */
  source: 'self-signed:fresh' | 'self-signed:reused' | 'custom';
}

export interface LoadSelfSignedOptions {
  configDir: string;
  lanIp?: string | null;
  validityDays: number;
  /** Days — if cert's notAfter is within this window, regenerate. */
  regenerateIfExpiringWithin: number;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface LoadCustomOptions {
  certPath: string;
  keyPath: string;
}

/**
 * Ensure the `<configDir>/certs/` directory exists, load an existing
 * self-signed cert from it if any, validate its expiry, and either
 * return it or generate a fresh one and persist.
 */
export async function loadOrGenerateSelfSigned(
  options: LoadSelfSignedOptions,
): Promise<LoadedCert> {
  const now = options.now ?? Date.now;
  const certsDir = join(options.configDir, 'certs');
  const certPath = join(certsDir, 'server.crt');
  const keyPath = join(certsDir, 'server.key');

  mkdirSync(certsDir, { recursive: true, mode: 0o700 });

  const existing = tryLoadPems(certPath, keyPath);
  if (existing) {
    const expiresAt = certExpiryMs(existing.cert);
    const renewCutoff = now() + options.regenerateIfExpiringWithin * 24 * 60 * 60 * 1000;
    if (expiresAt !== null && expiresAt > renewCutoff) {
      return {
        cert: existing.cert,
        key: existing.key,
        certPath,
        keyPath,
        expiresAt,
        source: 'self-signed:reused',
      };
    }
    // Expired or near-expiry — fall through and regenerate.
  }

  const fresh = await generateSelfSignedCert({
    lanIp: options.lanIp ?? null,
    validityDays: options.validityDays,
  });
  atomicWriteRestricted(certPath, fresh.cert);
  atomicWriteRestricted(keyPath, fresh.key);

  return {
    cert: fresh.cert,
    key: fresh.key,
    certPath,
    keyPath,
    expiresAt: fresh.expiresAt,
    source: 'self-signed:fresh',
  };
}

/**
 * Load a user-supplied cert + key from two explicit paths. No
 * regeneration, no expiry policing — the user owns the lifecycle.
 * Throws HttpsConfigError with a clear message if either file is
 * missing or unreadable.
 */
export function loadCustomCert(options: LoadCustomOptions): LoadedCert {
  let cert: string;
  let key: string;
  try {
    cert = readFileSync(options.certPath, 'utf8');
  } catch (err) {
    throw new HttpsConfigError(
      `https.custom.certPath: failed to read ${options.certPath}: ${(err as Error).message}`,
    );
  }
  try {
    key = readFileSync(options.keyPath, 'utf8');
  } catch (err) {
    throw new HttpsConfigError(
      `https.custom.keyPath: failed to read ${options.keyPath}: ${(err as Error).message}`,
    );
  }
  return {
    cert,
    key,
    certPath: options.certPath,
    keyPath: options.keyPath,
    expiresAt: certExpiryMs(cert),
    source: 'custom',
  };
}

/**
 * Generate a self-signed cert without persisting it — used in tests
 * where we want a fresh cert per run and don't want to pollute the
 * filesystem.
 */
export async function generateEphemeralCert(
  options: { lanIp?: string | null; validityDays?: number } = {},
): Promise<LoadedCert> {
  const fresh = await generateSelfSignedCert(options);
  return {
    cert: fresh.cert,
    key: fresh.key,
    certPath: null,
    keyPath: null,
    expiresAt: fresh.expiresAt,
    source: 'self-signed:fresh',
  };
}

// ─── internals ──────────────────────────────────────────────────────

function tryLoadPems(certPath: string, keyPath: string): { cert: string; key: string } | null {
  let cert: string;
  let key: string;
  try {
    cert = readFileSync(certPath, 'utf8');
    key = readFileSync(keyPath, 'utf8');
  } catch {
    return null;
  }
  return { cert, key };
}

/**
 * Write `body` to `path` atomically and mode 0o600. Same pattern as
 * `server-config.ts`'s `atomicWriteRestricted` — duplicated here
 * rather than shared because the two helpers serve different threat
 * models (config carries infra secrets like the webPush/jwt blocks,
 * certs are raw PEMs) and keeping them independent makes each simpler
 * to reason about. If a future refactor wants to share, extract to a
 * fs-utils module.
 */
function atomicWriteRestricted(path: string, body: string): void {
  const dir = dirname(path);
  const nonce = randomBytes(6).toString('hex');
  const tmp = join(dir, `.csuitecert.${nonce}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, FS.O_CREAT | FS.O_WRONLY | FS.O_EXCL, 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort — FUSE / Windows emulation may ignore
    }
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
