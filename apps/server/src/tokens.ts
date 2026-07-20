/**
 * SQLite-backed token store for multi-token-per-member bearer auth.
 *
 * Each row is one issued token; a member may have many at once
 * ("laptop", "ci-runner", "prod-vm-east"). Tokens are stored as
 * sha256 hashes — plaintext is shown to the issuer exactly once and
 * never persisted. Rows can carry an optional `expires_at`; a
 * token past its expiry resolves the same as a deleted row (auth
 * 401, no special UX).
 *
 * Why this lives in SQLite instead of in `csuite.json`:
 *   - per-request `last_used_at` updates would otherwise rewrite
 *     the team config on every authenticated call
 *   - multi-token semantics need cheap inserts/deletes per token,
 *     not per-member JSON rewrites
 *   - audit-log queries can join on the same DB
 *
 * `csuite.json` keeps the bootstrap path: a member's `tokenHash` (or
 * plaintext `token`, hand-edited) is read on first boot and migrated
 * into this store with `origin = 'bootstrap'`. After migration the
 * resolver looks here only — the JSON hash is no longer load-bearing,
 * though we leave it in place so the file stays human-readable.
 *
 * The store does NOT own its DB handle — `runServer` opens one
 * shared `DatabaseSync` and passes it in.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { TokenInfo, TokenOrigin } from 'csuite-sdk/types';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';

export const TOKEN_HASH_PREFIX = 'sha256:';

/**
 * Hash a raw bearer token into the on-disk representation. Same
 * algorithm as the legacy `members.hashToken` so values round-trip
 * cleanly across the migration.
 */
export function hashRawToken(rawToken: string): string {
  return TOKEN_HASH_PREFIX + createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Generate a fresh cryptorandom bearer token in the standard
 * `csuite_<base64url>` format. 32 raw bytes → 43-char payload (~256 bits).
 *
 * Identical to `members.generateMemberToken` — re-exported here so
 * the new auth surface doesn't have to import from `members.ts`
 * (avoids a soft circular dep when `members.ts` later wants to call
 * back into the token store for boot-time seeding).
 */
export function generateBearerToken(): string {
  return `csuite_${randomBytes(32).toString('base64url')}`;
}

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
 * `TokenInfo` plus the on-disk `hash` — internal-only. The wire shape
 * never carries the hash (it's a credential surface), but the auth
 * resolver needs it to confirm the row matches the presented token.
 */
export interface InternalTokenRow extends TokenInfo {
  hash: string;
}

/**
 * Write-coalescing window for `last_used_at` updates. Authenticated
 * requests are the dominant write pressure on this table; without
 * coalescing we'd touch the DB on every call. 30 seconds is long
 * enough to absorb burst traffic, short enough that the surfaced
 * "last seen" value stays meaningful for security review.
 */
const LAST_USED_DEBOUNCE_MS = 30_000;

export interface InsertTokenInput {
  memberName: string;
  rawToken: string;
  label?: string;
  origin?: TokenOrigin;
  /** Epoch ms; null/undefined = no expiry. */
  expiresAt?: number | null;
  /** Member name that issued this token, or null for bootstrap. */
  createdBy?: string | null;
}

/**
 * Migration-only insertion path. Used by `runServer` at boot to copy
 * a member's `tokenHash` from `csuite.json` into the token store with
 * `origin = 'bootstrap'`. The plaintext is unknown (we only have the
 * hash on disk), so the regular `insert` path is unusable here.
 *
 * Idempotent: if the hash is already present (re-boot, re-migration)
 * the insertion is skipped and the existing row is returned.
 */
export interface InsertHashedTokenInput {
  memberName: string;
  /** Pre-computed `sha256:<hex>` hash. */
  hash: string;
  label?: string;
  origin?: TokenOrigin;
  expiresAt?: number | null;
  createdBy?: string | null;
}

export class TokenStore {
  private readonly db: DatabaseSyncInstance;
  private readonly insertStmt: StatementInstance;
  private readonly findByHashStmt: StatementInstance;
  private readonly findByIdStmt: StatementInstance;
  private readonly listForMemberStmt: StatementInstance;
  private readonly touchStmt: StatementInstance;
  private readonly deleteStmt: StatementInstance;
  private readonly deleteForMemberStmt: StatementInstance;
  private readonly purgeStmt: StatementInstance;
  private readonly now: () => number;
  /**
   * Most-recent `last_used_at` write per token id. Lets us skip a DB
   * round-trip when the previous touch was within the debounce
   * window. Bounded by the live token count, which is tiny (one row
   * per active credential).
   */
  private readonly lastTouched = new Map<string, number>();

  constructor(db: DatabaseSyncInstance, options: { now?: () => number } = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.db.exec(CREATE_SCHEMA);
    // Best-effort migrations for older databases — same shape as the
    // event log's lazy column adds. Silent on duplicate-column errors.
    for (const sql of [
      `ALTER TABLE tokens ADD COLUMN origin TEXT NOT NULL DEFAULT 'bootstrap'`,
      `ALTER TABLE tokens ADD COLUMN created_by TEXT`,
    ]) {
      try {
        this.db.exec(sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('duplicate column')) throw err;
      }
    }
    this.insertStmt = this.db.prepare(
      `INSERT INTO tokens
         (id, member_name, hash, label, origin, created_at, last_used_at, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.findByHashStmt = this.db.prepare(
      'SELECT id, member_name, hash, label, origin, created_at, last_used_at, expires_at, created_by FROM tokens WHERE hash = ?',
    );
    this.findByIdStmt = this.db.prepare(
      'SELECT id, member_name, hash, label, origin, created_at, last_used_at, expires_at, created_by FROM tokens WHERE id = ?',
    );
    this.listForMemberStmt = this.db.prepare(
      'SELECT id, member_name, hash, label, origin, created_at, last_used_at, expires_at, created_by FROM tokens WHERE member_name = ? ORDER BY created_at ASC',
    );
    this.touchStmt = this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?');
    this.deleteStmt = this.db.prepare('DELETE FROM tokens WHERE id = ?');
    this.deleteForMemberStmt = this.db.prepare('DELETE FROM tokens WHERE member_name = ?');
    this.purgeStmt = this.db.prepare(
      'DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ?',
    );
  }

  /**
   * Insert a fresh token row. Returns the public projection plus the
   * on-disk hash so the caller can pair it with the plaintext for
   * one-time display. Throws on UNIQUE-violation if an identical hash
   * already exists (~ infinitesimal probability — surface as a 500-
   * level retryable error at the caller).
   */
  insert(input: InsertTokenInput): InternalTokenRow {
    const hash = hashRawToken(input.rawToken);
    const id = randomUUID();
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

  /**
   * Migration helper: insert a row from a pre-computed hash. Used by
   * `runServer` when seeding the store from `csuite.json`'s legacy
   * `tokenHash` field — the plaintext was lost when the JSON was
   * first written. Idempotent: if a row with this hash already
   * exists the existing row is returned (which makes re-boots and
   * concurrent migrations safe).
   */
  insertHashed(input: InsertHashedTokenInput): InternalTokenRow {
    const existing = this.findByHashStmt.get(input.hash) as RawTokenRow | undefined;
    if (existing) {
      return { ...rowToInfo(existing), hash: existing.hash };
    }
    const id = randomUUID();
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

  /**
   * Resolve a presented bearer plaintext to an active token row.
   * Returns null when:
   *   - no row matches the hash
   *   - the row matches but has an `expires_at` in the past
   *
   * Constant-time-ish: the hash lookup is a primary-key SQL fetch so
   * the wall-clock cost is bounded by SQLite's index lookup, not by
   * a Map.get() chain timing variance.
   */
  resolve(rawToken: string): InternalTokenRow | null {
    const hash = hashRawToken(rawToken);
    const raw = this.findByHashStmt.get(hash) as RawTokenRow | undefined;
    if (!raw) return null;
    const info = rowToInfo(raw);
    if (info.expiresAt !== null && info.expiresAt < this.now()) return null;
    // Belt-and-suspenders: confirm the row's hash equals what we
    // computed. SQLite's UNIQUE index already guarantees this, but a
    // timingSafeEqual here means a future migration that loosens the
    // schema can't accidentally make the hash check non-constant-time.
    const a = Buffer.from(raw.hash, 'utf8');
    const b = Buffer.from(hash, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { ...info, hash: raw.hash };
  }

  /**
   * Find a token row by id (for revoke). Does not check expiry — an
   * admin may want to revoke an already-expired row to clean it up
   * before the periodic purge runs.
   */
  findById(id: string): InternalTokenRow | null {
    const raw = this.findByIdStmt.get(id) as RawTokenRow | undefined;
    if (!raw) return null;
    return { ...rowToInfo(raw), hash: raw.hash };
  }

  /**
   * List every active (non-expired) token for `memberName`, oldest
   * first. Used by the admin/self listing endpoint.
   */
  listForMember(memberName: string): TokenInfo[] {
    const rows = this.listForMemberStmt.all(memberName) as unknown as RawTokenRow[];
    const t = this.now();
    return rows.map(rowToInfo).filter((r) => r.expiresAt === null || r.expiresAt >= t);
  }

  /**
   * Bump `last_used_at` for `id`. Coalesces to one DB write per
   * `LAST_USED_DEBOUNCE_MS` window; further calls within the window
   * are no-ops. Intended to be called after every successful auth.
   */
  touch(id: string): void {
    const t = this.now();
    const last = this.lastTouched.get(id);
    if (last !== undefined && t - last < LAST_USED_DEBOUNCE_MS) return;
    this.lastTouched.set(id, t);
    this.touchStmt.run(t, id);
  }

  /** Force a `last_used_at` write — bypasses the debounce. Used by tests. */
  touchNow(id: string): void {
    const t = this.now();
    this.lastTouched.set(id, t);
    this.touchStmt.run(t, id);
  }

  /**
   * Delete a specific token row. Returns true if a row was deleted.
   * Caller is expected to wrap this in its own permission check
   * (members.manage or self).
   */
  revoke(id: string): boolean {
    this.lastTouched.delete(id);
    const result = this.deleteStmt.run(id);
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Delete every token belonging to a member. Used during member
   * deletion so an in-flight token can't outlive its identity.
   * Returns the number of rows removed.
   */
  revokeAllForMember(memberName: string): number {
    const result = this.deleteForMemberStmt.run(memberName);
    // Forget any debounce state for purged ids; we don't know their
    // ids without a pre-fetch, but lastTouched is bounded and the
    // entries become inert as soon as the rows are gone.
    return Number(result.changes ?? 0);
  }

  /**
   * Best-effort cleanup of expired rows. Safe to call periodically
   * and on shutdown.
   */
  purgeExpired(): number {
    const result = this.purgeStmt.run(this.now());
    return Number(result.changes ?? 0);
  }
}

/**
 * Open a TokenStore on `db` and seed it with the bootstrap hash of
 * every member that knows its own hash (currently: only the in-memory
 * `MapMemberStore` used by tests does — the DB-backed store returns
 * null and the loop becomes a no-op). Idempotent across re-calls.
 *
 * Production callers don't need this — member create / device-code
 * approve / rotate-token issue tokens via `insert` directly.
 */
export function createTokenStoreFromMembers(
  db: DatabaseSyncInstance,
  members: import('./members.js').MemberStore,
  options: { now?: () => number } = {},
): TokenStore {
  const store = new TokenStore(db, options);
  for (const m of members.members()) {
    const hash = members.tokenHashOf?.(m.name);
    if (!hash) continue;
    store.insertHashed({
      memberName: m.name,
      hash,
      label: 'legacy',
      origin: 'bootstrap',
      createdBy: null,
    });
  }
  return store;
}
