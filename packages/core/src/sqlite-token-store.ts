/**
 * SQL-backed implementation of `TokenStore` over the `SqlDriver` seam.
 * See `token-store.ts` for the interface contract and the storage
 * rationale.
 *
 * The store does NOT own its driver — the caller opens one shared
 * database and passes it in.
 */

import type { TokenInfo, TokenOrigin } from 'csuite-sdk/types';
import { constantTimeEqual } from './hashing.js';
import type { SqlDriver, SqlStatement } from './sql-driver.js';
import {
  hashRawToken,
  type InsertHashedTokenInput,
  type InsertTokenInput,
  type InternalTokenRow,
  type TokenStore,
} from './token-store.js';

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tokens (
    id           TEXT PRIMARY KEY,
    member_name  TEXT NOT NULL,
    hash         TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL DEFAULT '',
    origin       TEXT NOT NULL DEFAULT 'bootstrap',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at   INTEGER,
    created_by   TEXT
  );
  CREATE INDEX IF NOT EXISTS tokens_hash_idx    ON tokens(hash);
  CREATE INDEX IF NOT EXISTS tokens_member_idx  ON tokens(member_name);
  CREATE INDEX IF NOT EXISTS tokens_expires_idx ON tokens(expires_at);
`;

interface RawTokenRow {
  id: string;
  member_name: string;
  hash: string;
  label: string;
  origin: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  created_by: string | null;
}

function rowToInfo(row: RawTokenRow): TokenInfo {
  // origin should always match the enum, but treat unknown values as
  // 'bootstrap' so a corrupted row doesn't take auth offline. The
  // server-side caller never inserts an invalid origin.
  const origin: TokenOrigin =
    row.origin === 'rotate' || row.origin === 'enroll' ? row.origin : 'bootstrap';
  return {
    id: row.id,
    memberName: row.member_name,
    label: row.label,
    origin,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
  };
}

/**
 * Write-coalescing window for `last_used_at` updates. Authenticated
 * requests are the dominant write pressure on this table; without
 * coalescing we'd touch the DB on every call. 30 seconds is long
 * enough to absorb burst traffic, short enough that the surfaced
 * "last seen" value stays meaningful for security review.
 */
const LAST_USED_DEBOUNCE_MS = 30_000;

export class SqliteTokenStore implements TokenStore {
  private readonly insertStmt: SqlStatement;
  private readonly findByHashStmt: SqlStatement;
  private readonly findByIdStmt: SqlStatement;
  private readonly listForMemberStmt: SqlStatement;
  private readonly touchStmt: SqlStatement;
  private readonly deleteStmt: SqlStatement;
  private readonly deleteForMemberStmt: SqlStatement;
  private readonly purgeStmt: SqlStatement;
  private readonly now: () => number;
  /**
   * Most-recent `last_used_at` write per token id. Lets us skip a DB
   * round-trip when the previous touch was within the debounce
   * window. Bounded by the live token count, which is tiny (one row
   * per active credential).
   */
  private readonly lastTouched = new Map<string, number>();

  constructor(db: SqlDriver, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    db.exec(CREATE_SCHEMA);
    // Best-effort migrations for older databases — same shape as the
    // event log's lazy column adds. Silent on duplicate-column errors.
    for (const sql of [
      `ALTER TABLE tokens ADD COLUMN origin TEXT NOT NULL DEFAULT 'bootstrap'`,
      `ALTER TABLE tokens ADD COLUMN created_by TEXT`,
    ]) {
      try {
        db.exec(sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('duplicate column')) throw err;
      }
    }
    this.insertStmt = db.prepare(
      `INSERT INTO tokens
         (id, member_name, hash, label, origin, created_at, last_used_at, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.findByHashStmt = db.prepare(
      'SELECT id, member_name, hash, label, origin, created_at, last_used_at, expires_at, created_by FROM tokens WHERE hash = ?',
    );
    this.findByIdStmt = db.prepare(
      'SELECT id, member_name, hash, label, origin, created_at, last_used_at, expires_at, created_by FROM tokens WHERE id = ?',
    );
    this.listForMemberStmt = db.prepare(
      'SELECT id, member_name, hash, label, origin, created_at, last_used_at, expires_at, created_by FROM tokens WHERE member_name = ? ORDER BY created_at ASC',
    );
    this.touchStmt = db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?');
    this.deleteStmt = db.prepare('DELETE FROM tokens WHERE id = ?');
    this.deleteForMemberStmt = db.prepare('DELETE FROM tokens WHERE member_name = ?');
    this.purgeStmt = db.prepare(
      'DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ?',
    );
  }

  async insert(input: InsertTokenInput): Promise<InternalTokenRow> {
    const hash = await hashRawToken(input.rawToken);
    const id = crypto.randomUUID();
    const createdAt = this.now();
    const label = (input.label ?? '').slice(0, 64);
    const origin: TokenOrigin = input.origin ?? 'bootstrap';
    const expiresAt = input.expiresAt ?? null;
    const createdBy = input.createdBy ?? null;
    this.insertStmt.run(
      id,
      input.memberName,
      hash,
      label,
      origin,
      createdAt,
      null,
      expiresAt,
      createdBy,
    );
    return {
      id,
      memberName: input.memberName,
      hash,
      label,
      origin,
      createdAt,
      lastUsedAt: null,
      expiresAt,
      createdBy,
    };
  }

  async insertHashed(input: InsertHashedTokenInput): Promise<InternalTokenRow> {
    const existing = this.findByHashStmt.get(input.hash) as RawTokenRow | undefined;
    if (existing) {
      return { ...rowToInfo(existing), hash: existing.hash };
    }
    const id = crypto.randomUUID();
    const createdAt = this.now();
    const label = (input.label ?? '').slice(0, 64);
    const origin: TokenOrigin = input.origin ?? 'bootstrap';
    const expiresAt = input.expiresAt ?? null;
    const createdBy = input.createdBy ?? null;
    this.insertStmt.run(
      id,
      input.memberName,
      input.hash,
      label,
      origin,
      createdAt,
      null,
      expiresAt,
      createdBy,
    );
    return {
      id,
      memberName: input.memberName,
      hash: input.hash,
      label,
      origin,
      createdAt,
      lastUsedAt: null,
      expiresAt,
      createdBy,
    };
  }

  async resolve(rawToken: string): Promise<InternalTokenRow | null> {
    const hash = await hashRawToken(rawToken);
    const raw = this.findByHashStmt.get(hash) as RawTokenRow | undefined;
    if (!raw) return null;
    const info = rowToInfo(raw);
    if (info.expiresAt !== null && info.expiresAt < this.now()) return null;
    // Belt-and-suspenders: confirm the row's hash equals what we
    // computed. The UNIQUE index already guarantees this, but a
    // constant-time check here means a future migration that loosens
    // the schema can't accidentally make the hash check timing-leaky.
    if (!constantTimeEqual(raw.hash, hash)) return null;
    return { ...info, hash: raw.hash };
  }

  async findById(id: string): Promise<InternalTokenRow | null> {
    const raw = this.findByIdStmt.get(id) as RawTokenRow | undefined;
    if (!raw) return null;
    return { ...rowToInfo(raw), hash: raw.hash };
  }

  async listForMember(memberName: string): Promise<TokenInfo[]> {
    const rows = this.listForMemberStmt.all(memberName) as unknown as RawTokenRow[];
    const t = this.now();
    return rows.map(rowToInfo).filter((r) => r.expiresAt === null || r.expiresAt >= t);
  }

  async touch(id: string): Promise<void> {
    const t = this.now();
    const last = this.lastTouched.get(id);
    if (last !== undefined && t - last < LAST_USED_DEBOUNCE_MS) return;
    this.lastTouched.set(id, t);
    this.touchStmt.run(t, id);
  }

  async touchNow(id: string): Promise<void> {
    const t = this.now();
    this.lastTouched.set(id, t);
    this.touchStmt.run(t, id);
  }

  async revoke(id: string): Promise<boolean> {
    this.lastTouched.delete(id);
    const result = this.deleteStmt.run(id);
    return Number(result.changes ?? 0) > 0;
  }

  async revokeAllForMember(memberName: string): Promise<number> {
    const result = this.deleteForMemberStmt.run(memberName);
    // Forget any debounce state for purged ids; we don't know their
    // ids without a pre-fetch, but lastTouched is bounded and the
    // entries become inert as soon as the rows are gone.
    return Number(result.changes ?? 0);
  }

  async purgeExpired(): Promise<number> {
    const result = this.purgeStmt.run(this.now());
    return Number(result.changes ?? 0);
  }
}

/**
 * Minimal member source for `createTokenStoreFromMembers` — the
 * structural subset of a member store the seeding walk needs.
 */
export interface TokenSeedMemberSource {
  members(): Iterable<{ name: string }>;
  tokenHashOf?(name: string): string | null | undefined;
}

/**
 * Open a SqliteTokenStore on `db` and seed it with the bootstrap hash
 * of every member that knows its own hash (currently: only in-memory
 * member stores used by tests do — DB-backed stores return null and
 * the loop becomes a no-op). Idempotent across re-calls.
 *
 * Production callers don't need this — member create / device-code
 * approve / rotate-token issue tokens via `insert` directly.
 */
export async function createTokenStoreFromMembers(
  db: SqlDriver,
  members: TokenSeedMemberSource,
  options: { now?: () => number } = {},
): Promise<SqliteTokenStore> {
  const store = new SqliteTokenStore(db, options);
  for (const m of members.members()) {
    const hash = members.tokenHashOf?.(m.name);
    if (!hash) continue;
    await store.insertHashed({
      memberName: m.name,
      hash,
      label: 'legacy',
      origin: 'bootstrap',
      createdBy: null,
    });
  }
  return store;
}
