/**
 * `csuite prune-traces --older-than <duration>` — delete activity rows
 * older than a cutoff from the agent-activity SQLite DB.
 *
 * Closes the "activity store grows unbounded" finding from dan's
 * 2026-04-16 audit Part 5 #3. Before this, the only way to reclaim
 * trace storage was to stop the broker and `rm` the DB file —
 * fine for development, not a real operational path.
 *
 * Design notes:
 *   - Acts directly on the activity DB file rather than going through
 *     the running broker. Prune is a maintenance operation; it works
 *     whether the broker is online or offline. When the broker IS
 *     online, SQLite's WAL + busy_timeout settings keep the prune
 *     from blocking live writes for long.
 *   - Dry-run is the default POSTURE but not the default MODE — we
 *     always prompt with the cutoff + table row count before
 *     destroying anything unless `--yes` is passed. Scripts pass
 *     `--yes`; humans see the prompt.
 *   - Duration shapes: "30d", "7d", "24h", "60m", "3600s", "500ms".
 *     See `parseDurationMs` in `csuite-server`.
 */

import { ENV } from 'csuite-sdk/protocol';
import { UsageError } from './errors.js';

export { UsageError };

export interface PruneTracesCommandInput {
  /** Duration older-than cutoff — e.g. "30d", "24h". Required. */
  olderThan?: string;
  /**
   * Path to the activity SQLite DB. Defaults to the same derivation
   * rule `runServer` uses: `<configDir>/<configBasename>-activity.db`
   * or `:memory:` when the main dbPath is `:memory:`. For offline use
   * members typically pass `--activity-db` explicitly.
   */
  activityDbPath?: string;
  /** Skip the confirmation prompt. Required for non-TTY / CI / scripted use. */
  yes?: boolean;
}

export async function runPruneTracesCommand(
  input: PruneTracesCommandInput,
  stdout: (line: string) => void,
): Promise<void> {
  if (!input.olderThan) {
    throw new UsageError('prune-traces: --older-than <duration> is required (e.g. 30d, 24h, 60m)');
  }
  const server = await loadServerModule();
  const olderThanMs = server.parseDurationMs(input.olderThan);
  if (olderThanMs === null) {
    throw new UsageError(
      `prune-traces: unrecognized duration '${input.olderThan}' — ` +
        'expected a number + unit (ms, s, m, h, d), e.g. 30d or 24h',
    );
  }

  const activityDbPath =
    input.activityDbPath ?? process.env.CSUITE_ACTIVITY_DB_PATH ?? deriveDefaultActivityDbPath();
  if (activityDbPath === ':memory:') {
    throw new UsageError(
      'prune-traces: activity DB path resolves to `:memory:`. In-memory DBs vanish on every\n' +
        '  broker restart, so there is nothing to prune. Pass --activity-db to point at\n' +
        '  a real file.',
    );
  }

  const now = Date.now();
  const cutoffTs = now - olderThanMs;

  stdout(`prune-traces: activity DB = ${activityDbPath}`);
  stdout(
    `prune-traces: cutoff      = ${new Date(cutoffTs).toISOString()} (${input.olderThan} ago)`,
  );

  if (!input.yes && !process.stdin.isTTY) {
    throw new UsageError(
      'prune-traces: stdin is not a TTY and --yes was not passed.\n' +
        '  Pass --yes to confirm destructive delete in scripted / CI runs.',
    );
  }

  if (!input.yes) {
    const line = await prompt(
      'prune-traces: delete every activity row older than the cutoff? [y/N] ',
    );
    if (!/^y(es)?$/i.test(line.trim())) {
      stdout('prune-traces: aborted — no changes.');
      return;
    }
  }

  const db = server.openDatabase(activityDbPath);
  let deleted = 0;
  try {
    deleted = server.pruneActivityDb(db, cutoffTs);
  } finally {
    try {
      db.close();
    } catch {
      // best-effort; a close failure after a successful DELETE is
      // non-fatal for the member.
    }
  }
  stdout(`prune-traces: deleted ${deleted} row(s).`);
}

/**
 * Default derivation of the activity DB path for the CLI surface.
 * Matches `runServer`'s `defaultActivityDbPath` logic — they should
 * stay in sync so a member running prune against the default
 * location hits the same file the server writes to.
 */
function deriveDefaultActivityDbPath(): string {
  const mainDbPath = process.env[ENV.dbPath] ?? ':memory:';
  if (mainDbPath === ':memory:') return ':memory:';
  const extIdx = mainDbPath.lastIndexOf('.');
  if (extIdx > mainDbPath.lastIndexOf('/') && extIdx !== -1) {
    return `${mainDbPath.slice(0, extIdx)}-activity${mainDbPath.slice(extIdx)}`;
  }
  return `${mainDbPath}-activity`;
}

/**
 * Tiny readline-backed prompt. The full wizard IO abstraction would
 * be overkill for a single y/N confirmation; this keeps the module
 * dep-light (no transitive pull of qrcode-terminal etc.).
 */
async function prompt(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer));
    });
  } finally {
    rl.close();
  }
}

async function loadServerModule(): Promise<typeof import('csuite-server')> {
  try {
    return await import('csuite-server');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'prune-traces: csuite-server is not installed.\n' +
          '  This command needs the broker package. Install it alongside the CLI:\n' +
          '    npm install -g csuite-server\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g csuite',
      );
    }
    throw err;
  }
}
