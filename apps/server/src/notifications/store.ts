/**
 * External Notifications store — SQLite-backed registry of inbound
 * notification ENDPOINTS (slug-addressed hook receivers), shared
 * auth PROFILES, per-request DELIVERY receipts, and the PENDING
 * queue that backs the `if_offline: queue` / `if_busy: wait`
 * delivery policies.
 *
 * Shares the main `DatabaseSync` handle with channels/objectives —
 * endpoints and profiles are config-class; deliveries are bounded by
 * the per-endpoint ingress rate limit.
 *
 * Signing secrets (endpoint-inline or profile-shared) are
 * KEK-encrypted at rest (`enc-v1:` envelope) and WRITE-ONLY over the
 * wire. Unlike env secrets they ARE read server-side — signature
 * verification needs the plaintext at request time — but only via
 * `resolveVerification`, which the ingress path alone calls. Secret
 * writes FAIL CLOSED when no KEK is active (`no_kek`), the same
 * doctrine as tool-source credentials.
 *
 * Slugs are IMMUTABLE — the ingress URL (`/hooks/<slug>`) and the
 * `hook:<slug>` sender identity ride on them; `displayName` is the
 * mutable label. FK cascades are NOT enforced by this codebase, so
 * `delete()` cascades deliveries + pending rows explicitly inside
 * one transaction. Deleting a profile still referenced by an
 * endpoint is refused (`profile_in_use`) — an endpoint silently
 * losing its verifier is an outage.
 */

import type {
  LogLevel,
  NotificationAuthConfig,
  NotificationAuthKind,
  NotificationDelivery,
  NotificationDeliveryPolicy,
  NotificationDeliveryStatus,
  NotificationEndpoint,
  NotificationFilterRule,
  NotificationOverrides,
  NotificationProfile,
  NotificationTarget,
} from 'csuite-sdk/types';
import type { DatabaseSyncInstance, StatementInstance } from '../db.js';
import { decryptField, encryptField } from '../kek.js';
import { getKek } from '../members.js';
import { validateSourceSlug } from '../tool-sources/index.js';

export class NotificationsError extends Error {
  readonly code:
    | 'not_found'
    | 'invalid_input'
    | 'slug_taken'
    | 'unknown_profile'
    | 'profile_in_use'
    | 'no_kek';
  constructor(code: NotificationsError['code'], message: string) {
    super(message);
    this.name = 'NotificationsError';
    this.code = code;
  }
}

/** Raw-body cap on ingress; the stored body is capped to the same. */
export const HOOK_BODY_MAX = 256 * 1024;
/** Secret length cap (matches the SDK schema). */
const SECRET_MAX = 4096;
/** Wire `bodyPreview` length. */
const BODY_PREVIEW_MAX = 2048;

export const DEFAULT_POLICY: NotificationDeliveryPolicy = {
  ifOffline: 'drop',
  ifBusy: 'now',
  debounceMs: 0,
  debounceMax: 20,
  queueTtlMs: 24 * 60 * 60 * 1000,
  maxWaitMs: 15 * 60 * 1000,
};

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notification_profiles (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    auth_kind TEXT NOT NULL,
    auth_header TEXT,
    auth_prefix TEXT,
    secret_enc TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS notification_profiles_slug_idx
    ON notification_profiles (slug);

  CREATE TABLE IF NOT EXISTS notification_endpoints (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    auth_kind TEXT NOT NULL DEFAULT 'header-secret',
    auth_header TEXT,
    auth_prefix TEXT,
    secret_enc TEXT,
    profile_id TEXT,
    targets TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    title TEXT,
    template TEXT,
    filters TEXT NOT NULL DEFAULT '[]',
    policy TEXT NOT NULL,
    dedupe_header TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS notification_endpoints_slug_idx
    ON notification_endpoints (slug);

  CREATE TABLE IF NOT EXISTS notification_deliveries (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    endpoint_slug TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    status_reason TEXT,
    dedupe_key TEXT,
    message_ids TEXT NOT NULL DEFAULT '[]',
    body TEXT NOT NULL,
    content_type TEXT,
    rendered TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT 'info',
    title TEXT,
    overrides TEXT,
    delivered_at INTEGER,
    replay_of TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_dedupe_idx
    ON notification_deliveries (endpoint_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS notification_deliveries_endpoint_idx
    ON notification_deliveries (endpoint_id, received_at DESC);
  CREATE INDEX IF NOT EXISTS notification_deliveries_status_idx
    ON notification_deliveries (status);

  CREATE TABLE IF NOT EXISTS notification_pending (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    member_name TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('offline','busy')),
    delivery_ids TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    title TEXT,
    created_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notification_pending_member_idx
    ON notification_pending (member_name);
  CREATE INDEX IF NOT EXISTS notification_pending_deadline_idx
    ON notification_pending (deadline_at);
`;

interface ProfileRow {
  id: string;
  slug: string;
  description: string;
  auth_kind: string;
  auth_header: string | null;
  auth_prefix: string | null;
  secret_enc: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface EndpointRow {
  id: string;
  slug: string;
  display_name: string;
  description: string;
  enabled: number;
  auth_kind: string;
  auth_header: string | null;
  auth_prefix: string | null;
  secret_enc: string | null;
  profile_id: string | null;
  targets: string;
  level: string;
  title: string | null;
  template: string | null;
  filters: string;
  policy: string;
  dedupe_header: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface DeliveryDbRow {
  id: string;
  endpoint_id: string;
  endpoint_slug: string;
  received_at: number;
  status: string;
  status_reason: string | null;
  dedupe_key: string | null;
  message_ids: string;
  body: string;
  content_type: string | null;
  rendered: string;
  level: string;
  title: string | null;
  overrides: string | null;
  delivered_at: number | null;
  replay_of: string | null;
}

interface PendingDbRow {
  id: string;
  endpoint_id: string;
  member_name: string;
  reason: string;
  delivery_ids: string;
  level: string;
  title: string | null;
  created_at: number;
  deadline_at: number;
}

/** Internal delivery shape — the wire projection plus dispatch state. */
export interface DeliveryRecord {
  id: string;
  endpointId: string;
  endpointSlug: string;
  receivedAt: number;
  status: NotificationDeliveryStatus;
  statusReason: string | null;
  dedupeKey: string | null;
  messageIds: string[];
  /** Raw request body (capped at HOOK_BODY_MAX). Retained for replay. */
  body: string;
  contentType: string | null;
  /** Rendered inner content (post-template), composed into messages at flush. */
  rendered: string;
  /** Effective level after overrides. */
  level: LogLevel;
  title: string | null;
  overrides: NotificationOverrides | null;
  deliveredAt: number | null;
  replayOf: string | null;
}

export interface PendingRecord {
  id: string;
  endpointId: string;
  memberName: string;
  reason: 'offline' | 'busy';
  deliveryIds: string[];
  level: LogLevel;
  title: string | null;
  createdAt: number;
  deadlineAt: number;
}

/** Plaintext verification material for the ingress path only. */
export interface ResolvedVerification {
  kind: NotificationAuthKind;
  headerName: string | null;
  prefix: string | null;
  /** Decrypted secret. Null when none is configured (fail closed upstream). */
  secret: string | null;
}

export interface CreateEndpointInput {
  slug: string;
  displayName?: string;
  description?: string;
  enabled?: boolean;
  auth?: { kind: NotificationAuthKind; headerName?: string | null; prefix?: string | null };
  /** Profile SLUG; resolved to an id at write time. */
  authProfile?: string | null;
  /** Targets with channels already resolved to channel IDs by the caller. */
  targets: NotificationTarget[];
  level?: LogLevel;
  title?: string | null;
  template?: string | null;
  filters?: NotificationFilterRule[];
  policy?: Partial<NotificationDeliveryPolicy>;
  dedupeHeader?: string | null;
  creator: string;
  now?: number;
}

export type UpdateEndpointInput = Omit<Partial<CreateEndpointInput>, 'slug' | 'creator' | 'now'>;

export interface InsertDeliveryInput {
  endpointId: string;
  endpointSlug: string;
  receivedAt: number;
  status: NotificationDeliveryStatus;
  statusReason?: string | null;
  dedupeKey?: string | null;
  body: string;
  contentType?: string | null;
  rendered?: string;
  level: LogLevel;
  title?: string | null;
  overrides?: NotificationOverrides | null;
  replayOf?: string | null;
}

export interface NotificationsStore {
  // ── Profiles ──
  listProfiles(): NotificationProfile[];
  getProfile(id: string): NotificationProfile | null;
  getProfileBySlug(slug: string): NotificationProfile | null;
  createProfile(input: {
    slug: string;
    description?: string;
    auth: { kind: NotificationAuthKind; headerName?: string | null; prefix?: string | null };
    creator: string;
    now?: number;
  }): NotificationProfile;
  updateProfile(
    id: string,
    patch: {
      description?: string;
      auth?: { kind: NotificationAuthKind; headerName?: string | null; prefix?: string | null };
    },
    now?: number,
  ): NotificationProfile;
  /** Refuses (`profile_in_use`) while any endpoint references the profile. */
  deleteProfile(id: string): void;
  setProfileSecret(id: string, secret: string, now?: number): void;
  deleteProfileSecret(id: string): void;
  hasProfileSecret(id: string): boolean;
  endpointCountForProfile(id: string): number;

  // ── Endpoints ──
  list(): NotificationEndpoint[];
  get(id: string): NotificationEndpoint | null;
  getBySlug(slug: string): NotificationEndpoint | null;
  create(input: CreateEndpointInput): NotificationEndpoint;
  update(id: string, patch: UpdateEndpointInput, now?: number): NotificationEndpoint;
  /** Cascades delivery receipts + pending rows in one transaction. */
  delete(id: string): void;
  setSecret(id: string, secret: string, now?: number): void;
  deleteSecret(id: string): void;
  hasSecret(id: string): boolean;
  /**
   * Verification material for the ingress path: the endpoint's
   * profile config when bound, else its inline config, with the
   * secret decrypted. Throws `no_kek` when a secret exists but no
   * KEK is active (fail closed — never verify against garbage).
   */
  resolveVerification(endpointId: string): ResolvedVerification;

  // ── Deliveries ──
  insertDelivery(input: InsertDeliveryInput): DeliveryRecord;
  getDeliveryRecord(id: string): DeliveryRecord | null;
  findDeliveryByDedupe(endpointId: string, dedupeKey: string): DeliveryRecord | null;
  updateDelivery(
    id: string,
    patch: {
      status?: NotificationDeliveryStatus;
      statusReason?: string | null;
      addMessageIds?: string[];
      rendered?: string;
      deliveredAt?: number;
    },
  ): void;
  deliveriesByIds(ids: string[]): DeliveryRecord[];
  /** Wire projection, newest first. */
  listDeliveries(
    endpointId: string,
    opts?: { limit?: number; before?: number },
  ): NotificationDelivery[];
  /** Boot recovery: deliveries stranded mid-debounce by a restart. */
  listStrandedDebounce(): DeliveryRecord[];

  // ── Pending queue ──
  insertPending(input: Omit<PendingRecord, 'id'>): PendingRecord;
  pendingForMember(memberName: string, reason?: 'offline' | 'busy'): PendingRecord[];
  pendingDue(now: number): PendingRecord[];
  deletePending(ids: string[]): void;
}

export function toWireDelivery(record: DeliveryRecord): NotificationDelivery {
  return {
    id: record.id,
    endpointSlug: record.endpointSlug,
    receivedAt: record.receivedAt,
    status: record.status,
    statusReason: record.statusReason,
    dedupeKey: record.dedupeKey,
    messageIds: record.messageIds,
    bodyPreview: record.body.slice(0, BODY_PREVIEW_MAX),
    contentType: record.contentType,
    overrides: record.overrides,
    deliveredAt: record.deliveredAt,
    replayOf: record.replayOf,
  };
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function resolvePolicy(partial?: Partial<NotificationDeliveryPolicy>): NotificationDeliveryPolicy {
  return { ...DEFAULT_POLICY, ...(partial ?? {}) };
}

function normalizeAuth(input?: {
  kind: NotificationAuthKind;
  headerName?: string | null;
  prefix?: string | null;
}): NotificationAuthConfig {
  if (!input) return { kind: 'header-secret', headerName: null, prefix: null };
  return {
    kind: input.kind,
    headerName: input.headerName ?? null,
    prefix: input.prefix ?? null,
  };
}

function encryptSecret(secret: string): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new NotificationsError('invalid_input', 'secret is required');
  }
  if (secret.length > SECRET_MAX) {
    throw new NotificationsError('invalid_input', `secret too long (max ${SECRET_MAX})`);
  }
  const kek = getKek();
  if (kek === null) {
    // Fail closed — never store a signing secret in plaintext.
    throw new NotificationsError('no_kek', 'no encryption key is active; cannot store a secret');
  }
  const encrypted = encryptField(secret, kek);
  if (encrypted === null) {
    throw new NotificationsError('invalid_input', 'secret is required');
  }
  return encrypted;
}

class SqliteNotificationsStore implements NotificationsStore {
  private readonly db: DatabaseSyncInstance;

  private readonly beginStmt: StatementInstance;
  private readonly commitStmt: StatementInstance;
  private readonly rollbackStmt: StatementInstance;

  private readonly insertProfileStmt: StatementInstance;
  private readonly updateProfileStmt: StatementInstance;
  private readonly deleteProfileStmt: StatementInstance;
  private readonly selectProfileByIdStmt: StatementInstance;
  private readonly selectProfileBySlugStmt: StatementInstance;
  private readonly selectProfilesStmt: StatementInstance;
  private readonly setProfileSecretStmt: StatementInstance;
  private readonly countEndpointsForProfileStmt: StatementInstance;

  private readonly insertEndpointStmt: StatementInstance;
  private readonly updateEndpointStmt: StatementInstance;
  private readonly deleteEndpointStmt: StatementInstance;
  private readonly selectEndpointByIdStmt: StatementInstance;
  private readonly selectEndpointBySlugStmt: StatementInstance;
  private readonly selectEndpointsStmt: StatementInstance;
  private readonly setEndpointSecretStmt: StatementInstance;

  private readonly insertDeliveryStmt: StatementInstance;
  private readonly selectDeliveryByIdStmt: StatementInstance;
  private readonly selectDeliveryByDedupeStmt: StatementInstance;
  private readonly updateDeliveryStmt: StatementInstance;
  private readonly selectDeliveriesStmt: StatementInstance;
  private readonly selectDeliveriesBeforeStmt: StatementInstance;
  private readonly selectStrandedDebounceStmt: StatementInstance;
  private readonly deleteDeliveriesForEndpointStmt: StatementInstance;

  private readonly insertPendingStmt: StatementInstance;
  private readonly selectPendingForMemberStmt: StatementInstance;
  private readonly selectPendingForMemberReasonStmt: StatementInstance;
  private readonly selectPendingDueStmt: StatementInstance;
  private readonly deletePendingStmt: StatementInstance;
  private readonly deletePendingForEndpointStmt: StatementInstance;

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    this.db.exec(CREATE_SCHEMA);

    this.beginStmt = db.prepare('BEGIN');
    this.commitStmt = db.prepare('COMMIT');
    this.rollbackStmt = db.prepare('ROLLBACK');

    const PROFILE_COLS =
      'id, slug, description, auth_kind, auth_header, auth_prefix, secret_enc, created_by, created_at, updated_at';
    this.insertProfileStmt = db.prepare(
      `INSERT INTO notification_profiles
        (id, slug, description, auth_kind, auth_header, auth_prefix, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateProfileStmt = db.prepare(
      `UPDATE notification_profiles
       SET description = ?, auth_kind = ?, auth_header = ?, auth_prefix = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.deleteProfileStmt = db.prepare('DELETE FROM notification_profiles WHERE id = ?');
    this.selectProfileByIdStmt = db.prepare(
      `SELECT ${PROFILE_COLS} FROM notification_profiles WHERE id = ?`,
    );
    this.selectProfileBySlugStmt = db.prepare(
      `SELECT ${PROFILE_COLS} FROM notification_profiles WHERE slug = ?`,
    );
    this.selectProfilesStmt = db.prepare(
      `SELECT ${PROFILE_COLS} FROM notification_profiles ORDER BY created_at ASC`,
    );
    this.setProfileSecretStmt = db.prepare(
      'UPDATE notification_profiles SET secret_enc = ?, updated_at = ? WHERE id = ?',
    );
    this.countEndpointsForProfileStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM notification_endpoints WHERE profile_id = ?',
    );

    const ENDPOINT_COLS =
      'id, slug, display_name, description, enabled, auth_kind, auth_header, auth_prefix, secret_enc, profile_id, targets, level, title, template, filters, policy, dedupe_header, created_by, created_at, updated_at';
    this.insertEndpointStmt = db.prepare(
      `INSERT INTO notification_endpoints
        (id, slug, display_name, description, enabled, auth_kind, auth_header, auth_prefix,
         profile_id, targets, level, title, template, filters, policy, dedupe_header,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateEndpointStmt = db.prepare(
      `UPDATE notification_endpoints
       SET display_name = ?, description = ?, enabled = ?, auth_kind = ?, auth_header = ?,
           auth_prefix = ?, profile_id = ?, targets = ?, level = ?, title = ?, template = ?,
           filters = ?, policy = ?, dedupe_header = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.deleteEndpointStmt = db.prepare('DELETE FROM notification_endpoints WHERE id = ?');
    this.selectEndpointByIdStmt = db.prepare(
      `SELECT ${ENDPOINT_COLS} FROM notification_endpoints WHERE id = ?`,
    );
    this.selectEndpointBySlugStmt = db.prepare(
      `SELECT ${ENDPOINT_COLS} FROM notification_endpoints WHERE slug = ?`,
    );
    this.selectEndpointsStmt = db.prepare(
      `SELECT ${ENDPOINT_COLS} FROM notification_endpoints ORDER BY created_at ASC`,
    );
    this.setEndpointSecretStmt = db.prepare(
      'UPDATE notification_endpoints SET secret_enc = ?, updated_at = ? WHERE id = ?',
    );

    const DELIVERY_COLS =
      'id, endpoint_id, endpoint_slug, received_at, status, status_reason, dedupe_key, message_ids, body, content_type, rendered, level, title, overrides, delivered_at, replay_of';
    this.insertDeliveryStmt = db.prepare(
      `INSERT INTO notification_deliveries
        (id, endpoint_id, endpoint_slug, received_at, status, status_reason, dedupe_key,
         message_ids, body, content_type, rendered, level, title, overrides, delivered_at, replay_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectDeliveryByIdStmt = db.prepare(
      `SELECT ${DELIVERY_COLS} FROM notification_deliveries WHERE id = ?`,
    );
    this.selectDeliveryByDedupeStmt = db.prepare(
      `SELECT ${DELIVERY_COLS} FROM notification_deliveries WHERE endpoint_id = ? AND dedupe_key = ?`,
    );
    this.updateDeliveryStmt = db.prepare(
      `UPDATE notification_deliveries
       SET status = ?, status_reason = ?, message_ids = ?, rendered = ?, delivered_at = ?
       WHERE id = ?`,
    );
    this.selectDeliveriesStmt = db.prepare(
      `SELECT ${DELIVERY_COLS} FROM notification_deliveries
       WHERE endpoint_id = ? ORDER BY received_at DESC LIMIT ?`,
    );
    this.selectDeliveriesBeforeStmt = db.prepare(
      `SELECT ${DELIVERY_COLS} FROM notification_deliveries
       WHERE endpoint_id = ? AND received_at < ? ORDER BY received_at DESC LIMIT ?`,
    );
    this.selectStrandedDebounceStmt = db.prepare(
      `SELECT ${DELIVERY_COLS} FROM notification_deliveries
       WHERE status = 'pending' AND status_reason = 'debouncing'
       ORDER BY received_at ASC`,
    );
    this.deleteDeliveriesForEndpointStmt = db.prepare(
      'DELETE FROM notification_deliveries WHERE endpoint_id = ?',
    );

    const PENDING_COLS =
      'id, endpoint_id, member_name, reason, delivery_ids, level, title, created_at, deadline_at';
    this.insertPendingStmt = db.prepare(
      `INSERT INTO notification_pending
        (id, endpoint_id, member_name, reason, delivery_ids, level, title, created_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectPendingForMemberStmt = db.prepare(
      `SELECT ${PENDING_COLS} FROM notification_pending WHERE member_name = ? ORDER BY created_at ASC`,
    );
    this.selectPendingForMemberReasonStmt = db.prepare(
      `SELECT ${PENDING_COLS} FROM notification_pending
       WHERE member_name = ? AND reason = ? ORDER BY created_at ASC`,
    );
    this.selectPendingDueStmt = db.prepare(
      `SELECT ${PENDING_COLS} FROM notification_pending WHERE deadline_at <= ? ORDER BY deadline_at ASC`,
    );
    this.deletePendingStmt = db.prepare('DELETE FROM notification_pending WHERE id = ?');
    this.deletePendingForEndpointStmt = db.prepare(
      'DELETE FROM notification_pending WHERE endpoint_id = ?',
    );
  }

  // ── Profiles ──

  listProfiles(): NotificationProfile[] {
    const rows = this.selectProfilesStmt.all() as unknown as ProfileRow[];
    return rows.map(rowToProfile);
  }

  getProfile(id: string): NotificationProfile | null {
    const row = this.selectProfileByIdStmt.get(id) as ProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  getProfileBySlug(slug: string): NotificationProfile | null {
    const row = this.selectProfileBySlugStmt.get(slug) as ProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  createProfile(input: {
    slug: string;
    description?: string;
    auth: { kind: NotificationAuthKind; headerName?: string | null; prefix?: string | null };
    creator: string;
    now?: number;
  }): NotificationProfile {
    validateSlug(input.slug);
    if (this.getProfileBySlug(input.slug)) {
      throw new NotificationsError('slug_taken', `a profile called "${input.slug}" already exists`);
    }
    const auth = normalizeAuth(input.auth);
    const now = input.now ?? Date.now();
    const id = globalThis.crypto.randomUUID();
    this.insertProfileStmt.run(
      id,
      input.slug,
      input.description ?? '',
      auth.kind,
      auth.headerName,
      auth.prefix,
      input.creator,
      now,
      now,
    );
    return this.getProfile(id) as NotificationProfile;
  }

  updateProfile(
    id: string,
    patch: {
      description?: string;
      auth?: { kind: NotificationAuthKind; headerName?: string | null; prefix?: string | null };
    },
    now: number = Date.now(),
  ): NotificationProfile {
    const existing = this.getProfile(id);
    if (!existing) throw new NotificationsError('not_found', `profile ${id} not found`);
    const auth = patch.auth ? normalizeAuth(patch.auth) : existing.auth;
    this.updateProfileStmt.run(
      patch.description ?? existing.description,
      auth.kind,
      auth.headerName,
      auth.prefix,
      now,
      id,
    );
    return this.getProfile(id) as NotificationProfile;
  }

  deleteProfile(id: string): void {
    const existing = this.getProfile(id);
    if (!existing) throw new NotificationsError('not_found', `profile ${id} not found`);
    const refs = this.endpointCountForProfile(id);
    if (refs > 0) {
      throw new NotificationsError(
        'profile_in_use',
        `profile "${existing.slug}" is referenced by ${refs} endpoint(s); repoint them first`,
      );
    }
    this.deleteProfileStmt.run(id);
  }

  setProfileSecret(id: string, secret: string, now: number = Date.now()): void {
    if (!this.getProfile(id)) throw new NotificationsError('not_found', `profile ${id} not found`);
    this.setProfileSecretStmt.run(encryptSecret(secret), now, id);
  }

  deleteProfileSecret(id: string): void {
    if (!this.getProfile(id)) throw new NotificationsError('not_found', `profile ${id} not found`);
    this.setProfileSecretStmt.run(null, Date.now(), id);
  }

  hasProfileSecret(id: string): boolean {
    const row = this.selectProfileByIdStmt.get(id) as ProfileRow | undefined;
    return row?.secret_enc != null;
  }

  endpointCountForProfile(id: string): number {
    const row = this.countEndpointsForProfileStmt.get(id) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  // ── Endpoints ──

  list(): NotificationEndpoint[] {
    const rows = this.selectEndpointsStmt.all() as unknown as EndpointRow[];
    return rows.map((r) => this.rowToEndpoint(r));
  }

  get(id: string): NotificationEndpoint | null {
    const row = this.selectEndpointByIdStmt.get(id) as EndpointRow | undefined;
    return row ? this.rowToEndpoint(row) : null;
  }

  getBySlug(slug: string): NotificationEndpoint | null {
    const row = this.selectEndpointBySlugStmt.get(slug) as EndpointRow | undefined;
    return row ? this.rowToEndpoint(row) : null;
  }

  create(input: CreateEndpointInput): NotificationEndpoint {
    validateSlug(input.slug);
    if (this.getBySlug(input.slug)) {
      throw new NotificationsError(
        'slug_taken',
        `an endpoint called "${input.slug}" already exists`,
      );
    }
    validateTargets(input.targets);
    const profileId = this.resolveProfileId(input.authProfile ?? null);
    const auth = normalizeAuth(input.auth);
    const policy = resolvePolicy(input.policy);
    const now = input.now ?? Date.now();
    const id = globalThis.crypto.randomUUID();
    this.insertEndpointStmt.run(
      id,
      input.slug,
      input.displayName ?? '',
      input.description ?? '',
      input.enabled === false ? 0 : 1,
      auth.kind,
      auth.headerName,
      auth.prefix,
      profileId,
      JSON.stringify(input.targets),
      input.level ?? 'info',
      input.title ?? null,
      input.template ?? null,
      JSON.stringify(input.filters ?? []),
      JSON.stringify(policy),
      input.dedupeHeader ?? null,
      input.creator,
      now,
      now,
    );
    return this.get(id) as NotificationEndpoint;
  }

  update(id: string, patch: UpdateEndpointInput, now: number = Date.now()): NotificationEndpoint {
    const row = this.selectEndpointByIdStmt.get(id) as EndpointRow | undefined;
    if (!row) throw new NotificationsError('not_found', `endpoint ${id} not found`);
    const existing = this.rowToEndpoint(row);

    if (patch.targets !== undefined) validateTargets(patch.targets);
    const profileId =
      patch.authProfile === undefined ? row.profile_id : this.resolveProfileId(patch.authProfile);
    const auth = patch.auth ? normalizeAuth(patch.auth) : existing.auth;
    const policy = patch.policy ? { ...existing.policy, ...patch.policy } : existing.policy;

    this.updateEndpointStmt.run(
      patch.displayName ?? existing.displayName,
      patch.description ?? existing.description,
      (patch.enabled ?? existing.enabled) ? 1 : 0,
      auth.kind,
      auth.headerName,
      auth.prefix,
      profileId,
      JSON.stringify(patch.targets ?? existing.targets),
      patch.level ?? existing.level,
      patch.title === undefined ? existing.title : patch.title,
      patch.template === undefined ? existing.template : patch.template,
      JSON.stringify(patch.filters ?? existing.filters),
      JSON.stringify(policy),
      patch.dedupeHeader === undefined ? existing.dedupeHeader : patch.dedupeHeader,
      now,
      id,
    );
    return this.get(id) as NotificationEndpoint;
  }

  delete(id: string): void {
    const existing = this.get(id);
    if (!existing) throw new NotificationsError('not_found', `endpoint ${id} not found`);
    // FK cascades aren't enforced — delete children explicitly, all
    // or nothing.
    this.beginStmt.run();
    try {
      this.deletePendingForEndpointStmt.run(id);
      this.deleteDeliveriesForEndpointStmt.run(id);
      this.deleteEndpointStmt.run(id);
      this.commitStmt.run();
    } catch (err) {
      try {
        this.rollbackStmt.run();
      } catch {
        /* rollback of a failed tx can itself fail — nothing to do */
      }
      throw err;
    }
  }

  setSecret(id: string, secret: string, now: number = Date.now()): void {
    if (!this.get(id)) throw new NotificationsError('not_found', `endpoint ${id} not found`);
    this.setEndpointSecretStmt.run(encryptSecret(secret), now, id);
  }

  deleteSecret(id: string): void {
    if (!this.get(id)) throw new NotificationsError('not_found', `endpoint ${id} not found`);
    this.setEndpointSecretStmt.run(null, Date.now(), id);
  }

  hasSecret(id: string): boolean {
    const row = this.selectEndpointByIdStmt.get(id) as EndpointRow | undefined;
    return row?.secret_enc != null;
  }

  resolveVerification(endpointId: string): ResolvedVerification {
    const row = this.selectEndpointByIdStmt.get(endpointId) as EndpointRow | undefined;
    if (!row) throw new NotificationsError('not_found', `endpoint ${endpointId} not found`);

    let kind = row.auth_kind as NotificationAuthKind;
    let headerName = row.auth_header;
    let prefix = row.auth_prefix;
    let secretEnc = row.secret_enc;

    if (row.profile_id !== null) {
      const profile = this.selectProfileByIdStmt.get(row.profile_id) as ProfileRow | undefined;
      if (profile) {
        kind = profile.auth_kind as NotificationAuthKind;
        headerName = profile.auth_header;
        prefix = profile.auth_prefix;
        secretEnc = profile.secret_enc;
      } else {
        // Referenced profile vanished (should be impossible given the
        // in-use guard) — fail closed rather than fall back to inline.
        secretEnc = null;
      }
    }

    if (secretEnc === null) return { kind, headerName, prefix, secret: null };
    const kek = getKek();
    if (kek === null) {
      throw new NotificationsError(
        'no_kek',
        'no encryption key is active; cannot verify inbound signatures',
      );
    }
    return { kind, headerName, prefix, secret: decryptField(secretEnc, kek) };
  }

  // ── Deliveries ──

  insertDelivery(input: InsertDeliveryInput): DeliveryRecord {
    const id = globalThis.crypto.randomUUID();
    this.insertDeliveryStmt.run(
      id,
      input.endpointId,
      input.endpointSlug,
      input.receivedAt,
      input.status,
      input.statusReason ?? null,
      input.dedupeKey ?? null,
      '[]',
      input.body.slice(0, HOOK_BODY_MAX),
      input.contentType ?? null,
      input.rendered ?? '',
      input.level,
      input.title ?? null,
      input.overrides ? JSON.stringify(input.overrides) : null,
      null,
      input.replayOf ?? null,
    );
    return this.getDeliveryRecord(id) as DeliveryRecord;
  }

  getDeliveryRecord(id: string): DeliveryRecord | null {
    const row = this.selectDeliveryByIdStmt.get(id) as DeliveryDbRow | undefined;
    return row ? rowToDelivery(row) : null;
  }

  findDeliveryByDedupe(endpointId: string, dedupeKey: string): DeliveryRecord | null {
    const row = this.selectDeliveryByDedupeStmt.get(endpointId, dedupeKey) as
      | DeliveryDbRow
      | undefined;
    return row ? rowToDelivery(row) : null;
  }

  updateDelivery(
    id: string,
    patch: {
      status?: NotificationDeliveryStatus;
      statusReason?: string | null;
      addMessageIds?: string[];
      rendered?: string;
      deliveredAt?: number;
    },
  ): void {
    const existing = this.getDeliveryRecord(id);
    if (!existing) throw new NotificationsError('not_found', `delivery ${id} not found`);
    const messageIds = patch.addMessageIds
      ? [...existing.messageIds, ...patch.addMessageIds]
      : existing.messageIds;
    this.updateDeliveryStmt.run(
      patch.status ?? existing.status,
      patch.statusReason === undefined ? existing.statusReason : patch.statusReason,
      JSON.stringify(messageIds),
      patch.rendered ?? existing.rendered,
      patch.deliveredAt ?? existing.deliveredAt,
      id,
    );
  }

  deliveriesByIds(ids: string[]): DeliveryRecord[] {
    const out: DeliveryRecord[] = [];
    for (const id of ids) {
      const record = this.getDeliveryRecord(id);
      if (record) out.push(record);
    }
    return out;
  }

  listDeliveries(
    endpointId: string,
    opts?: { limit?: number; before?: number },
  ): NotificationDelivery[] {
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500));
    const rows =
      opts?.before !== undefined
        ? (this.selectDeliveriesBeforeStmt.all(
            endpointId,
            opts.before,
            limit,
          ) as unknown as DeliveryDbRow[])
        : (this.selectDeliveriesStmt.all(endpointId, limit) as unknown as DeliveryDbRow[]);
    return rows.map((r) => toWireDelivery(rowToDelivery(r)));
  }

  listStrandedDebounce(): DeliveryRecord[] {
    const rows = this.selectStrandedDebounceStmt.all() as unknown as DeliveryDbRow[];
    return rows.map(rowToDelivery);
  }

  // ── Pending queue ──

  insertPending(input: Omit<PendingRecord, 'id'>): PendingRecord {
    const id = globalThis.crypto.randomUUID();
    this.insertPendingStmt.run(
      id,
      input.endpointId,
      input.memberName,
      input.reason,
      JSON.stringify(input.deliveryIds),
      input.level,
      input.title,
      input.createdAt,
      input.deadlineAt,
    );
    return { ...input, id };
  }

  pendingForMember(memberName: string, reason?: 'offline' | 'busy'): PendingRecord[] {
    const rows = reason
      ? (this.selectPendingForMemberReasonStmt.all(memberName, reason) as unknown as PendingDbRow[])
      : (this.selectPendingForMemberStmt.all(memberName) as unknown as PendingDbRow[]);
    return rows.map(rowToPending);
  }

  pendingDue(now: number): PendingRecord[] {
    const rows = this.selectPendingDueStmt.all(now) as unknown as PendingDbRow[];
    return rows.map(rowToPending);
  }

  deletePending(ids: string[]): void {
    for (const id of ids) this.deletePendingStmt.run(id);
  }

  // ── Internals ──

  private resolveProfileId(profileSlug: string | null): string | null {
    if (profileSlug === null) return null;
    const profile = this.getProfileBySlug(profileSlug);
    if (!profile) {
      throw new NotificationsError('unknown_profile', `no such auth profile: ${profileSlug}`);
    }
    return profile.id;
  }

  private rowToEndpoint(row: EndpointRow): NotificationEndpoint {
    let authProfile: string | null = null;
    if (row.profile_id !== null) {
      const profile = this.selectProfileByIdStmt.get(row.profile_id) as ProfileRow | undefined;
      authProfile = profile?.slug ?? null;
    }
    return {
      id: row.id,
      slug: row.slug,
      displayName: row.display_name,
      description: row.description,
      enabled: row.enabled === 1,
      auth: {
        kind: row.auth_kind as NotificationAuthKind,
        headerName: row.auth_header,
        prefix: row.auth_prefix,
      },
      authProfile,
      targets: parseJsonArray<NotificationTarget>(row.targets),
      level: row.level as LogLevel,
      title: row.title,
      template: row.template,
      filters: parseJsonArray<NotificationFilterRule>(row.filters),
      policy: resolvePolicy(safeParsePolicy(row.policy)),
      dedupeHeader: row.dedupe_header,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function validateSlug(slug: string): void {
  try {
    validateSourceSlug(slug);
  } catch (err) {
    throw new NotificationsError('invalid_input', err instanceof Error ? err.message : String(err));
  }
}

function validateTargets(targets: NotificationTarget[]): void {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new NotificationsError('invalid_input', 'at least one target is required');
  }
  for (const t of targets) {
    const hasMember = typeof t.member === 'string' && t.member.length > 0;
    const hasChannel = typeof t.channel === 'string' && t.channel.length > 0;
    if (hasMember === hasChannel) {
      throw new NotificationsError(
        'invalid_input',
        'each target must set exactly one of member / channel',
      );
    }
  }
}

function safeParsePolicy(raw: string): Partial<NotificationDeliveryPolicy> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Partial<NotificationDeliveryPolicy>)
      : {};
  } catch {
    return {};
  }
}

function rowToProfile(row: ProfileRow): NotificationProfile {
  return {
    id: row.id,
    slug: row.slug,
    description: row.description,
    auth: {
      kind: row.auth_kind as NotificationAuthKind,
      headerName: row.auth_header,
      prefix: row.auth_prefix,
    },
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDelivery(row: DeliveryDbRow): DeliveryRecord {
  let overrides: NotificationOverrides | null = null;
  if (row.overrides !== null) {
    try {
      overrides = JSON.parse(row.overrides) as NotificationOverrides;
    } catch {
      overrides = null;
    }
  }
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    endpointSlug: row.endpoint_slug,
    receivedAt: row.received_at,
    status: row.status as NotificationDeliveryStatus,
    statusReason: row.status_reason,
    dedupeKey: row.dedupe_key,
    messageIds: parseJsonArray<string>(row.message_ids),
    body: row.body,
    contentType: row.content_type,
    rendered: row.rendered,
    level: row.level as LogLevel,
    title: row.title,
    overrides,
    deliveredAt: row.delivered_at,
    replayOf: row.replay_of,
  };
}

function rowToPending(row: PendingDbRow): PendingRecord {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    memberName: row.member_name,
    reason: row.reason as 'offline' | 'busy',
    deliveryIds: parseJsonArray<string>(row.delivery_ids),
    level: row.level as LogLevel,
    title: row.title,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
  };
}

export function createSqliteNotificationsStore(db: DatabaseSyncInstance): NotificationsStore {
  return new SqliteNotificationsStore(db);
}
