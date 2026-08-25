/**
 * SQL-backed implementation of `EventLog` over the `SqlDriver` seam.
 *
 * Connection ownership: this class does NOT own its driver. The caller
 * opens one database and hands the same driver to every store that
 * needs it (event log, session store, push-subscription store, …).
 * Shutdown closes the database at the caller, not here.
 *
 * Schema evolution note: the `from_name` column was added alongside
 * named-token auth. Opening an older database file without the column
 * triggers a best-effort `ALTER TABLE ADD COLUMN` so existing deployments
 * don't need a manual migration. Pre-existing rows receive `from_name
 * IS NULL`, which rowToMessage maps to `from: null`.
 */

import type { Attachment, LogLevel, Message } from 'csuite-sdk/types';
import {
  channelThreadTag,
  clampQueryLimit,
  DEFAULT_QUERY_LIMIT,
  type EventLog,
  type EventLogAppendOptions,
  type EventLogQueryOptions,
  type EventLogTailOptions,
  GENERAL_CHANNEL_ID,
} from './event-log.js';
import type { SqlDriver, SqlStatement } from './sql-driver.js';

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
  recipients: string | null;
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
    attachments TEXT,
    recipients TEXT
  );
  CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);
  -- Every read here is \`WHERE ts < ? AND <filter> ORDER BY ts DESC\`, and
  -- with only the ts index the filter was applied per row: a DM or
  -- channel read walked every event newer than the cursor to find its
  -- own. These two make the filter a seek, measured with EXPLAIN QUERY
  -- PLAN rather than assumed (see event-log-query-plan.test.ts, which
  -- asserts the planner still picks them).
  --
  -- The DM index costs a temp b-tree for the ORDER BY, because the OR
  -- of the two directions is satisfied as a multi-index union that
  -- cannot come back in ts order. That trade is right for this shape:
  -- one pair's messages are a small slice of a team's whole event log,
  -- so sorting the slice beats scanning the log.
  CREATE INDEX IF NOT EXISTS events_from_to_ts_idx ON events (from_name, to_name, ts);
  CREATE INDEX IF NOT EXISTS events_thread_ts_idx
    ON events (json_extract(data, '$.thread'), ts);
`;

export class SqliteEventLog implements EventLog {
  private readonly db: SqlDriver;
  private readonly insertStmt: SqlStatement;
  private readonly tailSinceStmt: SqlStatement;
  private readonly queryFeedStmt: SqlStatement;
  private readonly queryDmStmt: SqlStatement;
  private readonly queryChannelStmt: SqlStatement;
  private readonly queryGeneralStmt: SqlStatement;

  constructor(db: SqlDriver) {
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
      'ALTER TABLE events ADD COLUMN recipients TEXT',
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
      'INSERT INTO events (id, ts, to_name, from_name, title, body, level, data, attachments, recipients) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.tailSinceStmt = this.db.prepare(
      'SELECT id, ts, to_name, from_name, title, body, level, data, attachments, recipients FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?',
    );
    // Default feed — the SQL half of `feedVisibleTo` in event-log.ts.
    // The two answer the same question and must move together; the
    // shared cases run against both in event-log-scope.test.ts.
    //
    // Three clauses, in the order they were needed:
    //
    //   1. Addressing. A DM reaches its two ends.
    //   2. Secret lifecycle events reach nobody's feed, unconditionally.
    //      `GET /secrets` is the surface built for that question.
    //   3. Audience. A fan-out push persists `to_name = NULL`, so
    //      without this clause `to_name IS NULL` hands every
    //      channel-scoped and objective-scoped message to every member
    //      — live delivery was already scoped, and the durable read
    //      disagreed with it. Rows written since carry the recipient
    //      list the fan-out used; rows written before it cannot say who
    //      they were for, so a scoped thread or recipient-list event kind
    //      withholds one from everyone but its sender.
    this.queryFeedStmt = this.db.prepare(
      `SELECT id, ts, to_name, from_name, title, body, level, data, attachments, recipients
       FROM events
       WHERE ts < ?1
         AND (to_name IS NULL OR from_name = ?2 OR to_name = ?2)
         AND (
           json_extract(data, '$.thread') IS NULL
           OR json_extract(data, '$.thread') NOT LIKE 'secret:%'
         )
         AND (
           from_name = ?2
           OR CASE
                WHEN recipients IS NOT NULL
                  THEN EXISTS (
                    SELECT 1 FROM json_each(events.recipients) WHERE value = ?2
                  )
                WHEN to_name IS NOT NULL
                  THEN to_name = ?2
                ELSE (
                  json_extract(data, '$.kind') IS NULL
                  OR json_extract(data, '$.kind') NOT IN ('instructions', 'context_control')
                )
                AND (
                  json_extract(data, '$.thread') IS NULL
                  OR json_extract(data, '$.thread') = 'chan:general'
                  OR (
                    json_extract(data, '$.thread') NOT LIKE 'chan:%'
                    AND json_extract(data, '$.thread') NOT LIKE 'obj:%'
                    AND json_extract(data, '$.thread') NOT LIKE 'tool:%'
                    AND json_extract(data, '$.thread') NOT LIKE 'variable:%'
                    AND json_extract(data, '$.thread') NOT LIKE 'hook:%'
                  )
                )
              END
         )
       ORDER BY ts DESC LIMIT ?3`,
    );
    this.queryDmStmt = this.db.prepare(
      `SELECT id, ts, to_name, from_name, title, body, level, data, attachments, recipients
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
    // (`json_extract`); part of the driver's required dialect.
    this.queryChannelStmt = this.db.prepare(
      `SELECT id, ts, to_name, from_name, title, body, level, data, attachments, recipients
       FROM events
       WHERE ts < ?
         AND json_extract(data, '$.thread') = ?
       ORDER BY ts DESC LIMIT ?`,
    );
    // General channel: include both the explicit-tag variant AND
    // any untagged broadcast (`to_name IS NULL` with no `data.thread`).
    // Mirrors `matchesChannel` in the in-memory log.
    this.queryGeneralStmt = this.db.prepare(
      `SELECT id, ts, to_name, from_name, title, body, level, data, attachments, recipients
       FROM events
       WHERE ts < ?
         AND (
           json_extract(data, '$.thread') = ?
           OR (to_name IS NULL AND json_extract(data, '$.thread') IS NULL)
         )
       ORDER BY ts DESC LIMIT ?`,
    );
  }

  async append(message: Message, options: EventLogAppendOptions = {}): Promise<void> {
    // An empty list is still an audience — a channel whose only member
    // is offline fans out to nobody live, and that message is not
    // team-visible afterwards. `[]` and `null` must not collapse.
    const recipients = options.recipients ?? null;
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
      recipients === null ? null : JSON.stringify([...recipients]),
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
      rows = this.queryFeedStmt.all(before, options.viewer, limit) as unknown as EventRow[];
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
