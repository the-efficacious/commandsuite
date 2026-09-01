/**
 * Member activity stream store.
 *
 * Append-only timeline per member, capturing everything the member's
 * runner observed, normalized from each agent's native instrumentation:
 * LLM exchanges and tool actions (Claude Code OTEL export, codex
 * app-server stream) plus objective lifecycle markers
 * (`objective_open` / `objective_close`). Objective traces are a
 * view over this stream — you query by time range bounded by the
 * markers for a given objectiveId.
 *
 * The store is a thin wrapper around SQLite plus an in-process
 * listener registry the live-tail endpoint subscribes to
 * (`GET /members/:name/activity/stream`, a WebSocket upgrade).
 * Appends fire the emitter synchronously after the insert commits,
 * so a subscriber attached during an append never misses a row — and
 * a subscriber that attaches AFTER an append can pull the tail via
 * `list()` and merge with the live stream, if the client cares about
 * zero gaps.
 *
 * Payloads are stored as JSON blobs (`event_json`). The server
 * doesn't introspect them beyond validating the discriminator at the
 * app layer; everything else is the SDK's responsibility.
 *
 * IDEMPOTENT ON `sourceId`. An event that names its source record (the
 * transcript line uuid, for Claude) lands at most once per member: the
 * `(member_name, source_id)` unique index is partial (`WHERE source_id
 * IS NOT NULL`), so id-less events — older runners, the driver-minted
 * brackets, the broker's own tool-invoke audit rows — are stored
 * exactly as before, and pre-existing rows are never touched by the
 * migration. `append` reports and fans out ONLY the rows that landed:
 * a duplicate is neither returned nor delivered to a live-tail
 * subscriber, because the subscriber already saw the original. This is
 * the broker's own defence against a runner replaying history (a
 * resumed transcript re-read from offset zero; a batch retried after a
 * lost ack): the runner's in-memory dedup is the first line, not the
 * only one.
 */

import { ActivityEventSchema } from 'csuite-sdk/schemas';
import type { ActivityEvent, ActivityRow } from 'csuite-sdk/types';
import {
  type ActivityListener,
  type ActivityStore as CoreActivityStore,
  type ListActivityFilter as CoreListActivityFilter,
  clampListLimit,
} from './activity-store.js';
import { logger as defaultLogger, type Logger } from './logger.js';
import { runInTransaction, type SqlDriver, type SqlStatement } from './sql-driver.js';

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS member_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_name TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    source_id TEXT
  );
  CREATE INDEX IF NOT EXISTS member_activity_member_ts_idx
    ON member_activity (member_name, ts);
  CREATE INDEX IF NOT EXISTS member_activity_member_kind_ts_idx
    ON member_activity (member_name, kind, ts);
  -- Capture health bounds on created_at, not ts, and runs per connected
  -- member on every roster poll (the web UI polls every 10s per client).
  -- Without this the created_at bound was a per-row filter over every
  -- llm_exchange the member ever recorded; with it the planner seeks the
  -- range. Measured with EXPLAIN QUERY PLAN, not assumed.
  CREATE INDEX IF NOT EXISTS member_activity_member_kind_created_idx
    ON member_activity (member_name, kind, created_at);
`;

/**
 * The dedup index, created AFTER the lazy `source_id` migration below so
 * an older database gains the column before anything indexes it.
 * Partial on purpose: rows without a source id (every row that predates
 * the column, and every id-less event) stay outside the uniqueness rule.
 */
const CREATE_SOURCE_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS member_activity_member_source_idx
    ON member_activity (member_name, source_id)
    WHERE source_id IS NOT NULL;
`;

interface ActivityRowRaw {
  id: number;
  member_name: string;
  ts: number;
  kind: string;
  event_json: string;
  created_at: number;
  source_id: string | null;
}

/**
 * Decode one persisted row into an `ActivityRow`, or `null` if the
 * stored payload no longer validates against the current
 * `ActivityEventSchema`. A malformed row is SKIPPED (logged + omitted)
 * rather than surfaced as a synthetic placeholder — the stream only
 * ever shows real captured activity, never a fabricated stand-in. This
 * should not happen in practice (the app layer validates on write), but
 * a stale/corrupt row must not break the whole query, and it must not
 * masquerade as a real event the runner never captured.
 */
function rowToActivity(row: ActivityRowRaw, log: Logger): ActivityRow | null {
  let event: ActivityEvent;
  try {
    event = ActivityEventSchema.parse(JSON.parse(row.event_json));
  } catch (err) {
    log.warn('skipped malformed activity row', {
      id: row.id,
      memberName: row.member_name,
      kind: row.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return {
    id: row.id,
    memberName: row.member_name,
    event,
    createdAt: row.created_at,
  };
}

export type ListActivityFilter = CoreListActivityFilter;
export type ActivityStore = CoreActivityStore;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

class SqliteActivityStore implements CoreActivityStore {
  private readonly db: SqlDriver;
  private readonly insertStmt: SqlStatement;
  private readonly listenersByMember = new Map<string, Set<ActivityListener>>();
  private readonly log: Logger;

  constructor(db: SqlDriver, log: Logger) {
    this.db = db;
    this.log = log;
    this.db.exec(CREATE_SCHEMA);
    // Best-effort migration for databases created before `source_id`
    // existed — the same lazy ALTER the event log and token store use.
    // Fresh databases already have the column from CREATE_SCHEMA, so the
    // ALTER fails with "duplicate column name" and that one error is
    // swallowed; anything else is a real problem and rethrows.
    try {
      this.db.exec('ALTER TABLE member_activity ADD COLUMN source_id TEXT');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column name')) throw err;
    }
    this.db.exec(CREATE_SOURCE_INDEX);
    // Upsert-ignore against the partial index. `ON CONFLICT ... DO
    // NOTHING` (not `INSERT OR IGNORE`) so only THIS uniqueness rule is
    // tolerated — a NOT NULL or CHECK violation must still throw rather
    // than silently drop a row. The conflict target names the index's
    // WHERE clause; SQLite matches partial indexes only when it does.
    this.insertStmt = db.prepare(
      `INSERT INTO member_activity (member_name, ts, kind, event_json, created_at, source_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (member_name, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    );
  }

  /**
   * Persist `events`, returning ONLY the rows that landed. An event whose
   * `sourceId` is already stored for this member is suppressed by the
   * partial unique index: it is not returned, and no listener fires for
   * it — the live tail already carried the original, and re-delivering
   * it would put the very duplicate this index exists to refuse in
   * front of every subscriber.
   */
  append(memberName: string, events: readonly ActivityEvent[]): ActivityRow[] {
    if (events.length === 0) return [];
    const now = Date.now();
    const inserted: ActivityRow[] = [];
    let suppressed = 0;

    // Transaction: either every row lands or none — atomicity goes
    // through the driver seam (runInTransaction).
    runInTransaction(this.db, () => {
      for (const event of events) {
        const result = this.insertStmt.run(
          memberName,
          event.ts,
          event.kind,
          JSON.stringify(event),
          now,
          event.sourceId ?? null,
        );
        // `changes` is the only honest signal that a row landed. On a
        // suppressed conflict SQLite reports 0 changes but leaves
        // `lastInsertRowid` at whatever the connection's LAST insert
        // was — reading it here would hand back a different row's id
        // as if it were this event's. Measured on node:sqlite, not
        // assumed.
        if (Number(result.changes) === 0) {
          suppressed++;
          continue;
        }
        inserted.push({
          id: Number(result.lastInsertRowid),
          memberName,
          event,
          createdAt: now,
        });
      }
    });

    if (suppressed > 0) {
      this.log.debug('suppressed duplicate activity by sourceId', {
        memberName,
        suppressed,
        inserted: inserted.length,
      });
    }

    // Snapshot listeners before iterating — a handler may unsubscribe
    // itself (or others) mid-fire. Mirrors InMemoryActivityStore.
    const listeners = this.listenersByMember.get(memberName);
    if (listeners) {
      for (const row of inserted) {
        for (const listener of [...listeners]) {
          listener(row);
        }
      }
    }

    return inserted;
  }

  /**
   * Page newest-first, REFILLING past malformed rows.
   *
   * Skipping a corrupt row without refilling returns a short page, and
   * every caller in the tree reads "shorter than limit" as "no more
   * rows" — so one bad row inside the window ends a trace early and
   * reports it as complete. The refill loop keeps reading, from a
   * cursor advanced over the raw rows (malformed ones included, or it
   * would re-read the same row forever), until it has `limit` valid
   * rows or SQLite returns a short raw page. Only the second case is
   * exhaustion, which restores the invariant the callers rely on: a
   * short page means there is nothing more to read.
   */
  list(filter: ListActivityFilter): ActivityRow[] {
    const limit = clampListLimit(filter.limit, MAX_LIMIT, DEFAULT_LIMIT);

    const conditions: string[] = ['member_name = ?'];
    const params: Array<string | number> = [filter.memberName];
    if (filter.from !== undefined) {
      conditions.push('ts >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      conditions.push('ts <= ?');
      params.push(filter.to);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      const placeholders = filter.kinds.map(() => '?').join(',');
      conditions.push(`kind IN (${placeholders})`);
      params.push(...filter.kinds);
    }
    const sql =
      `SELECT * FROM member_activity WHERE ${conditions.join(' AND ')} ` +
      `AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, id DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);

    // Open cursor: `before` when the caller paged, else past the newest
    // possible row. Number.MAX_SAFE_INTEGER is the sentinel rather than
    // a branch on two SQL shapes, so the statement is prepared once.
    let cursorTs = filter.before?.ts ?? Number.MAX_SAFE_INTEGER;
    let cursorId = filter.before?.id ?? Number.MAX_SAFE_INTEGER;

    const out: ActivityRow[] = [];
    while (out.length < limit) {
      const want = limit - out.length;
      const rows = stmt.all(
        ...params,
        cursorTs,
        cursorTs,
        cursorId,
        want,
      ) as unknown as ActivityRowRaw[];
      if (rows.length === 0) break;
      for (const raw of rows) {
        const activity = rowToActivity(raw, this.log);
        if (activity !== null) out.push(activity);
      }
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      cursorTs = last.ts;
      cursorId = last.id;
      // A short raw page is the only exhaustion signal — a full one
      // that decoded short means corrupt rows, so keep refilling.
      if (rows.length < want) break;
    }
    return out;
  }

  subscribe(memberName: string, listener: ActivityListener): () => void {
    let set = this.listenersByMember.get(memberName);
    if (!set) {
      set = new Set();
      this.listenersByMember.set(memberName, set);
    }
    set.add(listener);
    return () => {
      const current = this.listenersByMember.get(memberName);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listenersByMember.delete(memberName);
    };
  }

  /**
   * Delete every activity row older than `cutoffTs` (by `event.ts`).
   * Returns the number of rows deleted. Not part of the core
   * `ActivityStore` interface — a non-persistent backend has nothing
   * to prune — but surfaced on the SQLite impl for the
   * `csuite prune-traces` CLI and any future background-sweep timer.
   */
  prune(cutoffTs: number): number {
    const stmt = this.db.prepare('DELETE FROM member_activity WHERE ts < ?');
    const result = stmt.run(cutoffTs);
    return Number(result.changes ?? 0);
  }
}

export type SqliteActivityStoreHandle = SqliteActivityStore;

export function createSqliteActivityStore(
  db: SqlDriver,
  log: Logger = defaultLogger.child('member-activity'),
): SqliteActivityStoreHandle {
  return new SqliteActivityStore(db, log);
}

// Retention spans every table in the activity database, so it lives in
// `activity-retention.ts` rather than here — this module owns one table.
export { type PruneActivityResult, pruneActivityDb } from './activity-retention.js';

export { parseDurationMs } from './duration.js';
