/**
 * Token store — multi-token-per-member bearer auth.
 *
 * Each row is one issued token; a member may have many at once
 * ("laptop", "ci-runner", "prod-vm-east"). Tokens are stored as
 * sha256 hashes — plaintext is shown to the issuer exactly once and
 * never persisted. Rows can carry an optional `expiresAt`; a token
 * past its expiry resolves the same as a deleted row (auth 401, no
 * special UX).
 *
 * Why this lives in the database instead of the team config file:
 *   - per-request `lastUsedAt` updates would otherwise rewrite the
 *     team config on every authenticated call
 *   - multi-token semantics need cheap inserts/deletes per token,
 *     not per-member JSON rewrites
 *   - audit-log queries can join on the same DB
 *
 * The config file keeps the bootstrap path: a member's `tokenHash`
 * (or plaintext `token`, hand-edited) is read on first boot and
 * migrated into this store with `origin = 'bootstrap'`. After
 * migration the resolver looks here only.
 *
 * Core depends only on this interface; the concrete implementation is
 * injected by the host runtime — `SqliteTokenStore` over a
 * `SqlDriver`. IO is async in the interface so async-only runtimes
 * aren't forced to lie.
 */

import type { TokenInfo, TokenOrigin } from 'csuite-sdk/types';
import { sha256Hex } from './hashing.js';
import { randomBase64Url } from './random-id.js';

export const TOKEN_HASH_PREFIX = 'sha256:';

/**
 * Hash a raw bearer token into the on-disk representation. Same
 * algorithm as the legacy config-file `tokenHash` field so values
 * round-trip cleanly across the migration.
 */
export async function hashRawToken(rawToken: string): Promise<string> {
  return TOKEN_HASH_PREFIX + (await sha256Hex(rawToken));
}

/**
 * Generate a fresh cryptorandom bearer token in the standard
 * `csuite_<base64url>` format. 32 raw bytes → 43-char payload (~256 bits).
 */
export function generateBearerToken(): string {
  return `csuite_${randomBase64Url(32)}`;
}

/**
 * `TokenInfo` plus the on-disk `hash` — internal-only. The wire shape
 * never carries the hash (it's a credential surface), but the auth
 * resolver needs it to confirm the row matches the presented token.
 */
export interface InternalTokenRow extends TokenInfo {
  hash: string;
}

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
 * Migration-only insertion path: insert a row from a pre-computed
 * `sha256:<hex>` hash when the plaintext is unknown. Idempotent — if
 * the hash is already present the existing row is returned.
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

export interface TokenStore {
  /**
   * Insert a fresh token row. Returns the public projection plus the
   * on-disk hash so the caller can pair it with the plaintext for
   * one-time display. Throws on UNIQUE-violation if an identical hash
   * already exists (~ infinitesimal probability — surface as a 500-
   * level retryable error at the caller).
   */
  insert(input: InsertTokenInput): Promise<InternalTokenRow>;

  /** See `InsertHashedTokenInput`. Idempotent on `hash`. */
  insertHashed(input: InsertHashedTokenInput): Promise<InternalTokenRow>;

  /**
   * Resolve a presented bearer plaintext to an active token row.
   * Returns null when no row matches the hash, or the matching row
   * has an `expiresAt` in the past.
   */
  resolve(rawToken: string): Promise<InternalTokenRow | null>;

  /**
   * Find a token row by id (for revoke). Does not check expiry — an
   * admin may want to revoke an already-expired row to clean it up
   * before the periodic purge runs.
   */
  findById(id: string): Promise<InternalTokenRow | null>;

  /**
   * List every active (non-expired) token for `memberName`, oldest
   * first. Used by the admin/self listing endpoint.
   */
  listForMember(memberName: string): Promise<TokenInfo[]>;

  /**
   * Bump `lastUsedAt` for `id`. Implementations may coalesce writes;
   * intended to be called after every successful auth.
   */
  touch(id: string): Promise<void>;

  /** Force a `lastUsedAt` write — bypasses any coalescing. Used by tests. */
  touchNow(id: string): Promise<void>;

  /**
   * Delete a specific token row. Returns true if a row was deleted.
   * Caller is expected to wrap this in its own permission check
   * (members.manage or self).
   */
  revoke(id: string): Promise<boolean>;

  /**
   * Delete every token belonging to a member. Used during member
   * deletion so an in-flight token can't outlive its identity.
   * Returns the number of rows removed.
   */
  revokeAllForMember(memberName: string): Promise<number>;

  /**
   * Best-effort cleanup of expired rows. Safe to call periodically
   * and on shutdown. Returns the count removed.
   */
  purgeExpired(): Promise<number>;
}
