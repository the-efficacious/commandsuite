#!/usr/bin/env node
/**
 * verify-pack-contents — sanity-check that every publishable package
 * actually ships the files its `package.json` promises.
 *
 * What we check, per publishable workspace package:
 *   - Run `pnpm pack` to produce a tarball.
 *   - Read `exports` (handles nested condition objects), plus the
 *     top-level `main`, `module`, `types`, `bin` fields. Collect
 *     every relative path each one points at.
 *   - List the tarball contents (`tar -tzf`) and verify that every
 *     declared path is present.
 *
 *   - Reject internal build metadata anywhere in the payload. This
 *     checks ABSENCE, which the presence check above structurally
 *     cannot: a tarball can contain everything it declares and still
 *     ship files it never meant to. `dist/.build-stamp.json` reached
 *     two packages that way — `csuite-web-host` had no negation, and
 *     `csuite-server` re-acquired the stamp under `public/` because
 *     `sync-public.mjs` copies web-host's `dist/` wholesale, where the
 *     server's own `dist/` negation cannot reach it. Both packages
 *     reported OK throughout, correctly, because every declared path
 *     was present.
 *
 * What we deliberately don't check:
 *   - Pattern subpath imports (`./*.ts`) — can't statically resolve
 *     without expanding glob; trust the publish-side to surface
 *     missing files when an actual import fails.
 *   - Non-relative export targets (e.g. external module redirects).
 *
 * Run from the repo root:  node scripts/verify-pack-contents.mjs
 *
 * Exit code 0 if every declared file ships; 1 otherwise (with a
 * per-package list of missing paths). Designed to be the last gate
 * before `pnpm publish` in CI so a broken release fails loud, not
 * silently in the npm registry.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PACK_DIR = '/tmp/csuite-pack-verify';

/**
 * Internal build metadata that must never reach a published tarball.
 * Matched ANYWHERE in the payload rather than at a declared location —
 * the freshness stamp reached `csuite-server` under `public/`, which no
 * `dist/`-scoped exclusion could have caught.
 */
const FORBIDDEN_ENTRY = /(^|\/)\.build-stamp\.json$/;

function discoverPublishable() {
  const candidates = [];
  for (const parent of ['packages', 'apps']) {
    const parentDir = resolve(REPO_ROOT, parent);
    if (!existsSync(parentDir)) continue;
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = resolve(parentDir, entry.name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.private === true) continue;
      candidates.push({
        name: pkg.name,
        dir: resolve(parentDir, entry.name),
        pkg,
      });
    }
  }
  return candidates;
}

/**
 * Walk a `package.json` and collect every relative path the package
 * declares as a file consumers should be able to import. Handles:
 *
 *   - `main`, `module`, `types` (string)
 *   - `bin` (string OR { name: path })
 *   - `exports` (string OR { ".": string } OR
 *     { ".": { import: string, types: string, ... } } OR
 *     { "./foo": string | object, ... })
 *
 * Skips entries whose target isn't a relative path beginning with
 * "./" — those are either external module redirects or pattern
 * imports we can't statically resolve.
 */
function declaredPaths(pkg) {
  const paths = new Set();
  const collect = (val) => {
    if (typeof val === 'string') {
      if (val.startsWith('./')) paths.add(val.slice(2));
      return;
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const v of Object.values(val)) collect(v);
    }
  };

  for (const field of ['main', 'module', 'types']) {
    if (typeof pkg[field] === 'string') collect(pkg[field]);
  }
  if (typeof pkg.bin === 'string') {
    collect(pkg.bin);
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const v of Object.values(pkg.bin)) collect(v);
  }
  if (pkg.exports !== undefined) collect(pkg.exports);

  return [...paths];
}

function listTarballEntries(tgzPath) {
  const out = execSync(`tar -tzf "${tgzPath}"`, { encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => (line.startsWith('package/') ? line.slice('package/'.length) : line));
}

function main() {
  rmSync(PACK_DIR, { recursive: true, force: true });
  mkdirSync(PACK_DIR, { recursive: true });

  const packages = discoverPublishable();
  if (packages.length === 0) {
    console.error('no publishable packages discovered — is this the repo root?');
    process.exit(1);
  }

  console.log(`Verifying pack contents for ${packages.length} packages…\n`);

  let failed = false;
  for (const { name, dir, pkg } of packages) {
    process.stdout.write(`  ${name}: `);
    let tgzName;
    try {
      execSync(`pnpm pack --pack-destination ${PACK_DIR}`, {
        cwd: dir,
        stdio: 'pipe',
      });
      tgzName = readdirSync(PACK_DIR).find(
        (f) => f.startsWith(name.replace('@', '').replace('/', '-')) && f.endsWith('.tgz'),
      );
    } catch (err) {
      console.log(
        `PACK FAILED — ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`,
      );
      failed = true;
      continue;
    }
    if (!tgzName) {
      console.log('PACK FAILED — no .tgz produced');
      failed = true;
      continue;
    }

    const entries = new Set(listTarballEntries(resolve(PACK_DIR, tgzName)));
    const expected = declaredPaths(pkg);
    const missing = expected.filter((p) => !entries.has(p));
    const forbidden = [...entries].filter((p) => FORBIDDEN_ENTRY.test(p));

    if (missing.length === 0 && forbidden.length === 0) {
      console.log(`OK (${expected.length} paths)`);
    } else {
      if (missing.length > 0) {
        console.log(`MISSING ${missing.length}/${expected.length}`);
        for (const m of missing) console.log(`      - ${m}`);
      }
      if (forbidden.length > 0) {
        console.log(`SHIPS ${forbidden.length} internal file(s) it should not`);
        for (const f of forbidden) console.log(`      - ${f}`);
      }
      failed = true;
    }
  }

  if (failed) {
    console.error('\nPack-content verification failed.');
    process.exit(1);
  }
  console.log('\nAll publishable packages ship the files their package.json declares.');
}

main();
