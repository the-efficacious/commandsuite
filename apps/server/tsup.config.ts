import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };
const define = { __PKG_VERSION__: JSON.stringify(pkg.version) };

// Note: `node:sqlite` is loaded via `createRequire` inside
// `src/sqlite-event-log.ts` to bypass esbuild's aggressive
// `node:`-prefix normalization. If you touch that file, keep the
// runtime resolution pattern — otherwise esbuild will emit
// `import from "sqlite"` (broken at runtime).

// Skip DTS emit in watch mode. Nothing consumes the fresh .d.ts
// during dev (other packages pick them up on the next `pnpm build`),
// so keeping DTS off makes watch-mode rebuild cycles noticeably
// faster and avoids one source of cross-package write races.
const isWatch = process.argv.includes('--watch');

/**
 * Dev-only onSuccess: spawn the built server binary and return a
 * cleanup callback tsup will call on the next rebuild. Using the
 * function form (vs. a shell string) gives us:
 *
 *   1. Proper lifecycle — tsup awaits our cleanup before spawning
 *      the next cycle, so there's no race between "old server still
 *      holding :8717" and "new server tries to listen".
 *   2. No shell parsing of argv. The original `--onSuccess 'node
 *      --env-file-if-exists=../../.env …'` string got mangled by
 *      tinyexec/cross-spawn when sh interpreted the `=` inside the
 *      flag, producing `/bin/sh: 1: .env: not found`.
 *   3. Attached to the BIN entry only. If we attached it globally
 *      (or via the --onSuccess CLI flag), tsup would fire it once
 *      per build entry — two entries (lib + bin) = two spawns = the
 *      second one crashes with EADDRINUSE.
 *
 * Returns a function that signals the child, then awaits its exit
 * so the next rebuild cycle sees a free port.
 */
function makeDevOnSuccess(): () => Promise<() => Promise<void>> {
  return async () => {
    const child: ChildProcess = spawn(
      process.execPath,
      ['--env-file-if-exists=../../.env', './dist/index.js', '--config-path', '../../csuite.json'],
      { stdio: 'inherit' },
    );
    return async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });
      child.kill('SIGTERM');
      // Hard-kill fallback if the server doesn't shut down in 2s.
      const timeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 2000);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    };
  };
}

export default defineConfig([
  // Library entry (consumed by csuite-cli, etc.)
  {
    name: 'lib',
    entry: { run: 'src/run.ts' },
    format: ['esm'],
    dts: !isWatch,
    sourcemap: true,
    clean: true,
    target: 'node22',
    define,
  },
  // Bin entry (consumed by `csuite-server`). Watch-mode onSuccess lives
  // only on this entry so it fires once per rebuild cycle, not once
  // per tsup entry.
  {
    name: 'bin',
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
    define,
    ...(isWatch ? { onSuccess: makeDevOnSuccess() } : {}),
  },
  // Second bin: `csuite-connect-platform` — drives the server side of
  // the registration device flow that pairs this csuite with a hosted
  // control plane. Shipped as a distinct binary so the long-running
  // broker doesn't pull in extra code it never uses at runtime, and
  // so admins can alias / wrap it separately.
  {
    name: 'connect-platform-bin',
    entry: { 'connect-platform': 'src/connect-platform.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
    define,
  },
]);
