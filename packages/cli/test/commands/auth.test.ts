/**
 * `csuite auth` tests.
 *
 * Two things matter here and the rest is formatting. First: a token must
 * never reach stdout or stderr — the command exists so an operator can
 * answer "which member am I here?" without putting a bearer on a terminal
 * that may be recorded or scrolled back. Second: the `*` marker must agree
 * with what the CLI would actually resolve, because a marker that disagrees
 * with resolution is worse than no marker at all.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAuthCommand } from '../../src/commands/auth.js';
import { saveAuthEntry } from '../../src/commands/auth-config.js';
import { UsageError } from '../../src/commands/errors.js';

const URL_A = 'http://broker-a:8717';
const URL_B = 'https://broker-b.example';
const TOKEN_A = 'csuite_secret_token_aaa';
const TOKEN_B = 'csuite_secret_token_bbb';
const NOW = 1_800_000_000_000;

let sandbox: string;
let storePath: string;
let out: string[];
let err: string[];

const stdout = (line: string): void => {
  out.push(line);
};
const stderr = (line: string): void => {
  err.push(line);
};

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'csuite-authcmd-'));
  storePath = join(sandbox, 'store', 'auth.json');
  out = [];
  err = [];
});

afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

function dir(...parts: string[]): string {
  const path = join(sandbox, ...parts);
  mkdirSync(path, { recursive: true });
  return resolve(path);
}

function save(url: string, workspace: string | null, token: string, savedAt = NOW - 60_000): void {
  saveAuthEntry({ url, workspace, token, savedAt }, storePath);
}

function run(sub: string | undefined, cwd: string): number {
  return runAuthCommand(sub, { authConfigPath: storePath, cwd, now: () => NOW }, stdout, stderr);
}

describe('auth list', () => {
  it('reports an empty store without failing', () => {
    const code = run('list', sandbox);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('no enrollments');
  });

  it('defaults to list when no subcommand is given', () => {
    expect(run(undefined, sandbox)).toBe(0);
    expect(out.join('\n')).toContain('no enrollments');
  });

  it('never prints a token', () => {
    const ws = dir('proj');
    save(URL_A, ws, TOKEN_A);
    save(URL_B, null, TOKEN_B);
    run('list', ws);
    const everything = [...out, ...err].join('\n');
    expect(everything).not.toContain(TOKEN_A);
    expect(everything).not.toContain(TOKEN_B);
    expect(everything).not.toContain('csuite_secret');
  });

  it('shows the broker and the workspace scope', () => {
    const ws = dir('proj');
    save(URL_A, ws, TOKEN_A);
    run('list', ws);
    const text = out.join('\n');
    expect(text).toContain(URL_A);
    expect(text).toContain(ws);
  });

  it('renders an unscoped entry as all directories', () => {
    save(URL_A, null, TOKEN_A);
    run('list', sandbox);
    expect(out.join('\n')).toContain('(all directories)');
  });

  it('marks the entry that resolves from cwd, and only that one', () => {
    const a = dir('agent-a');
    const b = dir('agent-b');
    save(URL_A, a, TOKEN_A);
    save(URL_A, b, TOKEN_B);
    run('list', a);
    const marked = out.filter((l) => l.startsWith('*'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain(a);
    expect(marked[0]).not.toContain(b);
  });

  it('marks the most specific workspace when nested ones both match', () => {
    const outer = dir('proj');
    const inner = dir('proj', 'nested');
    save(URL_A, outer, TOKEN_A);
    save(URL_A, inner, TOKEN_B);
    run('list', inner);
    const marked = out.filter((l) => l.startsWith('*'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain(inner);
  });

  it('marks one entry per broker', () => {
    const ws = dir('proj');
    save(URL_A, ws, TOKEN_A);
    save(URL_B, ws, TOKEN_B);
    run('list', ws);
    expect(out.filter((l) => l.startsWith('*'))).toHaveLength(2);
  });

  it('marks nothing when no entry applies to cwd', () => {
    save(URL_A, dir('proj'), TOKEN_A);
    run('list', dir('elsewhere'));
    expect(out.filter((l) => l.startsWith('*'))).toHaveLength(0);
  });

  it('renders ages coarsely', () => {
    save(URL_A, null, TOKEN_A, NOW - 3 * 86_400_000);
    run('list', sandbox);
    expect(out.join('\n')).toContain('3d ago');
  });

  it('surfaces a legacy store with a migrate hint', () => {
    const ws = dir('legacy');
    mkdirSync(join(ws, '.csuite'), { recursive: true });
    writeFileSync(
      join(ws, '.csuite', 'auth.json'),
      JSON.stringify({ schema: 1, entries: [{ url: URL_A, token: TOKEN_A, savedAt: NOW }] }),
    );
    run('list', ws);
    const text = out.join('\n');
    expect(text).toContain('legacy store found');
    expect(text).toContain('csuite auth migrate');
    expect(text).not.toContain(TOKEN_A);
  });

  it('warns when the legacy store is inside a git working tree', () => {
    const ws = dir('repo');
    mkdirSync(join(ws, '.git'), { recursive: true });
    mkdirSync(join(ws, '.csuite'), { recursive: true });
    writeFileSync(
      join(ws, '.csuite', 'auth.json'),
      JSON.stringify({ schema: 1, entries: [{ url: URL_A, token: TOKEN_A, savedAt: NOW }] }),
    );
    run('list', ws);
    expect(out.join('\n')).toContain('git working tree');
  });
});

describe('auth migrate', () => {
  function writeLegacy(ws: string, git: boolean): void {
    if (git) mkdirSync(join(ws, '.git'), { recursive: true });
    mkdirSync(join(ws, '.csuite'), { recursive: true });
    writeFileSync(
      join(ws, '.csuite', 'auth.json'),
      JSON.stringify({ schema: 1, entries: [{ url: URL_A, token: TOKEN_A, savedAt: NOW }] }),
    );
  }

  it('reports nothing to do on a clean tree', () => {
    expect(run('migrate', dir('clean'))).toBe(0);
    expect(out.join('\n')).toContain('nothing to migrate');
  });

  it('migrates and names the scope it applied', () => {
    const ws = dir('legacy');
    writeLegacy(ws, false);
    expect(run('migrate', ws)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('migrated 1');
    expect(text).toContain(ws);
    expect(text).toContain('safe to delete');
  });

  it('tells the operator to rotate when the legacy store was in a repo', () => {
    const ws = dir('repo');
    writeLegacy(ws, true);
    run('migrate', ws);
    const errText = err.join('\n');
    expect(errText).toContain('git history');
    expect(errText).toContain('csuite rotate');
    // Rotation, not deletion — the token may already be published.
    expect(out.join('\n')).not.toContain('safe to delete');
  });

  it('never prints the token it migrated', () => {
    const ws = dir('legacy');
    writeLegacy(ws, false);
    run('migrate', ws);
    expect([...out, ...err].join('\n')).not.toContain(TOKEN_A);
  });
});

describe('dispatch', () => {
  it('raises UsageError on an unknown subcommand', () => {
    expect(() => run('nope', sandbox)).toThrow(UsageError);
  });
});
