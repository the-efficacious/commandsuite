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
    created_at INTEGER NOT NULL
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

interface ActivityRowRaw {
  id: number;
  member_name: string;
  ts: number;
  kind: string;
  event_json: string;
  created_at: number;
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
    this.insertStmt = db.prepare(
      `INSERT INTO member_activity (member_name, ts, kind, event_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
  }

  append(memberName: string, events: readonly ActivityEvent[]): ActivityRow[] {
    if (events.length === 0) return [];
    const now = Date.now();
    const inserted: ActivityRow[] = [];

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
        );
        const id = Number(result.lastInsertRowid ?? 0);
        inserted.push({
          id,
          memberName,
          event,
          createdAt: now,
        });
      }
    });

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
