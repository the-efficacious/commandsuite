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

import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..', '..');
const src = resolve(here, '..', 'web-host', 'dist');
const dest = resolve(here, 'public');

if (!existsSync(src)) {
  console.error(`sync-public: ${src} does not exist — build csuite-web-host first`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`sync-public: copied web-host dist -> ${dest}`);
