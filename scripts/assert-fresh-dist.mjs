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
 * DOMAIN — read this before reusing the check for anything else.
 *
 * The question it answers is narrow and exact: **does this package's
 * `dist/` correspond to this package's `src/`?** Three things follow that
 * are easy to assume away, all measured rather than reasoned:
 *
 *   1. It hashes `<pkg>/src/**` and nothing else, so **build
 *      configuration is invisible**. Editing `packages/core/tsup.config.ts`
 *      leaves `findStaleDists()` returning `[]`. Same for `vite.config.ts`,
 *      `index.html`, and `package.json` — all real build inputs, none
 *      hashed.
 *   2. It proves the INPUTS have not changed since the build. It says
 *      nothing about whether the OUTPUTS have. A `dist/index.html` edited
 *      by hand after a build passes cleanly, because `src` still matches.
 *   3. **It cannot see transitive workspace inputs**, and the reason is
 *      this file's own exemption. `csuite-web-ui` has no build script, so
 *      `checkPackage` skips it (correctly — it exports `./src/index.ts`
 *      and has no `dist` by design). But `csuite-web-host` BUNDLES
 *      web-ui's source, so editing `packages/web-ui/src/index.ts` leaves
 *      web-host reporting fresh. The skip is right for "does web-ui have
 *      a fresh dist" and is precisely what blinds every package that
 *      consumes it.
 *
 * (3) is not patchable by hashing more directories. A correct exemption
 * in a per-package checker becomes a hole in any aggregate claim built
 * on it: both levels are right and the composition is wrong. It means
 * this mechanism answers a different question from the one a PUBLISH
 * gate asks — *does this output correspond to the tagged source graph* —
 * and the two can both be computed correctly and disagree. Do not wire
 * this into a release path expecting graph-aware coverage; Turbo's task
 * hash is what covers the dependency graph, once a package's `outputs`
 * key actually declares what it publishes.
 *
 * AND SAY THE UNCOMFORTABLE HALF, because "this doesn't check X" reads
 * as "something else does" and here that is false where it matters most.
 * Under root `pnpm test`, turbo's `dependsOn: ["^build"]` covers (1) and
 * (3) — config and dependency drift both move the task hash — so this
 * guard's silence is harmless. Under a turbo-BYPASSING invocation, the
 * exact case this guard exists for, **nothing covers them.** Config
 * drift and dependency drift there are unchecked by anything at all, not
 * merely unchecked here.
 *
 * So this guard does not make `pnpm --filter <pkg> exec vitest` safe. It
 * makes one specific way of being wrong loud, and leaves two others
 * silent. If you are going to believe a result, run it from the root.
 *
 * It is also vitest-only. An ad-hoc `node` script importing
 * `packages/core/dist/index.js` never reaches this code; that gap is
 * covered by the reporting practice — state the object with the
 * result — not by more machinery here.
 *
 * And it does NOT check that the build is correct. That is what the tests importing a workspace
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

  // Three distinct states, three distinct messages. "Never built",
  // "build broke", and "build is out of date" call for different actions,
  // and collapsing them sends someone to debug a build that simply never
  // ran. An empty dist/ in particular is easy to mistake for a clean one.
  if (!hasDist(dir)) return `${name}: no dist/ — the package has not been built`;

  let distIsEmpty = false;
  try {
    distIsEmpty = readdirSync(join(dir, 'dist')).length === 0;
  } catch {
    distIsEmpty = false;
  }
  if (distIsEmpty) return `${name}: dist/ is empty — the package has not been built`;

  const stamp = readStamp(dir);
  if (stamp === null) {
    return `${name}: dist/ has output but no build stamp — a build that did not finish`;
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
 *
 * `fromDir` MUST be the vitest project root, not `process.cwd()`. Those
 * differ whenever vitest is pointed at a project from elsewhere —
 * `vitest --root apps/server` launched from the repo root runs the real
 * server suite against the real `csuite-core`, while cwd stays at the
 * root. Deriving the project from cwd there checks the ROOT's
 * dependencies, of which there are none, so the guard silently passes a
 * genuine run against a stale build. That is not a null run: 27 tests
 * executed and imported `csuite-core` by name. Take the root from the
 * context vitest hands `globalSetup`.
 */
export function findStaleDists(fromDir) {
  const byName = new Map(workspacePackages().map((p) => [p.name, p]));
  const problems = [];
  for (const { name, dir } of workspaceDepsOf(fromDir, byName)) {
    const problem = checkPackage(dir, name);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

/**
 * `globalSetup` entry. Vitest passes the project, whose `config.root` is
 * the project directory regardless of where vitest was launched from —
 * verified equal to `apps/server` both from that directory and from the
 * repo root via `--root apps/server`.
 *
 * FAILS CLOSED if the root cannot be determined. A guard that quietly
 * falls back to `process.cwd()` when it does not recognise its context
 * is a guard that stops working on a vitest upgrade without anyone
 * noticing — which is this guard's own failure mode, one level up.
 */
export default function setup(context) {
  const projectRoot = context?.config?.root ?? context?.globalConfig?.root;
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error(
      'assert-fresh-dist: could not determine the vitest project root from globalSetup context. ' +
        'Refusing rather than falling back to process.cwd(), which would silently skip the check ' +
        'for any launch where cwd is not the project directory (e.g. `vitest --root <pkg>`).',
    );
  }
  const problems = findStaleDists(projectRoot);
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
