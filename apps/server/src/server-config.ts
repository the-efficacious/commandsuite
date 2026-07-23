/**
 * Boot-time server config — the slim file at `csuite.json`.
 *
 * This file holds ONLY infrastructure knobs that need to exist before
 * SQLite can open. Team identity, members, and permission presets
 * live in the database (see team-store.ts) and are mutated through
 * the API/CLI/MCP surface, not by hand-editing JSON.
 *
 * What's here:
 *   - dbPath, activityDbPath, filesRoot — storage paths
 *   - https                              — TLS mode + cert paths
 *   - webPush                            — VAPID keypair (encrypted)
 *   - jwt                                — federated JWT issuer config
 *   - files                              — upload caps + blob root
 *
 * What's NOT here:
 *   - team.name / context, permission presets              → DB
 *   - members[]                                            → DB
 *   - tokenHash, totpSecret                                → DB
 *
 * Hand-editing this file is supported as the "rescue path" for
 * deployment plumbing only. Identity changes go through the API.
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  ConfigNotFoundError,
  type FilesConfig,
  FilesConfigSchema,
  type HttpsConfig,
  HttpsConfigSchema,
  type JwtConfig,
  JwtConfigSchema,
  MemberLoadError,
  type WebPushConfig,
  WebPushConfigSchema,
} from './members.js';

export const ServerConfigSchema = z.object({
  _comment: z.unknown().optional(),
  /** Path to the main broker SQLite DB. Default: `./data/csuite.db` (or `:memory:` for tests). */
  dbPath: z.string().min(1).optional(),
  /** Optional override for the activity DB. Defaults to `<dbPath>-activity.db`. */
  activityDbPath: z.string().min(1).optional(),
  /** Root directory for the content-addressed file blob store. Default: `./data/files`. */
  filesRoot: z.string().min(1).optional(),
  https: HttpsConfigSchema.optional(),
  webPush: WebPushConfigSchema.optional(),
  jwt: JwtConfigSchema.optional(),
  files: FilesConfigSchema.optional(),
});

export interface ServerConfig {
  dbPath: string | null;
  activityDbPath: string | null;
  filesRoot: string | null;
  https: HttpsConfig | null;
  webPush: WebPushConfig | null;
  jwt: JwtConfig | null;
  files: FilesConfig | null;
}

export const SERVER_CONFIG_FILE_COMMENT =
  'csuite server config. Storage paths + HTTPS + Web Push + JWT only. Team, members, ' +
  'and permission presets live in the database — manage them via `csuite team`, ' +
  '`csuite member`, `csuite presets`, the REST API, or MCP tools. Hand-editing this ' +
  'file is supported only as a rescue path for deployment plumbing.';

/**
 * Read and validate the server config file. Throws
 * `ConfigNotFoundError` on ENOENT and `MemberLoadError` for any
 * other failure (invalid JSON, schema violation).
 */
export function loadServerConfigFromFile(path: string): ServerConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigNotFoundError(path);
    throw new MemberLoadError(`failed to read config file at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MemberLoadError(
      `config file at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const result = ServerConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue: { path: PropertyKey[]; message: string }) =>
          `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new MemberLoadError(`config file at ${path} is invalid:\n${issues}`);
  }
  return {
    dbPath: result.data.dbPath ?? null,
    activityDbPath: result.data.activityDbPath ?? null,
    filesRoot: result.data.filesRoot ?? null,
    https: result.data.https ?? null,
    webPush: result.data.webPush ?? null,
    jwt: result.data.jwt ?? null,
    files: result.data.files ?? null,
  };
}

/**
 * Persist the server config atomically with `chmod 0o600`. The webPush
 * private key is expected to already be encrypted (`enc-v1:...`) by
 * the caller — we don't crypt at this layer.
 */
export function writeServerConfigFile(path: string, config: ServerConfig): void {
  const body: Record<string, unknown> = {
    _comment: SERVER_CONFIG_FILE_COMMENT,
  };
  if (config.dbPath !== null) body.dbPath = config.dbPath;
  if (config.activityDbPath !== null) body.activityDbPath = config.activityDbPath;
  if (config.filesRoot !== null) body.filesRoot = config.filesRoot;
  if (config.https !== null) body.https = config.https;
  if (config.webPush !== null) body.webPush = config.webPush;
  if (config.jwt !== null) body.jwt = config.jwt;
  if (config.files !== null) body.files = config.files;

  const json = `${JSON.stringify(body, null, 2)}\n`;
  atomicWriteRestricted(path, json);
}

/**
 * Patch the on-disk server config in place. Reads the existing file,
 * applies a partial update, and rewrites atomically. Used by the
 * VAPID auto-generation path on first boot.
 */
export function updateServerConfigFile(path: string, patch: Partial<ServerConfig>): ServerConfig {
  const current = loadServerConfigFromFile(path);
  const next: ServerConfig = { ...current, ...patch };
  writeServerConfigFile(path, next);
  return next;
}

/**
 * Resolve a path field from a loaded ServerConfig against the config
 * file's own directory. Relative paths in the config refer to
 * locations adjacent to the config file — *not* the cwd of whoever is
 * reading it. This matters because the config file is often loaded
 * from one cwd (the wizard, run from the repo root) and consumed from
 * another (the broker, spawned from `apps/server/`); without anchoring,
 * `./csuite.db` resolves to two different files.
 *
 * Behavior:
 *   - `null` → `null` (no value to resolve)
 *   - absolute → returned verbatim
 *   - relative → joined onto `dirname(configPath)`
 */
export function resolveConfigPath(configPath: string, value: string | null): string | null {
  if (value === null) return null;
  if (isAbsolute(value)) return value;
  return join(dirname(configPath), value);
}

function atomicWriteRestricted(path: string, body: string): void {
  // Same write-then-rename + 0o600 pattern as the legacy file IO in
  // members.ts. Keeps the file readable only by the running user; an
  // attacker who can read the directory listing learns the path but
  // not the contents (notably the encrypted webPush private key, the
  // jwt audience, or the cert paths).
  const dir = dirname(path);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best-effort: on filesystems that ignore chmod (FAT, some shares)
    // we silently proceed — the open mode already restricted access.
  }
  renameSync(tmp, path);
  // dir fsync is intentionally omitted; SQLite's WAL across the same
  // directory takes care of durability for the system as a whole.
  void dir;
}
