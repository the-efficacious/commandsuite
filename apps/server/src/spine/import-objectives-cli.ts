/**
 * `csuite-import-objectives` — the one-shot legacy import, run
 * explicitly.
 *
 * A SEPARATE BINARY TAKING A DATABASE PATH, and both halves of that are
 * decisions rather than convenience.
 *
 * EXPLICIT, NEVER ON BOOT. An import wired into server startup happens
 * on a schedule nobody chose — at the next restart, possibly in the
 * middle of an incident, with nobody reading the summary. This one runs
 * when an operator runs it, prints what it did and what it deliberately
 * refused, and exits.
 *
 * A PATH RATHER THAN A CONFIG. The import reads and writes one SQLite
 * file and needs nothing else — no members, no KEK, no listener. Taking
 * the path directly means the command is drivable with a database and
 * nothing else, which is what makes its exit status and its output
 * testable rather than merely inspectable.
 *
 * THE CONSUMER OF THIS FILE IS A SHELL. So `runImportCli` returns an
 * exit code and writes through an injected IO pair, and the entry below
 * is the only part that touches `process` — a validator that diagnoses
 * every input perfectly and exits 0 is a green check, not a weaker
 * version of working.
 */

import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openDatabase } from '../db.js';
import { createAnnexWritePath } from './append.js';
import { formatImportSummary, importObjectives } from './import-objectives.js';

export const IMPORT_CLI_USAGE = `csuite-import-objectives

usage:
  csuite-import-objectives --db <path> [--registered-by <name>]

Imports the legacy objectives record into the spine's annex as
provenance: legacy_projection, permanently. Idempotent — running it
twice imports nothing the second time.

options:
  --db <path>              SQLite database to read and write (required).
  --registered-by <name>   Who the synthetic 'legacy:objectives' subject
                           is registered by. Default: legacy-import.
  -h, --help               Print this message.

The mapping is deliberately lossy in the direction of honesty. No
revision, no verdict, no criteria decomposition and no watcher is
imported, because none of those was ever recorded — and every legacy
row that could not be imported is printed with the reason.
`;

/** Where the command's two streams go. Injected so both can be read. */
export interface ImportCliIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

/**
 * Run the import. Returns the process exit code: 0 on success, 2 on a
 * usage error, 1 on a failure to import.
 */
export async function runImportCli(argv: string[], io: ImportCliIO): Promise<number> {
  let values: { db?: string; 'registered-by'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        db: { type: 'string' },
        'registered-by': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    io.err(`csuite-import-objectives: ${(err as Error).message}\n\n${IMPORT_CLI_USAGE}`);
    return 2;
  }

  if (values.help === true) {
    io.out(IMPORT_CLI_USAGE);
    return 0;
  }
  if (typeof values.db !== 'string' || values.db.length === 0) {
    io.err(`csuite-import-objectives: --db is required\n\n${IMPORT_CLI_USAGE}`);
    return 2;
  }

  // A NONEXISTENT PATH IS A TYPO, NOT A REQUEST.
  //
  // `openDatabase` creates the file, so a mistyped `--db` produced an
  // empty database, imported the zero objectives in it, and exited 0
  // printing "objectives read: 0". For a one-shot migration an operator
  // is told to run BEFORE upgrading, that reads as clean success — and
  // the real database is still unimported when the upgrade removes its
  // only reader. There is no legitimate reason to import into a
  // database that does not exist yet.
  if (!existsSync(values.db)) {
    io.err(
      `csuite-import-objectives: no database at ${values.db}\n` +
        '  This command reads an EXISTING csuite database; it does not create one.\n' +
        '  Check the path — a typo here imports nothing and would exit 0.\n',
    );
    return 2;
  }

  try {
    const db = openDatabase(values.db);
    // NO CURATOR, NO PROBE ENGINE, NO HOOKS. The write path is
    // constructed bare, deliberately: the curator's post-commit hook
    // turns an append into an injection, and running it over a year of
    // history would spend every member's album re-delivering events
    // that already happened. §10 — never spend a member's budget on
    // ceremony.
    const spine = createAnnexWritePath({
      db,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    const summary = await importObjectives({
      db,
      spine,
      registeredBy: values['registered-by'] ?? 'legacy-import',
    });
    io.out(`${formatImportSummary(summary)}\n`);
    return 0;
  } catch (err) {
    io.err(`csuite-import-objectives: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
