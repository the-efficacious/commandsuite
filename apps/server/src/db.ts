/**
 * Shared SQLite connection for the csuite server.
 *
 * `node:sqlite` uses a single-connection-per-process model — opening
 * the same file twice from one Node process gives you two independent
 * handles that will fight over WAL checkpoints and write locks. So we
 * open the database exactly once at server boot and hand the same
 * `DatabaseSync` instance to every module that needs it (event log,
 * session store, push-subscription store, …).
 *
 * Why a module-level helper instead of each module opening its own:
 *   - WAL mode and PRAGMA tuning only need to run once per file
 *   - shared prepared statements are scoped to the connection
 *   - shutdown has a single close point
 */

// Suppress the experimental warning before the first node:sqlite import.
import './suppress-experimental-warnings.js';

import { createRequire } from 'node:module';

type NodeSqliteModule = typeof import('node:sqlite');
export type DatabaseSyncInstance = InstanceType<NodeSqliteModule['DatabaseSync']>;
export type StatementInstance = ReturnType<DatabaseSyncInstance['prepare']>;

// esbuild (at least up to 0.27.x) strips the `node:` prefix off
// `node:sqlite` because it treats `sqlite` as a Node built-in in its
// hardcoded list — but there is no bare `sqlite` built-in, so the
// emitted `import from "sqlite"` breaks at runtime. Resolve at runtime
// via createRequire so esbuild can't touch the specifier string.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as NodeSqliteModule;

/**
 * Open the csuite server database at `path` and apply the PRAGMAs
 * every module expects. Pass `:memory:` for an in-memory DB (tests,
 * ephemeral runs). The returned handle is owned by the caller —
 * typically `runServer`, which closes it during shutdown.
 */
export function openDatabase(path: string): DatabaseSyncInstance {
  const db = new DatabaseSync(path);
  // WAL gives concurrent read-while-write and bounded journal growth;
  // synchronous=NORMAL trades a small theoretical durability window
  // (losing the last-committed txn on a power cut between commit and
  // fsync) for a meaningful throughput win — acceptable for a chat /
  // activity workload where we'd rather ship the push
  // and recompute on restart than block on fsync.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Default wal_autocheckpoint is 1000 pages (~4MB at default page
  // size). Set it explicitly so the behavior is documented in-code
  // rather than implicit. Higher values reduce checkpoint overhead
  // on heavy-write paths (agent activity) at the cost of a larger
  // WAL on disk between checkpoints.
  db.exec('PRAGMA wal_autocheckpoint = 1000');
  // busy_timeout: if a writer is holding the lock when we try to
  // read/write, retry for up to 5 s before surfacing SQLITE_BUSY.
  // Matters more for the main broker DB (multiple modules use the
  // same handle, but any future multi-handle setup — e.g. the
  // activity store on its own DB file — benefits from consistent
  // timeout semantics).
  db.exec('PRAGMA busy_timeout = 5000');
  // recursive_triggers: OFF by default, and the default silently
  // disarms one of the annex's two append-only guards.
  //
  // `spine_events` has a BEFORE DELETE trigger enforcing that nothing
  // ever removes an event — the gapless stream is the whole recovery
  // story, and a delete-and-reinsert is how somebody would otherwise
  // rewrite a row's provenance while preserving its id and seq.
  // SQLite fires delete triggers for rows removed by REPLACE conflict
  // resolution IF AND ONLY IF this is on, so with the default an
  // `INSERT OR REPLACE` walks straight past that trigger. Measured
  // both ways before setting it.
  //
  // Connection-scoped, not stored in the file, so it has to be set on
  // every handle — which is why it lives here, at the one place a
  // handle is opened, rather than next to the trigger it arms.
  // Nothing else in the schema uses triggers, so there is no recursion
  // for it to deepen.
  db.exec('PRAGMA recursive_triggers = ON');
  return db;
}
