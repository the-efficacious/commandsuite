/**
 * Build-freshness stamping for workspace packages.
 *
 * A test run that imports a workspace package by name resolves through
 * that package's `exports` map into `dist/`. Nothing in the module
 * resolver checks that `dist/` was built from the `src/` currently on
 * disk, so a stale build passes silently — a suite goes green against
 * code that no longer exists. See `scripts/assert-fresh-dist.mjs` for
 * the check and `.github/CONTRIBUTING.md` for why this matters.
 *
 * We stamp on BUILD SUCCESS rather than comparing mtimes. Two measured
 * reasons, both of which an mtime comparison gets wrong:
 *
 *   - `git checkout` away and back rewrites a source file whose content
 *     is identical to what `dist/` was built from. Its mtime is now
 *     newer, so an mtime guard REFUSES a consistent tree — the failure
 *     that gets a guard switched off.
 *   - Deleting a source file makes NO remaining file newer, so an mtime
 *     guard PASSES while `dist/` still carries the emitted module for
 *     the file that is gone. mtime cannot see a deletion at all.
 *
 * So the stamp records a hash over the source file SET (paths and
 * contents both), and it is written only after the build command has
 * succeeded — which additionally catches a build that failed partway
 * and left freshly-written output behind.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const STAMP_FILENAME = '.build-stamp.json';

/** Directories under `src/` that never affect build output. */
const SKIP_DIRS = new Set(['__snapshots__', '__fixtures__']);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

/**
 * Hash a package's source tree. Path-sensitive by construction: the
 * relative path goes into the digest alongside the bytes, so adding,
 * removing or renaming a file changes the hash even when no surviving
 * file's contents change. That is the deletion case above.
 *
 * Paths are normalized to forward slashes so a stamp written on one
 * platform validates on another.
 */
export function hashSourceTree(packageDir) {
  const srcDir = join(packageDir, 'src');
  let files;
  try {
    files = walk(srcDir);
  } catch {
    return null; // no src/ — nothing to stamp
  }
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(relative(srcDir, file).split(sep).join('/'));
    digest.update('\0');
    digest.update(readFileSync(file));
    digest.update('\0');
  }
  return { hash: digest.digest('hex'), fileCount: files.length };
}

/** True when this package is expected to produce a `dist/`. */
export function isBuildable(packageDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    return typeof pkg.scripts?.build === 'string';
  } catch {
    return false;
  }
}

export function stampPath(packageDir) {
  return join(packageDir, 'dist', STAMP_FILENAME);
}

export function readStamp(packageDir) {
  try {
    return JSON.parse(readFileSync(stampPath(packageDir), 'utf8'));
  } catch {
    return null;
  }
}

export function hasDist(packageDir) {
  try {
    return statSync(join(packageDir, 'dist')).isDirectory();
  } catch {
    return false;
  }
}

/** Write the stamp. Invoked as the last step of a package's build. */
function main() {
  const packageDir = process.cwd();
  const source = hashSourceTree(packageDir);
  if (source === null) {
    console.error(`dist-stamp: no src/ in ${packageDir} — nothing to stamp`);
    process.exit(0);
  }
  writeFileSync(
    stampPath(packageDir),
    `${JSON.stringify({ hash: source.hash, fileCount: source.fileCount }, null, 2)}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
