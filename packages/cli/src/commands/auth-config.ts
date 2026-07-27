/**
 * Client-side auth store — `(broker URL, workspace, bearer token)` triples
 * persisted in ONE user-global file after a successful `csuite connect`.
 *
 * ## Why global, with the workspace recorded in the entry
 *
 * A single machine legitimately holds several member identities: enrolling
 * in `~/projects/agent-a` and `~/projects/agent-b` should produce two
 * independent tokens, and a command run from a subdirectory of either
 * should resolve to the right one. The obvious way to get that is to keep
 * the credential *in* the workspace and walk up to find it — which is what
 * this module used to do.
 *
 * That put a bearer token inside the operator's project tree, i.e. usually
 * inside a git repository, one `git add -A` away from being published. And
 * a csuite bearer is not a narrow credential: `GET /secrets/resolve` on it
 * returns every third-party secret bound to that member, so a leaked token
 * hands over the whole set.
 *
 * The fix keeps the feature and drops the hazard. The walk-up was only ever
 * computing "the most specific enrolled directory wins", and that is a
 * longest-prefix match — it does not require the file to live in the tree.
 * So the store is global and each entry names the workspace it belongs to:
 *
 *   { url, workspace: '/home/x/projects/agent-a', token, savedAt }
 *   { url, workspace: null, token, savedAt }   ← unscoped / machine-wide
 *
 * Resolution matches the URL exactly, then picks the entry whose
 * `workspace` is the longest path-prefix of the cwd, then falls back to the
 * unscoped entry. Same semantics as the walk-up, no credential in the repo.
 *
 * A `workspace: null` entry is the right shape for a machine that is not
 * organized around projects at all — a CI runner or a laptop with one
 * broker.
 *
 * ## Store location
 *
 * Per-OS user config directory (`$CSUITE_AUTH_CONFIG_PATH` overrides
 * everything, used by tests and air-gapped layouts):
 *
 *   Linux/BSD  $XDG_CONFIG_HOME/csuite/auth.json  (~/.config/csuite/auth.json)
 *   macOS      ~/Library/Application Support/csuite/auth.json
 *   Windows    %APPDATA%\csuite\auth.json
 *
 * ## Legacy stores
 *
 * Installations enrolled before this change have a project-scoped
 * `<dir>/.csuite/auth.json`. Those are still READ (via the old walk-up) so
 * an upgrade never locks anyone out, and the file's own location is exactly
 * the `workspace` value the new format wants — which makes migration
 * lossless. `csuite auth migrate` folds them in; `csuite connect` does it in
 * passing. Reads never write, so nothing migrates behind the operator's
 * back.
 *
 * ## Storage shape
 *
 * Minimal on purpose — we do NOT persist `tokenId`, `label`, or member
 * name; if any of those drift the worst case is re-running `csuite connect`.
 * Less metadata on disk is less to leak. File mode is 0o600 in a 0o700 dir,
 * same posture as the server's `csuite.json`.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve } from 'node:path';

export interface AuthConfigEntry {
  url: string;
  /**
   * Absolute path of the workspace this token belongs to, or `null` for an
   * unscoped (machine-wide) entry. A command resolves to the entry whose
   * workspace is the closest ancestor of its cwd, so a token enrolled in a
   * project root serves every subdirectory of it.
   */
  workspace: string | null;
  token: string;
  /** Epoch ms — when the token was minted on this device. */
  savedAt: number;
}

interface AuthStoreFile {
  /**
   * Schema marker. 1 = legacy project-scoped file with no `workspace`
   * field; 2 = global store with per-entry workspace scoping. A schema-1
   * file read as a store has its entries treated as unscoped.
   */
  schema: 1 | 2;
  entries: AuthConfigEntry[];
}

/** Current on-disk schema for newly written stores. */
export const AUTH_STORE_SCHEMA = 2;

/** The directory + filename used by legacy project-scoped stores. */
const LEGACY_DIR = '.csuite';
const AUTH_FILE = 'auth.json';

/**
 * The user-global config directory csuite stores auth under. Mirrors the
 * platform conventions the rest of the docs describe; there is deliberately
 * no csuite-specific env var besides the full-path override, so there is
 * exactly one knob rather than two that can disagree.
 */
function defaultStoreDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData !== undefined && appData.length > 0) return join(appData, 'csuite');
    return join(homedir(), 'AppData', 'Roaming', 'csuite');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'csuite');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0) return join(xdg, 'csuite');
  return join(homedir(), '.config', 'csuite');
}

/**
 * Absolute path of the global auth store. `CSUITE_AUTH_CONFIG_PATH` wins
 * outright — it is how tests stay isolated and deployments pin the store to
 * a particular location.
 */
export function authStorePath(): string {
  const override = process.env.CSUITE_AUTH_CONFIG_PATH;
  if (override !== undefined && override.length > 0) return override;
  return join(defaultStoreDir(), AUTH_FILE);
}

/**
 * Resolve symlinks so a workspace recorded as `/tmp/x` still matches a cwd
 * reported as `/private/tmp/x` (macOS) and vice versa. Best-effort: a path
 * that no longer exists resolves to itself, since a recorded workspace may
 * have been deleted and that must not throw during token lookup.
 */
function canonical(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * True when `child` is `parent` or lives underneath it. Compares resolved
 * paths via `relative()` rather than string prefixes — a raw
 * `startsWith('/home/a/proj')` also matches `/home/a/project-other`, which
 * would hand a command the wrong member's token.
 */
function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Walk up from `start` looking for the closest legacy `.csuite/auth.json`.
 * Returns its path, or null. Retained so an upgrade keeps working; new
 * enrollments never create one.
 */
export function findLegacyAuthPath(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  const root = parsePath(dir).root;
  while (true) {
    const candidate = join(dir, LEGACY_DIR, AUTH_FILE);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Parse a store file's bytes. Unknown / corrupt shapes read as empty. */
function parseStore(raw: string): AuthStoreFile {
  let parsed: Partial<AuthStoreFile>;
  try {
    parsed = JSON.parse(raw) as Partial<AuthStoreFile>;
  } catch {
    return { schema: AUTH_STORE_SCHEMA, entries: [] };
  }
  const schema = parsed.schema === 1 || parsed.schema === 2 ? parsed.schema : null;
  if (schema === null || !Array.isArray(parsed.entries)) {
    // Surface unrecognized state as empty rather than crashing — the next
    // save overwrites it, and a corrupt store must not wedge every command.
    return { schema: AUTH_STORE_SCHEMA, entries: [] };
  }
  const entries: AuthConfigEntry[] = [];
  for (const raw of parsed.entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Partial<AuthConfigEntry>;
    if (typeof e.url !== 'string' || typeof e.token !== 'string') continue;
    if (typeof e.savedAt !== 'number') continue;
    // A schema-1 entry has no workspace; anything non-string is unscoped.
    const workspace =
      typeof e.workspace === 'string' && e.workspace.length > 0 ? e.workspace : null;
    entries.push({ url: e.url, workspace, token: e.token, savedAt: e.savedAt });
  }
  return { schema, entries };
}

/**
 * Read the global store. `path` reads a specific file instead (tests, the
 * `--auth-config` flag). Missing file reads as empty.
 */
export function loadAuthStore(path?: string): AuthStoreFile {
  const resolved = path ?? authStorePath();
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { schema: AUTH_STORE_SCHEMA, entries: [] };
    }
    throw err;
  }
  return parseStore(raw);
}

/**
 * Every entry in the store, most recently saved first. Read-only view for
 * `csuite auth list` — callers render `url` / `workspace` / `savedAt` and
 * never the token.
 */
export function listAuthEntries(path?: string): AuthConfigEntry[] {
  return [...loadAuthStore(path).entries].sort((a, b) => b.savedAt - a.savedAt);
}

export interface FindAuthEntryOptions {
  /** Directory whose enrollment applies. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Read a specific store file instead of the global one. */
  path?: string;
  /**
   * Skip the legacy project-scoped fallback. Used by `auth migrate` so it
   * can tell "found in the global store" from "found only in a legacy
   * file".
   */
  skipLegacy?: boolean;
}

/**
 * Find the token for `url` that applies to `cwd`.
 *
 * Exact URL match (trailing slashes are not normalized here — the SDK
 * Client owns that), then the most specific workspace: among entries whose
 * workspace contains `cwd`, the one with the longest workspace path wins,
 * newest first on a tie. Falls back to an unscoped (`workspace: null`)
 * entry, then to a legacy project-scoped file so an upgrade is seamless.
 */
export function findAuthEntry(
  url: string,
  options: FindAuthEntryOptions = {},
): AuthConfigEntry | null {
  const cwd = canonical(options.cwd ?? process.cwd());
  const matches = loadAuthStore(options.path).entries.filter((e) => e.url === url);

  const scoped = matches
    .filter((e) => e.workspace !== null && containsPath(canonical(e.workspace), cwd))
    .sort((a, b) => {
      const depth =
        canonical(b.workspace as string).length - canonical(a.workspace as string).length;
      return depth !== 0 ? depth : b.savedAt - a.savedAt;
    });
  if (scoped.length > 0) return scoped[0] ?? null;

  const unscoped = matches
    .filter((e) => e.workspace === null)
    .sort((a, b) => b.savedAt - a.savedAt);
  if (unscoped.length > 0) return unscoped[0] ?? null;

  // Explicit store path means "use exactly this file" — don't widen the
  // search to legacy locations the caller didn't ask about.
  if (options.skipLegacy === true || options.path !== undefined) return null;

  const legacy = findLegacyAuthPath(options.cwd ?? process.cwd());
  if (legacy === null) return null;
  const fromLegacy = loadAuthStore(legacy)
    .entries.filter((e) => e.url === url)
    .sort((a, b) => b.savedAt - a.savedAt);
  return fromLegacy[0] ?? null;
}

/**
 * Insert or replace the entry for `(url, workspace)` and write the store
 * back at 0o600, `mkdir -p`-ing the containing dir at 0o700 so a fresh
 * install saves without a setup step.
 *
 * Keyed on the pair, not the URL alone: two workspaces enrolled against the
 * same broker as different members must coexist, which is the whole point
 * of recording the workspace.
 */
export function saveAuthEntry(entry: AuthConfigEntry, path?: string): void {
  const target = path ?? authStorePath();
  const file = loadAuthStore(target);
  const workspace = entry.workspace === null ? null : canonical(entry.workspace);
  const key = entryPairKey(entry.url, workspace);
  const next = file.entries.filter((e) => entryPairKey(e.url, e.workspace) !== key);
  next.push({ ...entry, workspace });
  const out: AuthStoreFile = { schema: AUTH_STORE_SCHEMA, entries: next };
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
}

function normalizeWorkspace(workspace: string | null): string | null {
  return workspace === null ? null : canonical(workspace);
}

/** Store key for an entry — URL plus canonical workspace, the pair we key on. */
function entryPairKey(url: string, workspace: string | null): string {
  return `${url}\0${normalizeWorkspace(workspace) ?? ''}`;
}

export interface LegacyStoreReport {
  /** Path of the legacy `.csuite/auth.json`. */
  path: string;
  /** The workspace it implicitly scopes to — the dir holding `.csuite/`. */
  workspace: string;
  /** How many entries it carries. */
  entries: number;
  /**
   * True when the legacy store sits inside a git working tree, i.e. the
   * token may already be in commit history and wants rotating rather than
   * just moving.
   */
  inGitRepo: boolean;
}

/**
 * Report a legacy project-scoped store discoverable from `cwd`, or null.
 * Read-only — callers decide whether to migrate and what to say about it.
 */
export function inspectLegacyStore(cwd: string = process.cwd()): LegacyStoreReport | null {
  const path = findLegacyAuthPath(cwd);
  if (path === null) return null;
  // `<workspace>/.csuite/auth.json` → the workspace is two levels up.
  const workspace = dirname(dirname(path));
  return {
    path,
    workspace,
    entries: loadAuthStore(path).entries.length,
    inGitRepo: findGitRoot(workspace) !== null,
  };
}

/** Nearest ancestor containing `.git`, or null. */
function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  const root = parsePath(dir).root;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface MigrationResult extends LegacyStoreReport {
  /** Entries folded into the global store. */
  migrated: number;
  /**
   * Entries left where they were because the global store already holds a
   * same-or-newer credential for that `(url, workspace)` pair.
   */
  skipped: number;
}

/**
 * Fold a legacy project-scoped store into the global one, scoping every
 * entry to the directory that held it. Lossless: the legacy file's location
 * IS the workspace the new format records.
 *
 * A legacy entry never displaces a same-or-newer one already in the store.
 * That guard is load-bearing rather than defensive: `csuite connect` saves
 * the token it has just minted and THEN migrates in passing, so on the
 * common upgrade path — re-enrolling in a project that still has a
 * `.csuite/auth.json` for the same broker — the two writes collide on the
 * same `(url, workspace)` key and the stale token would win. The operator
 * would be told the enrollment succeeded while the CLI kept the credential
 * the enrollment was meant to replace. Ties keep the incumbent: the store
 * entry was written later in wall-clock terms even when `savedAt` matches.
 *
 * The legacy file is left on disk — deleting a credential file on the
 * operator's behalf is not ours to do, and if it is in git history the
 * remedy is rotation, not removal. Returns what happened, or null when
 * there was no legacy store to consider.
 */
export function migrateLegacyStore(
  options: { cwd?: string; path?: string } = {},
): MigrationResult | null {
  const cwd = options.cwd ?? process.cwd();
  const report = inspectLegacyStore(cwd);
  if (report === null || report.entries === 0) return null;

  const existing = new Map<string, number>();
  for (const e of loadAuthStore(options.path).entries) {
    existing.set(entryPairKey(e.url, e.workspace), e.savedAt);
  }

  let migrated = 0;
  let skipped = 0;
  for (const entry of loadAuthStore(report.path).entries) {
    const key = entryPairKey(entry.url, report.workspace);
    const incumbent = existing.get(key);
    if (incumbent !== undefined && incumbent >= entry.savedAt) {
      skipped += 1;
      continue;
    }
    saveAuthEntry({ ...entry, workspace: report.workspace }, options.path);
    // Track what we just wrote so a legacy file holding two entries for the
    // same broker resolves to the newer of them rather than the last one.
    existing.set(key, entry.savedAt);
    migrated += 1;
  }
  return { ...report, migrated, skipped };
}
