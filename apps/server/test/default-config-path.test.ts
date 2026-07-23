/**
 * `defaultConfigPath` resolution: explicit env wins; a flat
 * `./csuite.json` marks the cwd as the server directory (legacy
 * layouts + running from inside the dir — the nesting guard);
 * otherwise the `./csuite/` subdirectory is the target, whether it
 * exists yet (discovery from the parent) or not (bootstrap target).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfigPath } from '../src/members.js';

const NO_ENV: NodeJS.ProcessEnv = {};

describe('defaultConfigPath', () => {
  const dirs: string[] = [];
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-config-path-'));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns $CSUITE_CONFIG_PATH verbatim when set', () => {
    const cwd = tempDir();
    expect(defaultConfigPath({ CSUITE_CONFIG_PATH: '/elsewhere/csuite.json' }, cwd)).toBe(
      '/elsewhere/csuite.json',
    );
  });

  it('uses a flat ./csuite.json when the cwd is the server directory', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'csuite.json'), '{}');
    expect(defaultConfigPath(NO_ENV, cwd)).toBe(join(cwd, 'csuite.json'));
  });

  it('targets ./csuite/csuite.json when nothing exists (bootstrap)', () => {
    const cwd = tempDir();
    expect(defaultConfigPath(NO_ENV, cwd)).toBe(join(cwd, 'csuite', 'csuite.json'));
  });

  it('discovers an existing ./csuite/ subdirectory from the parent', () => {
    const cwd = tempDir();
    const nested = join(cwd, 'csuite');
    mkdirAndSeed(nested);
    expect(defaultConfigPath(NO_ENV, cwd)).toBe(join(nested, 'csuite.json'));
  });

  it('never nests: from inside a seeded server dir the flat file wins', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'csuite.json'), '{}');
    // Even with a stray ./csuite/ subdir present, the flat file wins.
    mkdirAndSeed(join(cwd, 'csuite'));
    expect(defaultConfigPath(NO_ENV, cwd)).toBe(join(cwd, 'csuite.json'));
  });
});

function mkdirAndSeed(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'csuite.json'), '{}');
}
