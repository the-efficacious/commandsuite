/**
 * Discriminating tests for the stale-`dist` guard.
 *
 * Each case builds a real package tree on disk and runs it through BOTH
 * the shipped `checkPackage` and a reference mtime implementation. The
 * point is not that the shipped one passes — it is that the mtime one
 * FAILS each case, because "compare timestamps" is the obvious
 * implementation and the one a future reader will reach for.
 *
 * Without `mtimeCheck` here these would be three tests that a timestamp
 * comparison also satisfies, and they would prove nothing about why the
 * guard is built the way it is.
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkPackage } from '../assert-fresh-dist.mjs';
import { hashSourceTree, STAMP_FILENAME } from '../dist-stamp.mjs';

const trees = [];
afterEach(() => {
  for (const dir of trees.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The implementation this guard deliberately is not: newest src vs oldest dist. */
function mtimeCheck(dir) {
  const newest = (sub) => {
    let max = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else max = Math.max(max, statSync(join(d, e.name)).mtimeMs);
      }
    };
    walk(join(dir, sub));
    return max;
  };
  return newest('src') > newest('dist') ? 'stale' : null;
}

function makePackage({ sources, distFiles, stampFrom = sources, srcTime, distTime }) {
  const dir = mkdtempSync(join(tmpdir(), 'freshdist-'));
  trees.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'pkg', scripts: { build: 'x' } }),
  );
  for (const [name, body] of Object.entries(sources)) writeFileSync(join(dir, 'src', name), body);
  for (const [name, body] of Object.entries(distFiles))
    writeFileSync(join(dir, 'dist', name), body);

  if (stampFrom !== null) {
    // Stamp reflects a DIFFERENT source set when stampFrom differs — that is
    // how we model "dist was built from something else".
    const digest = createHash('sha256');
    for (const name of Object.keys(stampFrom).sort()) {
      digest.update(name);
      digest.update('\0');
      digest.update(stampFrom[name]);
      digest.update('\0');
    }
    writeFileSync(
      join(dir, 'dist', STAMP_FILENAME),
      JSON.stringify({ hash: digest.digest('hex'), fileCount: Object.keys(stampFrom).length }),
    );
  }

  const touch = (sub, when) => {
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else utimesSync(join(d, e.name), when, when);
      }
    };
    walk(join(dir, sub));
  };
  if (distTime !== undefined) touch('dist', distTime);
  if (srcTime !== undefined) touch('src', srcTime);
  return dir;
}

const T0 = 1_700_000_000; // "built"
const T1 = 1_700_009_999; // "later"

describe('stale-dist guard — cases a timestamp implementation gets wrong', () => {
  it('case 1: a branch switch refreshes src mtime with identical content — mtime refuses a good tree', () => {
    const sources = { 'a.ts': 'export const a = 1\n' };
    // dist built from exactly these sources; then git rewrites src on a
    // branch switch away and back, giving it a newer mtime, same bytes.
    const dir = makePackage({
      sources,
      distFiles: { 'a.js': 'a' },
      stampFrom: sources,
      distTime: T0,
      srcTime: T1,
    });

    expect(checkPackage(dir), 'content is identical — the tree is genuinely fine').toBeNull();
    expect(
      mtimeCheck(dir),
      'the mtime implementation refuses it — the failure that gets guards disabled',
    ).toBe('stale');
  });

  it('case 2: a deleted source file — no timestamp scheme can detect this', () => {
    // Built from {a,b}; b.ts is then deleted without a rebuild, so
    // dist/b.js survives. Deleting a file makes NOTHING newer.
    const built = { 'a.ts': 'export const a = 1\n', 'b.ts': 'export const b = 2\n' };
    const dir = makePackage({
      sources: { 'a.ts': built['a.ts'] },
      distFiles: { 'a.js': 'a', 'b.js': 'b' },
      stampFrom: built,
      srcTime: T0,
      distTime: T1,
    });

    expect(
      mtimeCheck(dir),
      'dist is newer than every surviving source, so mtime sees nothing',
    ).toBeNull();
    const problem = checkPackage(dir);
    expect(
      problem,
      'a timestamp implementation returns null here — that is the whole point',
    ).not.toBeNull();
    expect(problem, 'the source SET changed, so the hash differs').toMatch(
      /built from different sources/,
    );
  });

  it('case 3: a build that failed partway — fresh files, no successful stamp', () => {
    // tsc emitted some output and then errored, so dist/ is newer than
    // src/ but never corresponded to a completed build.
    const dir = makePackage({
      sources: { 'a.ts': 'export const a = 1\n' },
      distFiles: { 'a.js': 'partial' },
      stampFrom: null, // stamp is written only on build success
      srcTime: T0,
      distTime: T1,
    });

    expect(mtimeCheck(dir), 'dist is newer, so mtime accepts a half-written build').toBeNull();
    const problem = checkPackage(dir);
    expect(
      problem,
      'a timestamp implementation returns null here — that is the whole point',
    ).not.toBeNull();
    expect(problem, 'no stamp means no build ever completed here').toMatch(/no build stamp/);
  });
});

describe('stale-dist guard — the cases it must NOT refuse', () => {
  it('accepts a package whose dist matches its src', () => {
    const sources = { 'a.ts': 'export const a = 1\n' };
    const dir = makePackage({ sources, distFiles: { 'a.js': 'a' }, stampFrom: sources });
    expect(checkPackage(dir)).toBeNull();
  });

  it('skips a package with no build script rather than demanding a dist', () => {
    // csuite-web-ui exports ./src/index.ts directly and has no dist/.
    const dir = mkdtempSync(join(tmpdir(), 'freshdist-'));
    trees.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'no-build', scripts: {} }));
    expect(checkPackage(dir), 'no build script means no dist is expected').toBeNull();
  });

  it('hashes the source SET, so a rename alone changes the hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'freshdist-'));
    trees.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'x\n');
    const before = hashSourceTree(dir).hash;
    rmSync(join(dir, 'src', 'a.ts'));
    writeFileSync(join(dir, 'src', 'b.ts'), 'x\n'); // same bytes, different path
    expect(hashSourceTree(dir).hash, 'path is part of the digest').not.toBe(before);
  });
});
