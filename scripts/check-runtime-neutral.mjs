#!/usr/bin/env node
/**
 * Runtime-neutrality guard.
 *
 * Asserts that a package's `src/` contains no `node:*` import or
 * require specifiers. csuite-core's charter is that everything in it
 * is portable across JavaScript runtimes — persistence and IO arrive
 * through injected drivers and ports. A `node:` specifier anywhere in
 * the package silently breaks that contract for every non-Node host,
 * so the check runs in CI rather than living in a comment.
 *
 * Usage: node scripts/check-runtime-neutral.mjs <package-dir> [...more]
 * Exits non-zero listing each offending file:line.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SPECIFIER = /(?:from\s+|require\(\s*|import\(\s*)['"]node:([\w/]+)['"]/g;

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: check-runtime-neutral.mjs <package-dir> [...more]');
  process.exit(2);
}

let failures = 0;
for (const target of targets) {
  const srcDir = join(target, 'src');
  for (const file of readdirSync(srcDir, { recursive: true })) {
    if (typeof file !== 'string' || !file.endsWith('.ts')) continue;
    const path = join(srcDir, file);
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(SPECIFIER)) {
      const line = text.slice(0, match.index).split('\n').length;
      console.error(`${relative(process.cwd(), path)}:${line} imports node:${match[1]}`);
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} node:* specifier(s) found. This package is runtime-neutral by charter: ` +
      'reach the capability through a port or an injected driver instead ' +
      '(see the package README / sql-driver.ts for the pattern).',
  );
  process.exit(1);
}
