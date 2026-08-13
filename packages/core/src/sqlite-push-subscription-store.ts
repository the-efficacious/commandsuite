/**
 * SQL-backed implementation of `PushSubscriptionStore` over the
 * `SqlDriver` seam. See `push-subscription-store.ts` for the interface
 * contract and the subscription lifecycle documentation.
 *
 * Endpoint is UNIQUE — re-subscribing from the same device with the
 * same endpoint replaces the existing row's crypto keys and refreshes
 * `created_at`; SQLite's ON CONFLICT handles this atomically.
 */

import type {
  PushSubscriptionInput,
  PushSubscriptionRow,
  PushSubscriptionStore,
} from './push-subscription-store.js';
import type { SqlDriver, SqlStatement } from './sql-driver.js';

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    member_name     TEXT NOT NULL,
    endpoint        TEXT NOT NULL UNIQUE,
    p256dh          TEXT NOT NULL,
    auth            TEXT NOT NULL,
    user_agent      TEXT,
    created_at      INTEGER NOT NULL,
    last_success_at INTEGER,
    last_error_at   INTEGER,
    last_error_code INTEGER
  );
  CREATE INDEX IF NOT EXISTS push_subscriptions_member_idx ON push_subscriptions(member_name);
`;

interface RawRow {
  id: number;
  member_name: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: number;
  last_success_at: number | null;
  last_error_at: number | null;
  last_error_code: number | null;
}

function rowToSub(row: RawRow): PushSubscriptionRow {
  return {
    id: row.id,
    memberName: row.member_name,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    lastErrorCode: row.last_error_code,
  };
}

export class SqlitePushSubscriptionStore implements PushSubscriptionStore {
  private readonly upsertStmt: SqlStatement;
  private readonly selectByMemberStmt: SqlStatement;
  private readonly selectByEndpointStmt: SqlStatement;
  private readonly deleteByIdStmt: SqlStatement;
  private readonly deleteByEndpointStmt: SqlStatement;
  private readonly markSuccessStmt: SqlStatement;
  private readonly markErrorStmt: SqlStatement;
  private readonly now: () => number;

  constructor(db: SqlDriver, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    db.exec(CREATE_SCHEMA);
    this.upsertStmt = db.prepare(
      `INSERT INTO push_subscriptions
         (member_name, endpoint, p256dh, auth, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         member_name       = excluded.member_name,
         p256dh          = excluded.p256dh,
         auth            = excluded.auth,
         user_agent      = excluded.user_agent,
         created_at      = excluded.created_at,
         last_error_at   = NULL,
         last_error_code = NULL`,
    );
    this.selectByMemberStmt = db.prepare(
      `SELECT id, member_name, endpoint, p256dh, auth, user_agent,
              created_at, last_success_at, last_error_at, last_error_code
       FROM push_subscriptions WHERE member_name = ?`,
    );
    this.selectByEndpointStmt = db.prepare(
      `SELECT id, member_name, endpoint, p256dh, auth, user_agent,
              created_at, last_success_at, last_error_at, last_error_code
       FROM push_subscriptions WHERE endpoint = ?`,
    );
    this.deleteByIdStmt = db.prepare(
      'DELETE FROM push_subscriptions WHERE id = ? AND member_name = ?',
    );
    this.deleteByEndpointStmt = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
    this.markSuccessStmt = db.prepare(
      'UPDATE push_subscriptions SET last_success_at = ?, last_error_at = NULL, last_error_code = NULL WHERE id = ?',
    );
    this.markErrorStmt = db.prepare(
      'UPDATE push_subscriptions SET last_error_at = ?, last_error_code = ? WHERE id = ?',
    );
  }

  async upsert(input: PushSubscriptionInput): Promise<PushSubscriptionRow> {
    const now = this.now();
    this.upsertStmt.run(
      input.memberName,
      input.endpoint,
      input.p256dh,
      input.auth,
      input.userAgent,
      now,
    );
    const row = this.selectByEndpointStmt.get(input.endpoint) as RawRow | undefined;
    if (!row) {
      // Should be impossible — we just inserted it. Surface loudly
      // rather than pretend we lost a write.
      throw new Error('SqlitePushSubscriptionStore.upsert: row missing after insert');
    }
    return rowToSub(row);
  }

  async listForMember(memberName: string): Promise<PushSubscriptionRow[]> {
    const rows = this.selectByMemberStmt.all(memberName) as unknown as RawRow[];
    return rows.map(rowToSub);
  }

  async findByEndpoint(endpoint: string): Promise<PushSubscriptionRow | null> {
    const row = this.selectByEndpointStmt.get(endpoint) as RawRow | undefined;
    return row ? rowToSub(row) : null;
  }

  async deleteForMember(id: number, memberName: string): Promise<void> {
    this.deleteByIdStmt.run(id, memberName);
  }

  async deleteByEndpoint(endpoint: string): Promise<void> {
    this.deleteByEndpointStmt.run(endpoint);
  }

  async markSuccess(id: number): Promise<void> {
    this.markSuccessStmt.run(this.now(), id);
  }

  async markError(id: number, statusCode: number): Promise<void> {
    this.markErrorStmt.run(this.now(), statusCode, id);
  }
}
