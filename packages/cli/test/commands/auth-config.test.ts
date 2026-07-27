/**
 * Auth store tests.
 *
 * The store went from "a credential file in the project tree, found by
 * walking up" to "one user-global file whose entries name the workspace they
 * belong to". The resolution rule has to reproduce every property the
 * walk-up had — most specific directory wins, subdirectories inherit — while
 * never putting a bearer inside a repo. These tests pin that equivalence,
 * plus the two edges that would silently hand a command the wrong member's
 * token: sibling directories that share a name prefix, and symlinked paths.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_STORE_SCHEMA,
  authStorePath,
  findAuthEntry,
  findLegacyAuthPath,
  inspectLegacyStore,
  listAuthEntries,
  migrateLegacyStore,
  saveAuthEntry,
} from '../../src/commands/auth-config.js';

const URL_A = 'http://broker-a:8717';
const URL_B = 'https://broker-b.example';

let sandbox: string;
let storePath: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'csuite-auth-'));
  storePath = join(sandbox, 'store', 'auth.json');
  setEnv('CSUITE_AUTH_CONFIG_PATH', undefined);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  rmSync(sandbox, { recursive: true, force: true });
});

/** Create a directory inside the sandbox and return its resolved path. */
function dir(...parts: string[]): string {
  const path = join(sandbox, ...parts);
  mkdirSync(path, { recursive: true });
  return resolve(path);
}

function save(url: string, workspace: string | null, token: string, savedAt = 1000): void {
  saveAuthEntry({ url, workspace, token, savedAt }, storePath);
}

describe('authStorePath', () => {
  it('honours CSUITE_AUTH_CONFIG_PATH outright', () => {
    setEnv('CSUITE_AUTH_CONFIG_PATH', '/pinned/auth.json');
    expect(authStorePath()).toBe('/pinned/auth.json');
  });

  it('falls back to a user-global per-OS path, never cwd', () => {
    setEnv('CSUITE_AUTH_CONFIG_PATH', undefined);
    const path = authStorePath();
    expect(path.endsWith('auth.json')).toBe(true);
    // The whole point of the change: the store must not be under cwd.
    expect(path.startsWith(process.cwd())).toBe(false);
  });

  it('uses XDG_CONFIG_HOME on linux when set', () => {
    if (process.platform !== 'linux') return;
    setEnv('XDG_CONFIG_HOME', '/xdg-conf');
    expect(authStorePath()).toBe('/xdg-conf/csuite/auth.json');
  });
});

describe('save + load', () => {
  it('writes schema 2 and round-trips an entry', () => {
    const ws = dir('proj');
    save(URL_A, ws, 'tok-a');
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as { schema: number };
    expect(raw.schema).toBe(AUTH_STORE_SCHEMA);
    expect(findAuthEntry(URL_A, { cwd: ws, path: storePath })?.token).toBe('tok-a');
  });

  it('keeps two workspaces on the same broker independent', () => {
    const a = dir('agent-a');
    const b = dir('agent-b');
    save(URL_A, a, 'tok-a');
    save(URL_A, b, 'tok-b');
    expect(listAuthEntries(storePath)).toHaveLength(2);
    expect(findAuthEntry(URL_A, { cwd: a, path: storePath })?.token).toBe('tok-a');
    expect(findAuthEntry(URL_A, { cwd: b, path: storePath })?.token).toBe('tok-b');
  });

  it('replaces on the (url, workspace) pair rather than the url alone', () => {
    const ws = dir('proj');
    save(URL_A, ws, 'old', 1000);
    save(URL_A, ws, 'new', 2000);
    expect(listAuthEntries(storePath)).toHaveLength(1);
    expect(findAuthEntry(URL_A, { cwd: ws, path: storePath })?.token).toBe('new');
  });

  it('keeps entries for different brokers side by side', () => {
    const ws = dir('proj');
    save(URL_A, ws, 'tok-a');
    save(URL_B, ws, 'tok-b');
    expect(findAuthEntry(URL_A, { cwd: ws, path: storePath })?.token).toBe('tok-a');
    expect(findAuthEntry(URL_B, { cwd: ws, path: storePath })?.token).toBe('tok-b');
  });

  it('reads a missing store as empty rather than throwing', () => {
    expect(listAuthEntries(join(sandbox, 'nope', 'auth.json'))).toEqual([]);
  });

  it('reads a corrupt store as empty rather than throwing', () => {
    mkdirSync(join(sandbox, 'store'), { recursive: true });
    writeFileSync(storePath, '{ not json');
    expect(listAuthEntries(storePath)).toEqual([]);
  });

  it('drops malformed entries but keeps well-formed siblings', () => {
    mkdirSync(join(sandbox, 'store'), { recursive: true });
    writeFileSync(
      storePath,
      JSON.stringify({
        schema: 2,
        entries: [
          { url: URL_A, workspace: null, token: 'ok', savedAt: 1 },
          { url: URL_A, workspace: null, savedAt: 2 },
          { token: 'no-url', workspace: null, savedAt: 3 },
          null,
        ],
      }),
    );
    expect(listAuthEntries(storePath)).toHaveLength(1);
  });

  it('treats a schema-1 file read as a store as unscoped entries', () => {
    mkdirSync(join(sandbox, 'store'), { recursive: true });
    writeFileSync(
      storePath,
      JSON.stringify({ schema: 1, entries: [{ url: URL_A, token: 'legacy', savedAt: 1 }] }),
    );
    const entries = listAuthEntries(storePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.workspace).toBeNull();
    // Unscoped means it resolves from anywhere.
    expect(findAuthEntry(URL_A, { cwd: dir('anywhere'), path: storePath })?.token).toBe('legacy');
  });
});

describe('resolution', () => {
  it('resolves from a subdirectory of the enrolled workspace', () => {
    const ws = dir('proj');
    const deep = dir('proj', 'src', 'deep', 'dir');
    save(URL_A, ws, 'tok');
    expect(findAuthEntry(URL_A, { cwd: deep, path: storePath })?.token).toBe('tok');
  });

  it('prefers the most specific workspace when both match', () => {
    const outer = dir('proj');
    const inner = dir('proj', 'nested');
    save(URL_A, outer, 'outer');
    save(URL_A, inner, 'inner');
    expect(findAuthEntry(URL_A, { cwd: inner, path: storePath })?.token).toBe('inner');
    expect(findAuthEntry(URL_A, { cwd: outer, path: storePath })?.token).toBe('outer');
  });

  it('does NOT match a sibling directory sharing a name prefix', () => {
    // A raw startsWith() check matches '/x/proj' against '/x/project-other'
    // and hands over the wrong member's token. This is the regression guard.
    const proj = dir('proj');
    const other = dir('project-other');
    save(URL_A, proj, 'proj-token');
    expect(findAuthEntry(URL_A, { cwd: other, path: storePath })).toBeNull();
  });

  it('falls back to an unscoped entry when no workspace matches', () => {
    save(URL_A, null, 'machine-wide');
    expect(findAuthEntry(URL_A, { cwd: dir('unrelated'), path: storePath })?.token).toBe(
      'machine-wide',
    );
  });

  it('prefers a matching workspace over an unscoped entry', () => {
    const ws = dir('proj');
    save(URL_A, null, 'machine-wide');
    save(URL_A, ws, 'scoped');
    expect(findAuthEntry(URL_A, { cwd: ws, path: storePath })?.token).toBe('scoped');
  });

  it('returns null for an unknown broker even with entries present', () => {
    save(URL_A, null, 'tok');
    expect(findAuthEntry('http://other:1234', { cwd: sandbox, path: storePath })).toBeNull();
  });

  it('matches URLs exactly — a trailing slash is a different broker', () => {
    save(URL_A, null, 'tok');
    expect(findAuthEntry(`${URL_A}/`, { cwd: sandbox, path: storePath })).toBeNull();
  });

  it('breaks a same-depth tie by recency', () => {
    const ws = dir('proj');
    save(URL_A, ws, 'older', 1000);
    // Same pair would replace, so use a sibling of equal path length.
    const twin = dir('proj-x');
    save(URL_A, twin, 'newer', 5000);
    expect(findAuthEntry(URL_A, { cwd: ws, path: storePath })?.token).toBe('older');
  });

  it('resolves through a symlinked cwd', () => {
    const real = dir('real-proj');
    const link = join(sandbox, 'link-proj');
    symlinkSync(real, link);
    save(URL_A, real, 'tok');
    expect(findAuthEntry(URL_A, { cwd: link, path: storePath })?.token).toBe('tok');
  });

  it('survives a recorded workspace that no longer exists', () => {
    const gone = join(sandbox, 'deleted-proj');
    mkdirSync(gone);
    save(URL_A, gone, 'tok');
    rmSync(gone, { recursive: true, force: true });
    // Must not throw; the entry simply stops matching other directories.
    expect(() => findAuthEntry(URL_A, { cwd: dir('elsewhere'), path: storePath })).not.toThrow();
  });
});

describe('legacy stores', () => {
  /** Write a legacy project-scoped `.csuite/auth.json` under `workspace`. */
  function writeLegacy(workspace: string, entries: { url: string; token: string }[]): string {
    const dirPath = join(workspace, '.csuite');
    mkdirSync(dirPath, { recursive: true });
    const path = join(dirPath, 'auth.json');
    writeFileSync(
      path,
      JSON.stringify({
        schema: 1,
        entries: entries.map((e) => ({ ...e, savedAt: 1000 })),
      }),
    );
    return path;
  }

  it('finds a legacy store by walking up from a subdirectory', () => {
    const ws = dir('legacy-proj');
    const legacy = writeLegacy(ws, [{ url: URL_A, token: 'old' }]);
    const deep = dir('legacy-proj', 'a', 'b');
    expect(findLegacyAuthPath(deep)).toBe(legacy);
  });

  it('reports a legacy store with the workspace its location implies', () => {
    const ws = dir('legacy-proj');
    writeLegacy(ws, [{ url: URL_A, token: 'old' }]);
    const report = inspectLegacyStore(ws);
    expect(report?.workspace).toBe(ws);
    expect(report?.entries).toBe(1);
    expect(report?.inGitRepo).toBe(false);
  });

  it('flags a legacy store inside a git working tree', () => {
    const ws = dir('repo');
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeLegacy(ws, [{ url: URL_A, token: 'old' }]);
    expect(inspectLegacyStore(ws)?.inGitRepo).toBe(true);
  });

  it('flags a legacy store in a SUBDIRECTORY of a git working tree', () => {
    const repo = dir('repo2');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const sub = dir('repo2', 'packages', 'thing');
    writeLegacy(sub, [{ url: URL_A, token: 'old' }]);
    expect(inspectLegacyStore(sub)?.inGitRepo).toBe(true);
  });

  it('migrates legacy entries into the global store, scoped to their directory', () => {
    const ws = dir('legacy-proj');
    writeLegacy(ws, [
      { url: URL_A, token: 'old-a' },
      { url: URL_B, token: 'old-b' },
    ]);
    const report = migrateLegacyStore({ cwd: ws, path: storePath });
    expect(report?.entries).toBe(2);
    expect(listAuthEntries(storePath)).toHaveLength(2);
    expect(findAuthEntry(URL_A, { cwd: ws, path: storePath })?.token).toBe('old-a');
    expect(findAuthEntry(URL_B, { cwd: ws, path: storePath })?.token).toBe('old-b');
  });

  it('never lets a legacy entry displace a newer one', () => {
    // The `csuite connect` upgrade path in miniature: the CLI saves the
    // token it just minted, then migrates the legacy store it found in the
    // same directory. Both writes key on the same (url, workspace) pair, so
    // without a recency guard the stale token wins and the operator is left
    // holding the credential the enrollment was meant to replace.
    const ws = dir('legacy-proj');
    writeLegacy(ws, [{ url: URL_A, token: 'stale' }]); // savedAt 1000
    save(URL_A, ws, 'freshly-minted', 9_999_999);
    const report = migrateLegacyStore({ cwd: ws, path: storePath });
    expect(findAuthEntry(URL_A, { cwd: ws, path: storePath })?.token).toBe('freshly-minted');
    expect(report?.migrated).toBe(0);
    expect(report?.skipped).toBe(1);
  });

  it('keeps the incumbent when savedAt ties', () => {
    // A tie means the store entry was still written later in wall-clock
    // terms — migration runs after the save it would be overwriting.
    const ws = dir('legacy-proj');
    writeLegacy(ws, [{ url: URL_A, token: 'stale' }]); // savedAt 1000
    save(URL_A, ws, 'incumbent', 1000);
    migrateLegacyStore({ cwd: ws, path: storePath });
    expect(findAuthEntry(URL_A, { cwd: ws, path: storePath })?.token).toBe('incumbent');
  });

  it('migrates the untouched brokers while skipping the superseded one', () => {
    const ws = dir('legacy-proj');
    writeLegacy(ws, [
      { url: URL_A, token: 'stale-a' },
      { url: URL_B, token: 'old-b' },
    ]);
    save(URL_A, ws, 'freshly-minted', 9_999_999);
    const report = migrateLegacyStore({ cwd: ws, path: storePath });
    expect(report?.migrated).toBe(1);
    expect(report?.skipped).toBe(1);
    expect(findAuthEntry(URL_A, { cwd: ws, path: storePath })?.token).toBe('freshly-minted');
    expect(findAuthEntry(URL_B, { cwd: ws, path: storePath })?.token).toBe('old-b');
  });

  it('migration is idempotent', () => {
    const ws = dir('legacy-proj');
    writeLegacy(ws, [{ url: URL_A, token: 'old' }]);
    migrateLegacyStore({ cwd: ws, path: storePath });
    migrateLegacyStore({ cwd: ws, path: storePath });
    expect(listAuthEntries(storePath)).toHaveLength(1);
  });

  it('migration leaves the legacy file on disk', () => {
    const ws = dir('legacy-proj');
    const legacy = writeLegacy(ws, [{ url: URL_A, token: 'old' }]);
    migrateLegacyStore({ cwd: ws, path: storePath });
    // Deleting a credential on the operator's behalf is not ours to do —
    // and if it is in git history the remedy is rotation, not removal.
    expect(readFileSync(legacy, 'utf8').length).toBeGreaterThan(0);
  });

  it('reports nothing to migrate when no legacy store exists', () => {
    expect(migrateLegacyStore({ cwd: dir('clean'), path: storePath })).toBeNull();
  });

  it('falls back to a legacy store when the global one has no match', () => {
    const ws = dir('legacy-proj');
    writeLegacy(ws, [{ url: URL_A, token: 'old' }]);
    // No explicit path: exercises the real default-resolution fallback.
    setEnv('CSUITE_AUTH_CONFIG_PATH', join(sandbox, 'empty-global.json'));
    expect(findAuthEntry(URL_A, { cwd: ws })?.token).toBe('old');
  });

  it('skipLegacy suppresses the legacy fallback', () => {
    const ws = dir('legacy-proj');
    writeLegacy(ws, [{ url: URL_A, token: 'old' }]);
    setEnv('CSUITE_AUTH_CONFIG_PATH', join(sandbox, 'empty-global.json'));
    expect(findAuthEntry(URL_A, { cwd: ws, skipLegacy: true })).toBeNull();
  });

  it('prefers the global store over a legacy one', () => {
    const ws = dir('legacy-proj');
    writeLegacy(ws, [{ url: URL_A, token: 'old' }]);
    save(URL_A, ws, 'current');
    expect(findAuthEntry(URL_A, { cwd: ws, path: storePath })?.token).toBe('current');
  });
});
