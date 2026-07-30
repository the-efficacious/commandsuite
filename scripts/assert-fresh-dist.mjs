/**
 * Vitest `globalSetup` that refuses to run tests against a stale build.
 *
 * WHY THIS LIVES IN VITEST rather than in a launcher script: it cannot
 * then be bypassed by changing how vitest is started. Root `pnpm test`,
 * `pnpm --filter <pkg> exec vitest run`, an IDE's test runner and a bare
 * `npx vitest` all execute `globalSetup`. Turbo's `dependsOn: ["^build"]`
 * protects the first of those and none of the rest — measured: touching
 * `packages/core/src/trace/redact.ts` and running the server auth suite
 * through a filtered invocation gave 27 passing tests with
 * `packages/core/dist/index.js`'s mtime unmoved.
 *
 * DOMAIN, stated rather than implied: vitest-launched runs, and only
 * those. An ad-hoc `node` script importing `packages/core/dist/index.js`
 * never reaches this code. That gap is covered by the reporting
 * practice — state the object with the result — not by more machinery
 * here.
 *
 * This checks that `dist/` corresponds to `src/`. It does NOT check that
 * the build is correct. That is what the tests importing a workspace
 * package BY NAME are for: they are the only thing exercising the
 * `exports` map, the `files` list and the emitted `.d.ts` against what a
 * consumer actually receives. Do not "tidy" those into a vitest alias
 * onto `src/` — see the rejection recorded in
 * `/Cora/deliverables/proposal-test-artifact-resolution.md`. The alias
 * makes staleness unrepresentable in four lines and silently deletes the
 * only check we have on the published artifact.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasDist, hashSourceTree, isBuildable, readStamp } from './dist-stamp.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_ROOTS = ['packages', 'apps'];

function workspacePackages() {
  const found = [];
  for (const group of PACKAGE_ROOTS) {
    let entries;
    try {
      entries = readdirSync(join(REPO_ROOT, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(REPO_ROOT, group, entry.name);
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        found.push({ name: pkg.name, dir });
      } catch {
        // not a package
      }
    }
  }
  return found;
}

/**
 * Check one package directory. Returns a problem string, or null when
 * `dist/` corresponds to `src/`.
 *
 * Takes a directory rather than reading the workspace so the three
 * discriminating cases can be built as real trees on disk and run
 * through this exact function — see `scripts/test/fresh-dist.test.mjs`.
 * A guard tested only against the repo it ships in is tested against one
 * state.
 *
 * Packages with no `build` script return null: `csuite-web-ui` exports
 * `./src/index.ts` directly and has no `dist/` by design, so requiring
 * one would be a false failure.
 */
export function checkPackage(dir, name = dir) {
  if (!isBuildable(dir)) return null;
  const source = hashSourceTree(dir);
  if (source === null) return null;

  if (!hasDist(dir)) return `${name}: no dist/ — the package has never been built`;

  const stamp = readStamp(dir);
  if (stamp === null) {
    return `${name}: dist/ exists but carries no build stamp — an interrupted or pre-stamp build`;
  }
  if (stamp.hash !== source.hash) {
    return `${name}: dist/ was built from different sources than the ${source.fileCount} file(s) now in src/`;
  }
  return null;
}

/**
 * Transitive workspace dependencies of the package at `dir`, as
 * `{name, dir}`. Anything not declared `workspace:` is npm's problem.
 */
function workspaceDepsOf(dir, byName) {
  const seen = new Set();
  const out = [];
  const visit = (packageDir) => {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    } catch {
      return;
    }
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, range] of Object.entries(declared)) {
      if (!String(range).startsWith('workspace:')) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const dep = byName.get(name);
      if (dep === undefined) continue;
      out.push(dep);
      visit(dep.dir);
    }
  };
  visit(dir);
  return out;
}

/**
 * Problems for the packages the CURRENT vitest project actually imports.
 *
 * Scoped to transitive workspace dependencies rather than the whole
 * workspace, and that scoping is load-bearing rather than an
 * optimisation. Turbo runs `test` with `dependsOn: ["^build"]`, so a
 * project's dependencies are guaranteed built before its tests start —
 * but turbo also runs unrelated packages' builds CONCURRENTLY with this
 * project's tests, and restoring a cached build rewrites `dist/`. A
 * whole-workspace check reads those directories mid-write and fails
 * intermittently on a tree that is entirely fine. Observed once as
 * `Unexpected end of JSON input` before this was scoped; a subsequent
 * identical run passed, which is how a race announces itself.
 *
 * Checking only what we import is both race-free by construction and the
 * honest question: a stale `dist/` we never load cannot affect us.
 *
 * From the repo root (no workspace dependencies of its own) there is
 * nothing to check — `scripts/` imports no workspace package.
 */
export function findStaleDists(fromDir = process.cwd()) {
  const byName = new Map(workspacePackages().map((p) => [p.name, p]));
  const problems = [];
  for (const { name, dir } of workspaceDepsOf(fromDir, byName)) {
    const problem = checkPackage(dir, name);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

export default function setup() {
  const problems = findStaleDists();
  if (problems.length === 0) return;
  throw new Error(
    [
      '',
      'Refusing to run: the built output does not match the source on disk.',
      '',
      ...problems.map((p) => `  - ${p}`),
      '',
      '  Tests that import a workspace package by name resolve through its',
      '  exports map into dist/. Running against a stale dist/ produces a',
      '  green suite that proves nothing about the code you are editing.',
      '',
      '  Fix:  pnpm build',
      '',
    ].join('\n'),
  );
}
