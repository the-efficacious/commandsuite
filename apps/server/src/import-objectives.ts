/**
 * `csuite-import-objectives` — the bin entry, and nothing else.
 *
 * Split from `spine/import-objectives-cli.ts` for the same reason
 * `index.ts` is split from `run.ts`: everything worth asserting about a
 * command — how it parses its arguments, which stream each sentence
 * goes to, what it exits with — lives in a function a test can call,
 * and the module that touches `process` stays small enough to read.
 *
 * A command's consumer is a shell, and a shell reads the exit status.
 */

import { runImportCli } from './spine/import-objectives-cli.js';

const code = await runImportCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
process.exitCode = code;
