/**
 * SQL-backed implementation of `SessionStore` over the `SqlDriver`
 * seam. See `session-store.ts` for the interface contract and the
 * session lifecycle documentation.
 *
 * The store does NOT own the driver — the caller opens one shared
 * database and passes it here alongside the other stores.
 */

import { randomBase64Url } from './random-id.js';
import { SESSION_TTL_MS, type SessionRow, type SessionStore } from './session-store.js';
import type { SqlDriver, SqlStatement } from './sql-driver.js';

/** How many bytes of entropy per session id. 32 bytes = 256 bits. */
const SESSION_ID_BYTES = 32;

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    member_name TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    user_agent  TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_member_idx ON sessions(member_name);
  CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
`;

interface RawRow {
  id: string;
  member_name: string;
  created_at: number;
  expires_at: number;
  last_seen: number;
  user_agent: string | null;
}

function rowToSession(row: RawRow): SessionRow {
  return {
    id: row.id,
    memberName: row.member_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeen: row.last_seen,
    userAgent: row.user_agent,
  };
}

export class SqliteSessionStore implements SessionStore {
  private readonly insertStmt: SqlStatement;
  private readonly selectStmt: SqlStatement;
  private readonly touchStmt: SqlStatement;
  private readonly deleteStmt: SqlStatement;
  private readonly purgeStmt: SqlStatement;
  private readonly now: () => number;

  constructor(db: SqlDriver, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    db.exec(CREATE_SCHEMA);
    this.insertStmt = db.prepare(
      'INSERT INTO sessions (id, member_name, created_at, expires_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.selectStmt = db.prepare(
      'SELECT id, member_name, created_at, expires_at, last_seen, user_agent FROM sessions WHERE id = ?',
    );
    this.touchStmt = db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?');
    this.deleteStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
    this.purgeStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
  }

  async create(memberName: string, userAgent: string | null): Promise<SessionRow> {
    const id = randomBase64Url(SESSION_ID_BYTES);
    const now = this.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.insertStmt.run(id, memberName, now, expiresAt, now, userAgent);
    return {
      id,
      memberName,
      createdAt: now,
      expiresAt,
      lastSeen: now,
      userAgent,
    };
  }

  async get(id: string): Promise<SessionRow | null> {
    const raw = this.selectStmt.get(id) as RawRow | undefined;
    if (!raw) return null;
    const row = rowToSession(raw);
    if (row.expiresAt < this.now()) return null;
    return row;
  }

  async touch(id: string): Promise<void> {
    const now = this.now();
    this.touchStmt.run(now, now + SESSION_TTL_MS, id);
  }

  async delete(id: string): Promise<void> {
    this.deleteStmt.run(id);
  }

  async purgeExpired(): Promise<number> {
    const result = this.purgeStmt.run(this.now());
    return Number(result.changes ?? 0);
  }
}
