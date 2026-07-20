/**
 * SQLite-backed implementation of `csuite-core`'s EventLog using
 * Node's built-in `node:sqlite` module.
 *
 * Why `node:sqlite` over `better-sqlite3`:
 *   - Zero native addons in the install graph — no node-gyp, no prebuild
 *     download, no C++ toolchain requirement. Alpine/minimal containers
 *     and future Bun-compile paths just work.
 *   - Same synchronous API shape as `better-sqlite3`, so the SqliteEventLog
 *     surface is essentially a rename.
 *
 * Connection ownership: this class does NOT own its DatabaseSync
 * handle. The caller (runServer) opens one DB via `openDatabase()` and
 * passes it to every module that needs it (event log, session store,
 * push-subscription store). Shutdown closes the DB at the caller, not
 * here. This is a single-connection-per-process model — `node:sqlite`
 * doesn't like two handles on the same file.
 *
 * Schema evolution note: the `from_name` column was added alongside
 * named-token auth. Opening an older database file without the column
 * triggers a best-effort `ALTER TABLE ADD COLUMN` so existing deployments
 * don't need a manual migration. Pre-existing rows receive `from_name
 * IS NULL`, which rowToMessage maps to `from: null`.
 */

import {
  channelThreadTag,
  clampQueryLimit,
  DEFAULT_QUERY_LIMIT,
  type EventLog,
  type EventLogQueryOptions,
  type EventLogTailOptions,
  GENERAL_CHANNEL_ID,
} from 'csuite-core';
import type { Attachment, LogLevel, Message } from 'csuite-sdk/types';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';

interface EventRow {
  id: string;
  ts: number;
  to_name: string | null;
  from_name: string | null;
  title: string | null;
  body: string;
  level: string;
  data: string;
  attachments: string | null;
}

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    to_name TEXT,
    from_name TEXT,
    title TEXT,
    body TEXT NOT NULL,
    level TEXT NOT NULL,
    data TEXT NOT NULL,
    attachments TEXT
  );
  CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);
`;

export class SqliteEventLog implements EventLog {
  private readonly db: DatabaseSyncInstance;
  private readonly insertStmt: StatementInstance;
  private readonly tailSinceStmt: StatementInstance;
  private readonly queryFeedStmt: StatementInstance;
  private readonly queryDmStmt: StatementInstance;
  private readonly queryChannelStmt: StatementInstance;
  private readonly queryGeneralStmt: StatementInstance;

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    this.db.exec(CREATE_SCHEMA);
    // Best-effort migration for databases created by an earlier version
    // that predates the `from_name` column. The ALTER fails with
    // "duplicate column name" on fresh DBs where CREATE_SCHEMA already
    // defined the column — that's expected and we swallow only that
    // specific case. Any other SQL error is a real problem and rethrows.
    // Two legacy migrations — each wrapped individually so a partial
    // success doesn't skip the remaining ALTERs.
    for (const alter of [
      'ALTER TABLE events ADD COLUMN from_name TEXT',
      'ALTER TABLE events ADD COLUMN attachments TEXT',
    ]) {
      try {
        this.db.exec(alter);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (!msg.includes('duplicate column name')) {
          throw err;
        }
      }
    }
    this.insertStmt = this.db.prepare(
      'INSERT INTO events (id, ts, to_name, from_name, title, body, level, data, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.tailSinceStmt = this.db.prepare(
      'SELECT id, ts, to_name, from_name, title, body, level, data, attachments FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?',
    );
    this.queryFeedStmt = this.db.prepare(
      `SELECT id, ts, to_name, from_name, title, body, level, data, attachments
       FROM events
       WHERE ts < ?
         AND (to_name IS NULL OR from_name = ? OR to_name = ?)
       ORDER BY ts DESC LIMIT ?`,
    );
    this.queryDmStmt = this.db.prepare(
      `SELECT id, ts, to_name, from_name, title, body, level, data, attachments
       FROM events
       WHERE ts < ?
         AND to_name IS NOT NULL
         AND (
           (from_name = ? AND to_name = ?)
           OR (from_name = ? AND to_name = ?)
         )
       ORDER BY ts DESC LIMIT ?`,
    );
    // Channel filter: rows whose JSON `data.thread` matches the
    // expected `chan:<id>` tag. Uses SQLite's JSON1 extension
    // (`json_extract`); shipped with `node:sqlite` by default.
    this.queryChannelStmt = this.db.prepare(
      `SELECT id, ts, to_name, from_name, title, body, level, data, attachments
       FROM events
       WHERE ts < ?
         AND json_extract(data, '$.thread') = ?
       ORDER BY ts DESC LIMIT ?`,
    );
    // General channel: include both the explicit-tag variant AND
    // any untagged broadcast (`to_name IS NULL` with no `data.thread`).
    // Mirrors `matchesChannel` in `csuite-core`'s in-memory log.
    this.queryGeneralStmt = this.db.prepare(
      `SELECT id, ts, to_name, from_name, title, body, level, data, attachments
       FROM events
       WHERE ts < ?
         AND (
           json_extract(data, '$.thread') = ?
           OR (to_name IS NULL AND json_extract(data, '$.thread') IS NULL)
         )
       ORDER BY ts DESC LIMIT ?`,
    );
  }

  async append(message: Message): Promise<void> {
    this.insertStmt.run(
      message.id,
      message.ts,
      message.to,
      message.from,
      message.title,
      message.body,
      message.level,
      JSON.stringify(message.data),
      message.attachments.length > 0 ? JSON.stringify(message.attachments) : null,
    );
  }

  async tail(options: EventLogTailOptions = {}): Promise<Message[]> {
    const since = options.since ?? 0;
    const limit = options.limit ?? DEFAULT_QUERY_LIMIT;
    const rows = this.tailSinceStmt.all(since, limit) as unknown as EventRow[];
    return rows.reverse().map(rowToMessage);
  }

  async query(options: EventLogQueryOptions): Promise<Message[]> {
    const limit = clampQueryLimit(options.limit);
    const before = options.before ?? Number.MAX_SAFE_INTEGER;

    let rows: EventRow[];
    if (options.channel !== undefined) {
      const tag = channelThreadTag(options.channel);
      const stmt =
        options.channel === GENERAL_CHANNEL_ID ? this.queryGeneralStmt : this.queryChannelStmt;
      rows = stmt.all(before, tag, limit) as unknown as EventRow[];
    } else if (options.with) {
      rows = this.queryDmStmt.all(
        before,
        options.viewer,
        options.with,
        options.with,
        options.viewer,
        limit,
      ) as unknown as EventRow[];
    } else {
      rows = this.queryFeedStmt.all(
        before,
        options.viewer,
        options.viewer,
        limit,
      ) as unknown as EventRow[];
    }
    return rows.map(rowToMessage);
  }

  /**
   * No-op for compatibility with the EventLog interface. The database
   * connection is owned by the caller (see constructor doc). Kept so
   * existing `eventLog.close()` call sites stay valid.
   */
  async close(): Promise<void> {
    // intentionally empty — DB lifecycle is owned by the caller
  }
}

const VALID_LEVELS: ReadonlySet<LogLevel> = new Set<LogLevel>([
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
]);

function rowToMessage(row: EventRow): Message {
  // Defensive level validation — if a stale or hand-edited DB row has
  // a bogus level string, fall back to 'info' rather than propagating
  // an invalid LogLevel to the wire (would fail MessageSchema downstream).
  const level: LogLevel = VALID_LEVELS.has(row.level as LogLevel)
    ? (row.level as LogLevel)
    : 'info';

  return {
    id: row.id,
    ts: row.ts,
    to: row.to_name,
    from: row.from_name,
    title: row.title,
    body: row.body,
    level,
    data: JSON.parse(row.data) as Record<string, unknown>,
    attachments: parseAttachments(row.attachments),
  };
}

function parseAttachments(raw: string | null): Attachment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Attachment[];
  } catch {
    /* malformed JSON — fall through to empty */
  }
  return [];
}
