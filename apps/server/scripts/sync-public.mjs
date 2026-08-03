#!/usr/bin/env node
/**
 * sync-public — copy the built web-host PWA into this package's
 * `public/` dir, which Hono's static middleware serves and the
 * published csuite-server tarball ships (`files: ["dist", "public"]`).
 *
 * csuite-web-host used to build straight into `apps/server/public/`;
 * now that it publishes its own `dist/`, the server owns this copy.
 * Runs as part of `pnpm build` (after tsup). Turbo orders the two
 * builds via the csuite-web-host devDependency, so `../web-host/dist`
 * is always fresh when this runs.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..', '..');
const src = resolve(here, '..', 'web-host', 'dist');
const dest = resolve(here, 'public');

if (!existsSync(src)) {
  console.error(`sync-public: ${src} does not exist — build csuite-web-host first`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
// Skip build metadata. `.build-stamp.json` is the freshness stamp
// scripts/dist-stamp.mjs writes into every built dist/; copying it here
// would publish web-host's stamp inside the server's `public/`, where
// the server's own `files` negation does not reach it. Filtering at the
// copy is better than adding a second negation: anything internal that
// lands in a dist/ later is excluded here by default rather than by
// someone remembering to negate it twice.
cpSync(src, dest, {
  recursive: true,
  filter: (source) => !basename(source).startsWith('.build-stamp'),
});

// Brand tokens + fonts for server-rendered pages (the platform-connect
// page links /brand/*.css instead of carrying its own token block, so
// its palette tracks the brand package like everything else).
const require = createRequire(import.meta.url);
const brandDist = join(dirname(require.resolve('@the-efficacious/brand/package.json')), 'dist');
mkdirSync(join(dest, 'brand'), { recursive: true });
copyFileSync(join(brandDist, 'tokens.css'), join(dest, 'brand', 'tokens.css'));
copyFileSync(join(brandDist, 'fonts.css'), join(dest, 'brand', 'fonts.css'));

console.log(`sync-public: copied web-host dist + brand css -> ${dest}`);
