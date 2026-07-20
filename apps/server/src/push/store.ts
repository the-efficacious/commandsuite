/**
 * SQLite-backed push subscription store.
 *
 * A "push subscription" is a capability URL + crypto keys the browser
 * hands us after `pushManager.subscribe()`. Treat the endpoint like a
 * session token: anyone holding it can push to the device. We store
 * one row per (member, endpoint) pair; the same human can have many
 * devices enrolled.
 *
 * Dead-subscription cleanup: when web-push returns 404 or 410 we mark
 * and delete the row so the next fanout doesn't keep spending CPU on
 * a lost device. `last_error_code` is kept for ops debugging in case
 * we want to know why a sub was dropped.
 */

import type { DatabaseSyncInstance, StatementInstance } from '../db.js';

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

export interface PushSubscriptionRow {
  id: number;
  memberName: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastErrorCode: number | null;
}

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

export interface PushSubscriptionInput {
  memberName: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

export class PushSubscriptionStore {
  private readonly db: DatabaseSyncInstance;
  private readonly upsertStmt: StatementInstance;
  private readonly selectByMemberStmt: StatementInstance;
  private readonly selectByEndpointStmt: StatementInstance;
  private readonly deleteByIdStmt: StatementInstance;
  private readonly deleteByEndpointStmt: StatementInstance;
  private readonly markSuccessStmt: StatementInstance;
  private readonly markErrorStmt: StatementInstance;
  private readonly now: () => number;

  constructor(db: DatabaseSyncInstance, options: { now?: () => number } = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.db.exec(CREATE_SCHEMA);

    // Endpoint is UNIQUE — re-subscribing from the same device with
    // the same endpoint replaces the existing row's crypto keys and
    // refreshes created_at. SQLite's ON CONFLICT handles this atomically.
    this.upsertStmt = this.db.prepare(
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
    this.selectByMemberStmt = this.db.prepare(
      `SELECT id, member_name, endpoint, p256dh, auth, user_agent,
              created_at, last_success_at, last_error_at, last_error_code
       FROM push_subscriptions WHERE member_name = ?`,
    );
    this.selectByEndpointStmt = this.db.prepare(
      `SELECT id, member_name, endpoint, p256dh, auth, user_agent,
              created_at, last_success_at, last_error_at, last_error_code
       FROM push_subscriptions WHERE endpoint = ?`,
    );
    this.deleteByIdStmt = this.db.prepare(
      'DELETE FROM push_subscriptions WHERE id = ? AND member_name = ?',
    );
    this.deleteByEndpointStmt = this.db.prepare(
      'DELETE FROM push_subscriptions WHERE endpoint = ?',
    );
    this.markSuccessStmt = this.db.prepare(
      'UPDATE push_subscriptions SET last_success_at = ?, last_error_at = NULL, last_error_code = NULL WHERE id = ?',
    );
    this.markErrorStmt = this.db.prepare(
      'UPDATE push_subscriptions SET last_error_at = ?, last_error_code = ? WHERE id = ?',
    );
  }

  /**
   * Register (or refresh) a push subscription for a member. Returns
   * the persisted row. Idempotent on endpoint — calling twice with
   * the same endpoint replaces the row rather than duplicating.
   */
  upsert(input: PushSubscriptionInput): PushSubscriptionRow {
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
      throw new Error('PushSubscriptionStore.upsert: row missing after insert');
    }
    return rowToSub(row);
  }

  listForMember(name: string): PushSubscriptionRow[] {
    const rows = this.selectByMemberStmt.all(name) as unknown as RawRow[];
    return rows.map(rowToSub);
  }

  findByEndpoint(endpoint: string): PushSubscriptionRow | null {
    const row = this.selectByEndpointStmt.get(endpoint) as RawRow | undefined;
    return row ? rowToSub(row) : null;
  }

  /**
   * Delete a subscription the given member owns. Scoped by name
   * so a session can't delete other members' subscriptions even with
   * a guessed id.
   */
  deleteForMember(id: number, memberName: string): void {
    this.deleteByIdStmt.run(id, memberName);
  }

  /**
   * Delete by endpoint — used by the dispatch path when a push
   * attempt returns 404/410 Gone and we need to purge the dead sub
   * atomically (we don't necessarily know the id at that point).
   */
  deleteByEndpoint(endpoint: string): void {
    this.deleteByEndpointStmt.run(endpoint);
  }

  markSuccess(id: number): void {
    this.markSuccessStmt.run(this.now(), id);
  }

  markError(id: number, statusCode: number): void {
    this.markErrorStmt.run(this.now(), statusCode, id);
  }
}
