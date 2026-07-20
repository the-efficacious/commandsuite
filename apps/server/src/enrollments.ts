/**
 * SQLite-backed pending-enrollment store for the device-code flow.
 *
 * RFC 8628 device authorization grant, adapted for csuite's identity
 * model (broker-as-IdP, members instead of OAuth scopes):
 *
 *   1. Operator runs `csuite connect` on the device; CLI POSTs /enroll.
 *      Server mints (deviceCode, userCode), inserts a pending row,
 *      returns both plus expires_in / interval.
 *   2. CLI displays the userCode + verification URI; polls
 *      /enroll/poll with deviceCode every `interval` seconds.
 *   3. Director, already logged in via TOTP/session, visits the
 *      verification URI, types the userCode, picks bind-or-create
 *      and any role/permission/label fields. Server marks the row
 *      `approved`, mints a token row, KEK-wraps the plaintext into
 *      `issued_token_ct`.
 *   4. CLI's next poll resolves: server decrypts the plaintext,
 *      deletes the row (single-use), returns the token to the device.
 *
 * What's stored:
 *   - sha256(deviceCode) — never the plaintext, so a DB-read leak
 *     can't replay enrollments
 *   - userCode in canonical 8-char Crockford-base32 uppercase form
 *   - source_ip / source_ua at /enroll time (display-only, helps
 *     a director spot an unexpected request)
 *   - label_hint, then the actual label after approval
 *   - approve mode + creation args (JSON) so a `mode='create'`
 *     approval can re-derive the new member at poll-time without
 *     re-asking the director
 *   - issued_token_id (stable handle for revoke later) and
 *     issued_token_ct (KEK-wrapped plaintext for one-shot delivery)
 *
 * Single-connection-per-process: the store does NOT own its
 * DatabaseSync handle; runServer passes the shared handle in.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';
import { decryptField, ENCRYPTED_FIELD_PREFIX, encryptField } from './kek.js';

/**
 * The KEK is just a 32-byte Buffer; aliasing it here keeps the
 * intent explicit at the call site without forcing every consumer
 * to import from `./kek.js`.
 */
export type Kek = Buffer;

/**
 * Enrollment-flow TTL. RFC 8628 §3.2 says expires_in is "RECOMMENDED"
 * — picked 5 min to match the GitHub `gh auth login` window, which
 * operators are already used to. The window covers the full flow:
 * mint → director approve → device poll once after approval. 5 min
 * is plenty for a director who's already in the broker UI.
 */
export const ENROLLMENT_TTL_MS = 5 * 60 * 1000;

/**
 * Default poll interval the server reports back. RFC 8628 §3.5
 * says default 5; clients respect this and add 5 on slow_down.
 */
export const DEFAULT_POLL_INTERVAL_S = 5;

/**
 * Minimum spacing between successful polls before we consider it
 * "fast" enough to warrant a slow_down. The check fires only on
 * pending status — once approved/rejected, we want the CLI to
 * resolve as fast as possible.
 */
const SLOW_DOWN_THRESHOLD_MS = 2_500;

/**
 * Crockford base32 alphabet (RFC 4648 base32 minus I, L, O, U). Picked
 * for human transcription — no character pairs that look alike at
 * a glance (0/O, 1/I/L). Also unusual case-insensitive: every
 * symbol is unambiguous in either case.
 */
const USER_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const USER_CODE_LEN = 8;

/**
 * Device code: high-entropy opaque secret. 32 raw bytes →
 * `csuite-dc_<base64url>` rendered. Treated as a shared bearer secret
 * on the wire; the store keeps only its sha256 hash.
 */
const DEVICE_CODE_BYTES = 32;
const DEVICE_CODE_PREFIX = 'csuite-dc_';

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pending_enrollments (
    device_code_hash    TEXT PRIMARY KEY,
    user_code           TEXT NOT NULL UNIQUE,
    created_at          INTEGER NOT NULL,
    expires_at          INTEGER NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending',
    source_ip           TEXT,
    source_ua           TEXT,
    label_hint          TEXT NOT NULL DEFAULT '',
    approved_by         TEXT,
    bound_member        TEXT,
    approve_args_json   TEXT,
    issued_token_id     TEXT,
    issued_token_ct     TEXT,
    reject_reason       TEXT,
    last_polled_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS pending_enrollments_user_code_idx ON pending_enrollments(user_code);
  CREATE INDEX IF NOT EXISTS pending_enrollments_expires_idx   ON pending_enrollments(expires_at);
`;

export type EnrollmentStatus = 'pending' | 'approved' | 'rejected';

/**
 * Internal row shape — exposed via the per-method accessors below
 * but never sent on the wire as-is (the wire shapes live in
 * `csuite-sdk/types`).
 */
export interface EnrollmentRow {
  deviceCodeHash: string;
  userCode: string;
  createdAt: number;
  expiresAt: number;
  status: EnrollmentStatus;
  sourceIp: string | null;
  sourceUa: string | null;
  labelHint: string;
  approvedBy: string | null;
  boundMember: string | null;
  approveArgsJson: string | null;
  issuedTokenId: string | null;
  issuedTokenCiphertext: string | null;
  rejectReason: string | null;
  lastPolledAt: number | null;
}

interface RawRow {
  device_code_hash: string;
  user_code: string;
  created_at: number;
  expires_at: number;
  status: string;
  source_ip: string | null;
  source_ua: string | null;
  label_hint: string;
  approved_by: string | null;
  bound_member: string | null;
  approve_args_json: string | null;
  issued_token_id: string | null;
  issued_token_ct: string | null;
  reject_reason: string | null;
  last_polled_at: number | null;
}

function rawToRow(raw: RawRow): EnrollmentRow {
  const status: EnrollmentStatus =
    raw.status === 'approved' || raw.status === 'rejected' ? raw.status : 'pending';
  return {
    deviceCodeHash: raw.device_code_hash,
    userCode: raw.user_code,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    status,
    sourceIp: raw.source_ip,
    sourceUa: raw.source_ua,
    labelHint: raw.label_hint,
    approvedBy: raw.approved_by,
    boundMember: raw.bound_member,
    approveArgsJson: raw.approve_args_json,
    issuedTokenId: raw.issued_token_id,
    issuedTokenCiphertext: raw.issued_token_ct,
    rejectReason: raw.reject_reason,
    lastPolledAt: raw.last_polled_at,
  };
}

export interface MintInput {
  sourceIp: string | null;
  sourceUa: string | null;
  labelHint?: string;
}

export interface MintResult {
  /** Plaintext to return to the CLI; treated as a shared secret. */
  deviceCode: string;
  /** 8-char Crockford base32, formatted for display as `XXXX-XXXX`. */
  userCode: string;
  /** Display form. Same chars as `userCode` but with a hyphen at the midpoint. */
  userCodeFormatted: string;
  /** Internal: the hash actually stored in the DB. */
  deviceCodeHash: string;
  expiresAt: number;
  /** RFC 8628 `expires_in` in seconds. */
  expiresIn: number;
  /** RFC 8628 `interval` in seconds. */
  interval: number;
}

export interface ApproveInput {
  userCode: string;
  approvedBy: string;
  boundMember: string;
  /** Stored verbatim so the poll-time handler can apply mode='create' if needed. */
  approveArgsJson: string;
  /** UUID of the token row issued to back this approval. */
  issuedTokenId: string;
  /** Plaintext bearer token to deliver on next poll. KEK-wrapped at rest. */
  issuedTokenPlaintext: string;
}

export interface RejectInput {
  userCode: string;
  rejectedBy: string;
  reason?: string;
}

/**
 * RFC 8628-shaped poll outcomes. `approved` carries the plaintext
 * once; the row is consumed in the same transaction so a replay
 * always returns `expired_token`.
 */
export type PollOutcome =
  | { kind: 'authorization_pending' }
  | { kind: 'slow_down' }
  | { kind: 'expired_token' }
  | { kind: 'access_denied'; reason: string | null }
  | {
      kind: 'approved';
      tokenPlaintext: string;
      tokenId: string;
      memberName: string;
    };

/**
 * Pre-flight check on a user code before approval — used by the
 * approval handler to validate the row is still actionable. Lets
 * us return crisp errors ("already approved", "expired", "not
 * found") rather than a generic 400.
 */
export type LookupOutcome =
  | { kind: 'pending'; row: EnrollmentRow }
  | { kind: 'expired' }
  | { kind: 'already_approved' }
  | { kind: 'already_rejected'; reason: string | null }
  | { kind: 'not_found' };

/**
 * Normalize a user-code input to the canonical 8-char Crockford
 * uppercase form used for storage and lookup. Accepts any case,
 * any spacing/hyphenation. Returns null on invalid alphabet or
 * length, in which case the caller emits a 400 (not a "not found"
 * — that would leak whether a similar code exists).
 */
export function normalizeUserCode(input: string): string | null {
  const upper = input.replace(/[\s-]/g, '').toUpperCase();
  if (upper.length !== USER_CODE_LEN) return null;
  for (const ch of upper) {
    if (!USER_CODE_ALPHABET.includes(ch)) return null;
  }
  return upper;
}

/** Format an internal user code (`XXXXYYYY`) as the displayed `XXXX-YYYY`. */
export function formatUserCode(internal: string): string {
  if (internal.length !== USER_CODE_LEN) return internal;
  return `${internal.slice(0, 4)}-${internal.slice(4)}`;
}

function generateUserCode(): string {
  // Reject-sample uniformly out of the 32-symbol alphabet so the
  // distribution is exact (not biased by `% 32` on a 256-byte
  // sample).
  const out = new Array<string>(USER_CODE_LEN);
  let written = 0;
  while (written < USER_CODE_LEN) {
    const bytes = randomBytes(16);
    for (let i = 0; i < bytes.length && written < USER_CODE_LEN; i++) {
      const byte = bytes[i] as number;
      const idx = byte & 0b11111;
      // 0b11111 = 31, perfectly aligned with our 32-char alphabet,
      // so every byte produces a uniform symbol with no rejection.
      out[written++] = USER_CODE_ALPHABET.charAt(idx);
    }
  }
  return out.join('');
}

function generateDeviceCode(): string {
  return `${DEVICE_CODE_PREFIX}${randomBytes(DEVICE_CODE_BYTES).toString('base64url')}`;
}

function hashDeviceCode(deviceCode: string): string {
  return createHash('sha256').update(deviceCode, 'utf8').digest('hex');
}

export interface EnrollmentStoreOptions {
  /** Test clock injection. */
  now?: () => number;
  /**
   * Active KEK for wrapping the issued plaintext. Pass `null` (or
   * omit) only when the host has no KEK configured — the plaintext
   * is then stored as-is. The migration path should ensure a KEK
   * exists before this store handles real traffic.
   */
  kek?: Kek | null;
}

export class EnrollmentStore {
  private readonly db: DatabaseSyncInstance;
  private readonly insertStmt: StatementInstance;
  private readonly findByCodeStmt: StatementInstance;
  private readonly findByDeviceHashStmt: StatementInstance;
  private readonly approveStmt: StatementInstance;
  private readonly rejectStmt: StatementInstance;
  private readonly deleteByDeviceHashStmt: StatementInstance;
  private readonly listPendingStmt: StatementInstance;
  private readonly touchPollStmt: StatementInstance;
  private readonly purgeStmt: StatementInstance;
  private readonly now: () => number;
  private readonly kek: Kek | null;

  constructor(db: DatabaseSyncInstance, options: EnrollmentStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.kek = options.kek ?? null;
    this.db.exec(CREATE_SCHEMA);
    this.insertStmt = this.db.prepare(
      `INSERT INTO pending_enrollments
         (device_code_hash, user_code, created_at, expires_at, status, source_ip, source_ua, label_hint)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    );
    this.findByCodeStmt = this.db.prepare(`SELECT * FROM pending_enrollments WHERE user_code = ?`);
    this.findByDeviceHashStmt = this.db.prepare(
      `SELECT * FROM pending_enrollments WHERE device_code_hash = ?`,
    );
    this.approveStmt = this.db.prepare(
      `UPDATE pending_enrollments
         SET status = 'approved',
             approved_by = ?,
             bound_member = ?,
             approve_args_json = ?,
             issued_token_id = ?,
             issued_token_ct = ?
         WHERE user_code = ? AND status = 'pending'`,
    );
    this.rejectStmt = this.db.prepare(
      `UPDATE pending_enrollments
         SET status = 'rejected',
             approved_by = ?,
             reject_reason = ?
         WHERE user_code = ? AND status = 'pending'`,
    );
    this.deleteByDeviceHashStmt = this.db.prepare(
      `DELETE FROM pending_enrollments WHERE device_code_hash = ?`,
    );
    this.listPendingStmt = this.db.prepare(
      `SELECT * FROM pending_enrollments
         WHERE status = 'pending' AND expires_at >= ?
         ORDER BY created_at ASC`,
    );
    this.touchPollStmt = this.db.prepare(
      `UPDATE pending_enrollments SET last_polled_at = ? WHERE device_code_hash = ?`,
    );
    this.purgeStmt = this.db.prepare(`DELETE FROM pending_enrollments WHERE expires_at < ?`);
  }

  /**
   * Mint a fresh enrollment row. Generates `(deviceCode, userCode)`,
   * inserts the row keyed by `sha256(deviceCode)`, returns the
   * plaintext device code (for the CLI to keep) plus both forms of
   * the user code.
   *
   * Retries a small number of times on user-code collision (32^8
   * space + 5min TTL → collisions are infinitesimally rare in
   * practice, but the retry path keeps boot-time test failures from
   * flaking on absurdly unlucky seed values).
   */
  mint(input: MintInput): MintResult {
    const createdAt = this.now();
    const expiresAt = createdAt + ENROLLMENT_TTL_MS;
    const labelHint = (input.labelHint ?? '').slice(0, 64);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const deviceCode = generateDeviceCode();
      const userCode = generateUserCode();
      const deviceCodeHash = hashDeviceCode(deviceCode);
      try {
        this.insertStmt.run(
          deviceCodeHash,
          userCode,
          createdAt,
          expiresAt,
          input.sourceIp,
          input.sourceUa,
          labelHint,
        );
        return {
          deviceCode,
          userCode,
          userCodeFormatted: formatUserCode(userCode),
          deviceCodeHash,
          expiresAt,
          expiresIn: Math.floor(ENROLLMENT_TTL_MS / 1000),
          interval: DEFAULT_POLL_INTERVAL_S,
        };
      } catch (err) {
        lastErr = err;
        // UNIQUE collision on user_code OR device_code_hash → retry
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('UNIQUE') && !msg.includes('constraint')) {
          throw err;
        }
      }
    }
    throw lastErr ?? new Error('mint: exhausted retries on UNIQUE collision');
  }

  /**
   * Look up by user code (normalized form, no hyphen). Returns a
   * `LookupOutcome` discriminated on whether the row is actionable.
   */
  lookupByUserCode(userCode: string): LookupOutcome {
    const raw = this.findByCodeStmt.get(userCode) as RawRow | undefined;
    if (!raw) return { kind: 'not_found' };
    const row = rawToRow(raw);
    const t = this.now();
    if (row.expiresAt < t) {
      return { kind: 'expired' };
    }
    if (row.status === 'approved') return { kind: 'already_approved' };
    if (row.status === 'rejected') {
      return { kind: 'already_rejected', reason: row.rejectReason };
    }
    return { kind: 'pending', row };
  }

  /**
   * Mark a pending row approved and stash the issued token for the
   * device-side poll to consume. Plaintext is KEK-wrapped at rest;
   * if no KEK is configured the plaintext lives briefly in cleartext
   * (logged as a warning at construction time on a real deployment).
   *
   * Returns true on success; false if the row is missing, expired,
   * or already non-pending (caller should re-lookup and surface a
   * clearer error).
   */
  approve(input: ApproveInput): boolean {
    const ct = this.kek
      ? (encryptField(input.issuedTokenPlaintext, this.kek) ?? input.issuedTokenPlaintext)
      : input.issuedTokenPlaintext;
    const result = this.approveStmt.run(
      input.approvedBy,
      input.boundMember,
      input.approveArgsJson,
      input.issuedTokenId,
      ct,
      input.userCode,
    );
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Mark a pending row rejected. Returns true on success; same
   * semantics as `approve` for race-with-other-mutator outcomes.
   */
  reject(input: RejectInput): boolean {
    const result = this.rejectStmt.run(input.rejectedBy, input.reason ?? null, input.userCode);
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Single-call atomic poll resolver: looks up the row by device-
   * code hash, applies the four RFC 8628 outcomes, and consumes
   * (deletes) the row on `approved` so a replay returns
   * `expired_token`.
   *
   * `slow_down` is signaled when two consecutive polls land within
   * `SLOW_DOWN_THRESHOLD_MS` while the row is still pending — the
   * CLI is supposed to back off by `interval += 5` seconds on this
   * response.
   */
  pollByDeviceCode(deviceCode: string): PollOutcome {
    const hash = hashDeviceCode(deviceCode);
    const raw = this.findByDeviceHashStmt.get(hash) as RawRow | undefined;
    if (!raw) return { kind: 'expired_token' };
    const row = rawToRow(raw);
    const t = this.now();
    if (row.expiresAt < t) {
      this.deleteByDeviceHashStmt.run(hash);
      return { kind: 'expired_token' };
    }
    if (row.status === 'rejected') {
      this.deleteByDeviceHashStmt.run(hash);
      return { kind: 'access_denied', reason: row.rejectReason };
    }
    if (row.status === 'approved') {
      const id = row.issuedTokenId;
      const ct = row.issuedTokenCiphertext;
      const member = row.boundMember;
      if (id === null || ct === null || member === null) {
        // Should never happen — approved rows always carry these
        // three. Treat as expired to avoid leaking partial state.
        this.deleteByDeviceHashStmt.run(hash);
        return { kind: 'expired_token' };
      }
      const plaintext =
        this.kek && ct.startsWith(ENCRYPTED_FIELD_PREFIX) ? decryptField(ct, this.kek) : ct;
      if (plaintext === null) {
        this.deleteByDeviceHashStmt.run(hash);
        return { kind: 'expired_token' };
      }
      // Consume — single-use semantics per RFC 8628 §3.4 / 3.5.
      this.deleteByDeviceHashStmt.run(hash);
      return {
        kind: 'approved',
        tokenPlaintext: plaintext,
        tokenId: id,
        memberName: member,
      };
    }
    // Still pending — slow-down detection + last-polled bookkeeping.
    let outcome: PollOutcome = { kind: 'authorization_pending' };
    if (row.lastPolledAt !== null && t - row.lastPolledAt < SLOW_DOWN_THRESHOLD_MS) {
      outcome = { kind: 'slow_down' };
    }
    this.touchPollStmt.run(t, hash);
    return outcome;
  }

  /**
   * List all currently-pending (and not-yet-expired) enrollment
   * rows, oldest first. Used by the director's pending-approvals
   * panel.
   */
  listPending(): EnrollmentRow[] {
    const rows = this.listPendingStmt.all(this.now()) as unknown as RawRow[];
    return rows.map(rawToRow);
  }

  /**
   * Best-effort cleanup of expired rows. Called periodically by a
   * reaper running on the same loop as `sessions.purgeExpired()`.
   */
  purgeExpired(): number {
    const result = this.purgeStmt.run(this.now());
    return Number(result.changes ?? 0);
  }
}
