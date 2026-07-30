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

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import setup, { checkPackage } from '../assert-fresh-dist.mjs';
import { hashSourceTree, STAMP_FILENAME } from '../dist-stamp.mjs';

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(SCRIPTS_DIR, '..');

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

  it('distinguishes never-built from build-broke from out-of-date', () => {
    const sources = { 'a.ts': 'x\n' };
    const noDist = makePackage({ sources, distFiles: {}, stampFrom: sources });
    rmSync(join(noDist, 'dist'), { recursive: true });
    expect(checkPackage(noDist)).toMatch(/no dist\/ — the package has not been built/);

    const emptyDist = mkdtempSync(join(tmpdir(), 'freshdist-'));
    trees.push(emptyDist);
    mkdirSync(join(emptyDist, 'src'), { recursive: true });
    mkdirSync(join(emptyDist, 'dist'), { recursive: true });
    writeFileSync(join(emptyDist, 'src', 'a.ts'), 'x\n');
    writeFileSync(
      join(emptyDist, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { build: 'x' } }),
    );
    expect(checkPackage(emptyDist), 'an empty dist is "not built", not "broken"').toMatch(
      /dist\/ is empty — the package has not been built/,
    );

    const brokeMidway = makePackage({ sources, distFiles: { 'a.js': 'partial' }, stampFrom: null });
    expect(checkPackage(brokeMidway)).toMatch(/no build stamp — a build that did not finish/);
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

/**
 * Launcher independence. The guard originally derived the project from
 * `process.cwd()`, which is a property of the SHELL rather than of the
 * project under test. `vitest --root apps/server` launched from the repo
 * root therefore checked the ROOT's dependencies — of which there are
 * none — and ran 27 real tests against a stale `csuite-core`.
 *
 * These spawn vitest for real, from a directory that is NOT the project
 * root, because that gap is invisible to any in-process test: calling
 * `setup()` directly cannot reproduce a cwd/root divergence that only a
 * launcher creates.
 *
 * The passing case is not decoration. Without it these would be
 * satisfied by a fixture that fails to start vitest at all — a non-zero
 * exit proves nothing on its own.
 */
describe('launcher independence — cwd is not the project', () => {
  function fixtureWorkspace({ stampMatches }) {
    const root = mkdtempSync(join(tmpdir(), 'freshdist-ws-'));
    trees.push(root);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'packages', 'dep', 'src'), { recursive: true });
    mkdirSync(join(root, 'packages', 'dep', 'dist'), { recursive: true });
    mkdirSync(join(root, 'packages', 'consumer', 'test'), { recursive: true });

    // The guard resolves its repo root from its own location, so copying
    // it in makes the fixture a self-contained workspace.
    for (const f of ['dist-stamp.mjs', 'assert-fresh-dist.mjs']) {
      copyFileSync(join(SCRIPTS_DIR, f), join(root, 'scripts', f));
    }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixroot', private: true }));

    const dep = join(root, 'packages', 'dep');
    writeFileSync(
      join(dep, 'package.json'),
      JSON.stringify({ name: 'fixdep', scripts: { build: 'x' } }),
    );
    writeFileSync(join(dep, 'src', 'a.ts'), 'export const a = 1\n');
    writeFileSync(join(dep, 'dist', 'a.js'), 'a');
    const hash = stampMatches ? hashSourceTree(dep).hash : 'deadbeef';
    writeFileSync(join(dep, 'dist', STAMP_FILENAME), JSON.stringify({ hash, fileCount: 1 }));

    const consumer = join(root, 'packages', 'consumer');
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'fixconsumer', dependencies: { fixdep: 'workspace:*' } }),
    );
    writeFileSync(
      join(consumer, 'vitest.config.mjs'),
      "export default { test: { globals: true, globalSetup: ['../../scripts/assert-fresh-dist.mjs'], include: ['test/**/*.test.mjs'] } };\n",
    );
    writeFileSync(
      join(consumer, 'test', 'x.test.mjs'),
      'it("runs", () => { expect(1).toBe(1); });\n',
    );
    return root;
  }

  /** Launch vitest from `root`, pointed at the consumer package. cwd !== project root. */
  function runFromRoot(root) {
    return spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        '--root',
        join('packages', 'consumer'),
        '--config',
        'vitest.config.mjs',
        'run',
      ],
      { cwd: root, encoding: 'utf8', timeout: 90_000 },
    );
  }

  it('refuses a stale dependency when launched from outside the project', () => {
    const result = runFromRoot(fixtureWorkspace({ stampMatches: false }));
    const output = `${result.stdout}${result.stderr}`;
    expect(output, 'the guard must name the stale package').toMatch(/fixdep: dist\//);
    expect(output).toMatch(/Refusing to run/);
    expect(result.status, 'a refused run must not exit zero').not.toBe(0);
  });

  it('fails closed when the project root cannot be determined', () => {
    // If a vitest upgrade changes the globalSetup context shape, the
    // guard must refuse rather than quietly fall back to process.cwd()
    // — which is exactly the bypass this section exists to prevent, and
    // it would return silently instead of failing.
    expect(() => setup(undefined)).toThrow(/could not determine the vitest project root/);
    expect(() => setup({})).toThrow(/could not determine the vitest project root/);
  });

  // NOTE — there is deliberately no in-process version of the refusal
  // test above. `assert-fresh-dist.mjs` resolves the workspace from its
  // OWN file location, so an imported copy always scans the real
  // `packages/`/`apps/` and can never see a fixture. Calling `setup()`
  // with a fixture root returns cleanly because the fixture's dependency
  // is not a real workspace package — it looks like a pass and proves
  // nothing. That is why the test above spawns vitest with the scripts
  // copied INTO the fixture, and why cwd/root divergence can only be
  // exercised by a real launcher.

  it('runs the suite normally when the dependency is fresh', () => {
    // Proves the fixture can actually start vitest, so the refusal above
    // is the guard firing and not the harness failing to launch.
    const result = runFromRoot(fixtureWorkspace({ stampMatches: true }));
    const output = `${result.stdout}${result.stderr}`;
    expect(output, 'the fixture suite must really execute').toMatch(/1 passed/);
    expect(output).not.toMatch(/Refusing to run/);
    expect(result.status).toBe(0);
  });
});
