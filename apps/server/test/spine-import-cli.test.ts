/**
 * The import command, asserted at the boundary its consumer reads.
 *
 * A COMMAND'S CONSUMER IS A SHELL, and a shell reads two things this
 * suite would otherwise never touch: the EXIT STATUS and WHICH STREAM
 * the text went to. A command that diagnoses every input perfectly and
 * exits 0 is not a weaker version of working — it is a green check.
 * Text a reader needs on stdout, written to stderr, is as invisible as
 * text never produced.
 *
 * The remaining gap is stated rather than papered over: `dist/` is not
 * rebuilt by this package's own test task (turbo's `test` depends on
 * `^build`, its DEPENDENCIES' builds), so spawning the built binary
 * here would be a measurement of whatever `dist/` happened to hold.
 * What is asserted instead is the pair that makes the binary reachable
 * — the `bin` entry in the manifest and the tsup entry that produces
 * it — because a manifest is read at a boundary this package does not
 * own, and a correct command nobody can invoke has not shipped.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { IMPORT_CLI_USAGE, runImportCli } from '../src/spine/import-objectives-cli.js';

let dir: string;
let dbPath: string;

/** Both streams, kept apart — which one a sentence went to is the point. */
function streams() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

const LEGACY_SCHEMA = `
  CREATE TABLE objectives (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT NOT NULL,
    originator TEXT NOT NULL, watchers TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
    result TEXT, block_reason TEXT, attachments TEXT NOT NULL DEFAULT '[]',
    outcome_version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE objective_events (
    event_id TEXT, objective_id TEXT NOT NULL, ts INTEGER NOT NULL,
    actor TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL
  );
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'csuite-import-'));
  dbPath = join(dir, 'csuite.db');
  const db = openDatabase(dbPath);
  db.exec(LEGACY_SCHEMA);
  db.prepare(
    `INSERT INTO objectives
       (id, title, body, outcome, status, assignee, originator, watchers,
        created_at, updated_at, completed_at, result, block_reason, attachments, outcome_version)
     VALUES ('obj-1', 'Ship it', '', 'the thing ships', 'active', 'rune', 'lea', '["cora"]',
             1000, 1000, NULL, NULL, NULL, '[]', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO objective_events (event_id, objective_id, ts, actor, kind, payload)
     VALUES ('ev-1', 'obj-1', 1000, 'lea', 'watcher_added', '{"name":"cora"}')`,
  ).run();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('csuite-import-objectives', () => {
  it('imports, exits 0, and prints the summary on STDOUT', async () => {
    const s = streams();
    const code = await runImportCli(['--db', dbPath], s.io);

    expect(code, 'a shell reads the exit status').toBe(0);
    expect(s.stderr(), 'nothing went to the error stream').toBe('');
    // The summary is the product — a run that imported correctly and
    // said nothing has not reported.
    expect(s.stdout()).toContain('objectives imported:         1');
    // …including what it refused, which is the half a reader has to be
    // told rather than left to notice.
    expect(s.stdout()).toContain('NOT IMPORTED, and deliberately');
    expect(s.stdout()).toContain('the spine has no watchers');

    // And the effect actually landed in the database it was given.
    const db = openDatabase(dbPath);
    const row = db.prepare('SELECT COUNT(*) AS n FROM spine_events').get() as { n: number };
    expect(row.n, 'events are in the annex, not just in the summary').toBeGreaterThan(0);
  });

  it('is idempotent through the command, not only through the function', async () => {
    await runImportCli(['--db', dbPath], streams().io);
    const s = streams();
    const code = await runImportCli(['--db', dbPath], s.io);

    expect(code).toBe(0);
    expect(s.stdout()).toContain('objectives imported:         0');
    expect(s.stdout()).toContain('already imported (skipped):  1');
  });

  it('refuses a missing --db with exit 2 and a diagnosis on STDERR', async () => {
    const s = streams();
    const code = await runImportCli([], s.io);

    expect(code, 'a usage error is not a success').toBe(2);
    expect(s.stdout(), 'a diagnosis on stdout is a diagnosis a pipeline eats').toBe('');
    expect(s.stderr()).toContain('--db is required');
    expect(s.stderr()).toContain('usage:');
  });

  it('refuses an unknown flag with exit 2 rather than ignoring it', async () => {
    const s = streams();
    const code = await runImportCli(['--db', dbPath, '--force'], s.io);

    expect(code).toBe(2);
    expect(s.stderr()).toContain('csuite-import-objectives:');
    // The NEAREST VALID THING must still be accepted — a suite of
    // "rejects bad input" passes happily against a parser that rejects
    // good input too.
    const ok = streams();
    expect(await runImportCli(['--db', dbPath, '--registered-by', 'andrewjon'], ok.io)).toBe(0);
  });

  it('prints usage to STDOUT and exits 0 when asked for it', async () => {
    const s = streams();
    const code = await runImportCli(['--help'], s.io);

    // Help was ASKED for, so it is the output, not an error.
    expect(code).toBe(0);
    expect(s.stderr()).toBe('');
    expect(s.stdout()).toBe(IMPORT_CLI_USAGE);
  });

  it('reports a failure as a failure', async () => {
    const s = streams();
    const code = await runImportCli(['--db', join(dir, 'nope', 'missing.db')], s.io);

    // The SPECIFIC failure: a non-zero code AND the sentence on stderr.
    // An import that cannot open its database must not exit 0.
    expect(code).toBe(1);
    expect(s.stdout()).toBe('');
    expect(s.stderr()).toContain('csuite-import-objectives:');
  });
});

describe('the binary is reachable', () => {
  it('is declared in the manifest and produced by the build', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      bin: Record<string, string>;
      files: string[];
    };
    // A correct command nobody can invoke has not shipped.
    expect(pkg.bin['csuite-import-objectives']).toBe('./dist/import-objectives.js');
    expect(pkg.files).toContain('dist');

    const tsup = readFileSync(new URL('../tsup.config.ts', import.meta.url), 'utf8');
    // The manifest points at `dist/import-objectives.js`; something has
    // to build it. These two drift independently and neither notices.
    expect(tsup).toContain("'import-objectives': 'src/import-objectives.ts'");
    expect(tsup, 'a bin without a shebang is not executable').toContain(
      "banner: { js: '#!/usr/bin/env node' }",
    );
  });
});
