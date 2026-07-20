/**
 * Client-side auth config — `(broker URL, bearer token)` persisted at
 * `./.csuite/auth.json` (project-scoped, sibling to `csuite.json`) after a
 * successful `csuite connect` run.
 *
 * Project-scoped (not user-scoped) so a single machine can hold a
 * distinct member identity per agent workspace — running `csuite connect`
 * in `~/projects/agent-a/` and `~/projects/agent-b/` produces two
 * independent enrollments without one stomping the other.
 *
 * Lookup uses git-style walk-up: starting at cwd, we walk parents
 * until a `.csuite/auth.json` is found, so any `csuite` command run from a
 * subdirectory of an enrolled project picks up the right token. Saves
 * also walk up first — re-running `csuite connect` from a subfolder
 * updates the project's existing entry instead of creating a stray
 * config in the wrong place. Only when nothing is found does the save
 * land in cwd.
 *
 * The CLI defaults to the env-var path (`CSUITE_URL` / `CSUITE_TOKEN`)
 * when both are present, and falls back to this file when they're
 * absent. `CSUITE_AUTH_CONFIG_PATH` overrides everything (used by tests
 * and air-gapped layouts).
 *
 * Storage shape is intentionally minimal — one entry per broker
 * URL, the most-recent write wins for the same URL. We do NOT
 * persist the `tokenId` (server-side handle), `label`, or `member
 * name`; if any of those drift the worst-case is the user re-runs
 * `csuite connect`. Less metadata on disk = less to leak if the file
 * is exfiltrated.
 *
 * File mode is 0o600 in a 0o700 dir, same posture as the server's
 * `csuite.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, parse as parsePath, resolve } from 'node:path';

export interface AuthConfigEntry {
  url: string;
  token: string;
  /** Epoch ms — when the token was minted on this device. */
  savedAt: number;
}

interface AuthConfigFile {
  /** Schema marker — bump if the file shape changes. */
  schema: 1;
  entries: AuthConfigEntry[];
}

/** The directory + filename used at every level of the walk-up search. */
const AUTH_DIR = '.csuite';
const AUTH_FILE = 'auth.json';

/**
 * The path where a fresh `csuite connect` writes when no existing config
 * is discovered upward — always cwd-scoped. `CSUITE_AUTH_CONFIG_PATH`
 * overrides for tests and air-gapped layouts.
 */
export function authConfigPath(): string {
  const override = process.env.CSUITE_AUTH_CONFIG_PATH;
  if (override) return override;
  return join(process.cwd(), AUTH_DIR, AUTH_FILE);
}

/**
 * Walk up from `start` (default cwd) looking for the closest
 * `.csuite/auth.json`. Returns its path if found, otherwise null.
 * Stops at the filesystem root. The env override short-circuits the
 * walk so test sandboxes stay isolated.
 */
export function findAuthConfigPath(start: string = process.cwd()): string | null {
  const override = process.env.CSUITE_AUTH_CONFIG_PATH;
  if (override) return existsSync(override) ? override : null;
  let dir = resolve(start);
  const root = parsePath(dir).root;
  // `root` itself is a valid place to look — git puts no `.git` at `/`
  // by convention, but we don't impose that, so include it.
  while (true) {
    const candidate = join(dir, AUTH_DIR, AUTH_FILE);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read every saved entry from the closest project-scoped config
 * found via walk-up. Empty list on no file or unrecognized shape.
 * Pass `path` to read from a specific file (used by tests and the
 * `--auth-config` flag).
 */
export function loadAuthConfig(path?: string): AuthConfigFile {
  const resolved = path ?? findAuthConfigPath();
  if (resolved === null) return { schema: 1, entries: [] };
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { schema: 1, entries: [] };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AuthConfigFile>;
    if (parsed.schema !== 1 || !Array.isArray(parsed.entries)) {
      // Surface unknown / corrupted state as an empty file rather
      // than crashing — the next save will overwrite it.
      return { schema: 1, entries: [] };
    }
    return {
      schema: 1,
      entries: parsed.entries.filter(
        (e): e is AuthConfigEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as AuthConfigEntry).url === 'string' &&
          typeof (e as AuthConfigEntry).token === 'string' &&
          typeof (e as AuthConfigEntry).savedAt === 'number',
      ),
    };
  } catch {
    return { schema: 1, entries: [] };
  }
}

/**
 * Atomically replace the entry for `url` (or insert if new) and
 * write back at 0o600. `mkdir -p` the containing dir at 0o700 so a
 * fresh install can save without an explicit setup step.
 *
 * Without an explicit `path`, save targets an existing project-level
 * config found via walk-up (so re-running `csuite connect` from a
 * subdirectory updates the project's config rather than scattering
 * a new `.csuite/` next to wherever the operator happens to be). Falls
 * back to the cwd-scoped path when no existing config is found.
 */
export function saveAuthEntry(entry: AuthConfigEntry, path?: string): void {
  const target = path ?? findAuthConfigPath() ?? authConfigPath();
  const file = loadAuthConfig(target);
  const next: AuthConfigEntry[] = file.entries.filter((e) => e.url !== entry.url);
  next.push(entry);
  const out: AuthConfigFile = { schema: 1, entries: next };
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Find a saved token for `url` (exact match — we do not normalize
 * trailing slashes here; the SDK Client does). Walks up from cwd to
 * find the closest project-scoped config. Returns null if no entry
 * matches.
 */
export function findAuthEntry(url: string, path?: string): AuthConfigEntry | null {
  const file = loadAuthConfig(path);
  return file.entries.find((e) => e.url === url) ?? null;
}
