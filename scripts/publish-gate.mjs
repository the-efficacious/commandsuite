#!/usr/bin/env node

/**
 * Publish-side source binding.
 *
 * `prepare` is root-owned: refuse a dirty tree, build through Turbo,
 * verify package payload shape, then record each publishable package's
 * payload digest against HEAD. Turbo's cache is safe here because every
 * publishable output is declared; a hit restores the output for the
 * dependency-aware task hash.
 *
 * `check` is package-owned and refusal-only. It never rebuilds: doing so
 * from a dirty working tree would manufacture an artifact that exists in
 * no commit. Package `prepublishOnly` hooks call it immediately before
 * publication.
 *
 * This cannot reach `npm publish an-already-built.tgz`; lifecycle hooks
 * do not run for that path. Closing that requires provenance embedded in
 * the tarball, not another entry point.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = resolve(REPO_ROOT, '.turbo', 'publish-ready.json');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? 'without a status'}`);
  }
  return result.stdout?.trim() ?? '';
}

function gitOutput(args) {
  return run('git', args, { capture: true });
}

function assertClean() {
  const dirty = gitOutput(['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty !== '') {
    throw new Error(
      `refusing publication from an uncommitted working tree:\n${dirty}\n` +
        'Commit or stash every change before preparing a release.',
    );
  }
}

function publishablePackages() {
  const packages = [];
  for (const parent of ['packages', 'apps']) {
    const parentDir = resolve(REPO_ROOT, parent);
    if (!existsSync(parentDir)) continue;
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = resolve(parentDir, entry.name);
      const packagePath = resolve(dir, 'package.json');
      if (!existsSync(packagePath)) continue;
      const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (manifest.private === true) continue;
      packages.push({ name: manifest.name, dir, manifest });
    }
  }
  return packages;
}

function walkFiles(path, files) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isFile()) {
    files.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) walkFiles(child, files);
    else if (entry.isFile()) files.push(child);
  }
}

export function payloadDigest(dir, manifest) {
  const files = [resolve(dir, 'package.json')];
  const excludes = new Set(
    (manifest.files ?? [])
      .filter((entry) => typeof entry === 'string' && entry.startsWith('!'))
      .map((entry) => entry.slice(1)),
  );
  for (const entry of manifest.files ?? []) {
    if (typeof entry !== 'string' || entry.startsWith('!')) continue;
    walkFiles(resolve(dir, entry), files);
  }
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    const path = relative(dir, file).replaceAll('\\', '/');
    if (excludes.has(path)) continue;
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function prepare() {
  assertClean();
  // Release identity is a publication-boundary fact. The workflow may
  // build earlier for validation, but this root-owned gate is the one
  // path every supported publish takes immediately before payload hashing.
  run('pnpm', ['build'], { env: { CSUITE_BUILD_SOURCE: 'npm' } });
  run('pnpm', ['verify-pack']);
  assertClean();

  const commit = gitOutput(['rev-parse', 'HEAD']);
  const packages = {};
  for (const pkg of publishablePackages()) {
    packages[pkg.name] = {
      dir: relative(REPO_ROOT, pkg.dir),
      digest: payloadDigest(pkg.dir, pkg.manifest),
    };
  }
  mkdirSync(dirname(MARKER), { recursive: true });
  writeFileSync(MARKER, `${JSON.stringify({ commit, packages }, null, 2)}\n`);
  console.log(
    `publish gate: ${Object.keys(packages).length} packages bound to ${commit.slice(0, 12)}`,
  );
}

function check(packageDir = process.cwd()) {
  assertClean();
  if (!existsSync(MARKER)) {
    throw new Error('no prepared release found; run `pnpm release:prepare` from the repo root');
  }
  const marker = JSON.parse(readFileSync(MARKER, 'utf8'));
  const commit = gitOutput(['rev-parse', 'HEAD']);
  if (marker.commit !== commit) {
    throw new Error(
      `prepared release names ${String(marker.commit).slice(0, 12)}, but HEAD is ${commit.slice(0, 12)}; ` +
        'run `pnpm release:prepare` from the repo root',
    );
  }
  const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'));
  const expected = marker.packages?.[manifest.name];
  if (!expected) {
    throw new Error(
      `${manifest.name} was not part of the prepared release; run \`pnpm release:prepare\` from the repo root`,
    );
  }
  const actual = payloadDigest(packageDir, manifest);
  if (actual !== expected.digest) {
    throw new Error(
      `${manifest.name} payload changed after release preparation; ` +
        'run `pnpm release:prepare` from the repo root',
    );
  }
  console.log(`publish gate: ${manifest.name} matches committed source at ${commit.slice(0, 12)}`);
}

const command = process.argv[2];
try {
  if (command === 'prepare') prepare();
  else if (command === 'check') check();
  else throw new Error('usage: node scripts/publish-gate.mjs <prepare|check>');
} catch (error) {
  console.error(`publish gate: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
