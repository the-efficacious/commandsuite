/**
 * Channels store — SQLite-backed CRUD + membership for named team channels.
 *
 * Sits alongside the event log and objectives store, sharing the same
 * `DatabaseSync` handle. Channels are Slack-style named threads that
 * partition team chat: any team member can create one, the creator
 * joins as an ordinary member, and members explicitly join (the lone exception
 * is `#general`, which everyone is implicitly in — see below).
 *
 * Identifier model:
 *   - `id`   — opaque, immutable. Messages reference channels by id
 *              via `data.thread = 'chan:<id>'` so renaming a channel
 *              never orphans its history.
 *   - `slug` — mutable, unique, lowercase-kebab. The user-facing
 *              identifier (URL segment, display label). Renaming
 *              changes the slug, not the id.
 *
 * The well-known `general` channel:
 *   - id = 'general' (constant, hardcoded)
 *   - slug = 'general' (immutable for general specifically)
 *   - Has NO `channel_members` rows — the broker treats general as
 *     broadcast-to-all-team. Every team member is implicitly in
 *     general; you can't join, can't leave, can't archive, can't
 *     rename. Seeded by `ensureGeneral()` on store construction.
 *
 * Membership roles:
 *   - `admin`  — legacy observational value only; authorization is
 *                exclusively the broker's `channels.manage` permission.
 *   - `member` — can read + post + leave.
 *
 * Slug grammar:
 *   - 1–32 chars
 *   - lowercase ASCII letters, digits, `-`
 *   - must start + end with alphanumeric
 *   - no consecutive dashes
 *
 * The store is intentionally synchronous (matches `node:sqlite`'s
 * surface). The HTTP layer wraps responses in `c.json` which is
 * already async — no value in faking promise returns here.
 */

import { GENERAL_CHANNEL_ID } from './event-log.js';
import { runInTransaction, type SqlDriver, type SqlStatement } from './sql-driver.js';
export const GENERAL_CHANNEL_SLUG = 'general';
const SYSTEM_ACTOR = '__system__';

export type ChannelMemberRole = 'admin' | 'member';

export interface Channel {
  id: string;
  slug: string;
  description: string;
  createdBy: string;
  createdAt: number;
  archivedAt: number | null;
}

export interface ChannelAuditEntry {
  id: number;
  channelId: string;
  actor: string;
  action:
    | 'create'
    | 'rename'
    | 'description'
    | 'member_add'
    | 'member_remove'
    | 'member_role'
    | 'archive';
  at: number;
  details: Record<string, string | null>;
}

export interface ChannelMember {
  channelId: string;
  memberName: string;
  role: ChannelMemberRole;
  joinedAt: number;
}

export class ChannelsError extends Error {
  readonly code:
    | 'not_found'
    | 'invalid_input'
    | 'slug_taken'
    | 'forbidden'
    | 'already_member'
    | 'not_member'
    | 'reserved'
    | 'archived';
  constructor(code: ChannelsError['code'], message: string) {
    super(message);
    this.name = 'ChannelsError';
    this.code = code;
  }
}

interface ChannelRow {
  id: string;
  slug: string;
  description: string;
  created_by: string;
  created_at: number;
  archived_at: number | null;
}

interface MemberRow {
  channel_id: string;
  member_name: string;
  role: string;
  joined_at: number;
}

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  -- Partial unique index: only one ACTIVE channel can hold a given
  -- slug. Archived channels keep their slug on the row for history,
  -- but a new channel can reclaim the same slug after archive.
  CREATE UNIQUE INDEX IF NOT EXISTS channels_slug_active_idx
    ON channels (slug) WHERE archived_at IS NULL;
  CREATE INDEX IF NOT EXISTS channels_archived_idx ON channels (archived_at);

  CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL,
    member_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','member')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, member_name),
    FOREIGN KEY (channel_id) REFERENCES channels(id)
  );
  CREATE INDEX IF NOT EXISTS channel_members_member_idx ON channel_members (member_name);
  CREATE TABLE IF NOT EXISTS channel_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    at INTEGER NOT NULL,
    details_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS channel_audit_channel_idx ON channel_audit(channel_id, id);
`;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/;
const SLUG_MAX = 32;

export function validateSlug(slug: string): void {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new ChannelsError('invalid_input', 'slug is required');
  }
  if (slug.length > SLUG_MAX) {
    throw new ChannelsError('invalid_input', `slug too long (max ${SLUG_MAX})`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new ChannelsError(
      'invalid_input',
      'slug must be lowercase letters/digits/dashes, no consecutive dashes, no leading/trailing dash',
    );
  }
}

export interface ChannelStore {
  /** All non-archived channels, newest-first. */
  listAll(): Channel[];
  /** Channels this member belongs to (always includes general), newest-first. */
  listForMember(memberName: string): Channel[];
  /** Get a channel by id. */
  get(id: string): Channel | null;
  /** Get a channel by slug. */
  getBySlug(slug: string): Channel | null;
  /** Create a new channel; creator joins as an ordinary member. */
  create(input: { slug: string; description?: string; creator: string; now?: number }): Channel;
  update(
    id: string,
    input: { slug?: string; description?: string },
    actor: string,
    now?: number,
  ): Channel;
  /**
   * Rename (change the slug). Forbidden for general. The id is
   * unchanged so existing message references stay valid.
   */
  rename(id: string, newSlug: string, actor: string): Channel;
  /** Soft-archive a channel. Forbidden for general. */
  archive(id: string, actor: string, now?: number): Channel;
  listAudit(id: string): ChannelAuditEntry[];

  /**
   * List channel members ordered by role (admins first), then
   * joined_at ascending. Returns `[]` for general — its membership
   * is implicit-everyone and not stored.
   */
  listMembers(id: string): ChannelMember[];
  /** Add a member to a channel. No-op if already present. */
  addMember(input: {
    channelId: string;
    memberName: string;
    role?: ChannelMemberRole;
    now?: number;
    actor?: string;
  }): void;
  /** Remove a member from a channel. */
  removeMember(channelId: string, memberName: string, actor?: string, now?: number): void;
  /** Whether `memberName` is in the channel (general → always true). */
  isMember(channelId: string, memberName: string): boolean;
  /** Member's role in the channel, or null if not a member. */
  roleOf(channelId: string, memberName: string): ChannelMemberRole | null;

  /**
   * Member names that should receive a fanout for this channel. For
   * general, returns null to signal "broadcast to all" (the broker
   * resolves the team roster). For any other channel, returns the
   * explicit member set.
   */
  recipientNames(channelId: string): string[] | null;
}

class SqliteChannelStore implements ChannelStore {
  private readonly db: SqlDriver;
  private readonly insertChannelStmt: SqlStatement;
  private readonly updateSlugStmt: SqlStatement;
  private readonly archiveStmt: SqlStatement;
  private readonly selectByIdStmt: SqlStatement;
  private readonly selectBySlugStmt: SqlStatement;
  private readonly selectAllActiveStmt: SqlStatement;
  private readonly selectForMemberStmt: SqlStatement;

  private readonly insertMemberStmt: SqlStatement;
  private readonly deleteMemberStmt: SqlStatement;
  private readonly selectMembersStmt: SqlStatement;
  private readonly selectMemberStmt: SqlStatement;
  private readonly insertAuditStmt: SqlStatement;
  private readonly selectAuditStmt: SqlStatement;

  constructor(db: SqlDriver) {
    this.db = db;
    this.db.exec(CREATE_SCHEMA);
    const columns = db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'description')) {
      db.exec("ALTER TABLE channels ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    }

    this.insertChannelStmt = db.prepare(
      'INSERT INTO channels (id, slug, description, created_by, created_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL)',
    );
    this.updateSlugStmt = db.prepare('UPDATE channels SET slug = ?, description = ? WHERE id = ?');
    this.archiveStmt = db.prepare('UPDATE channels SET archived_at = ? WHERE id = ?');
    this.selectByIdStmt = db.prepare(
      'SELECT id, slug, description, created_by, created_at, archived_at FROM channels WHERE id = ?',
    );
    this.selectBySlugStmt = db.prepare(
      'SELECT id, slug, description, created_by, created_at, archived_at FROM channels WHERE slug = ?',
    );
    this.selectAllActiveStmt = db.prepare(
      'SELECT id, slug, description, created_by, created_at, archived_at FROM channels WHERE archived_at IS NULL ORDER BY created_at DESC',
    );
    // General is the implicit-everyone channel. Always include it in
    // a member's channel list even though it has no membership row.
    this.selectForMemberStmt = db.prepare(
      `SELECT c.id, c.slug, c.description, c.created_by, c.created_at, c.archived_at
       FROM channels c
       WHERE c.archived_at IS NULL
         AND (c.id = '${GENERAL_CHANNEL_ID}' OR EXISTS (
           SELECT 1 FROM channel_members m
           WHERE m.channel_id = c.id AND m.member_name = ?
         ))
       ORDER BY c.created_at DESC`,
    );

    this.insertMemberStmt = db.prepare(
      'INSERT OR IGNORE INTO channel_members (channel_id, member_name, role, joined_at) VALUES (?, ?, ?, ?)',
    );
    this.deleteMemberStmt = db.prepare(
      'DELETE FROM channel_members WHERE channel_id = ? AND member_name = ?',
    );
    this.selectMembersStmt = db.prepare(
      `SELECT channel_id, member_name, role, joined_at
       FROM channel_members
       WHERE channel_id = ?
       ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at ASC`,
    );
    this.selectMemberStmt = db.prepare(
      'SELECT channel_id, member_name, role, joined_at FROM channel_members WHERE channel_id = ? AND member_name = ?',
    );
    this.insertAuditStmt = db.prepare(
      'INSERT INTO channel_audit (channel_id, actor, action, at, details_json) VALUES (?, ?, ?, ?, ?)',
    );
    this.selectAuditStmt = db.prepare(
      'SELECT id, channel_id, actor, action, at, details_json FROM channel_audit WHERE channel_id = ? ORDER BY id ASC',
    );

    this.ensureGeneral();
  }

  private ensureGeneral(): void {
    const existing = this.selectByIdStmt.get(GENERAL_CHANNEL_ID) as ChannelRow | undefined;
    if (existing) return;
    this.insertChannelStmt.run(
      GENERAL_CHANNEL_ID,
      GENERAL_CHANNEL_SLUG,
      '',
      SYSTEM_ACTOR,
      Date.now(),
    );
  }

  listAll(): Channel[] {
    const rows = this.selectAllActiveStmt.all() as unknown as ChannelRow[];
    return rows.map(rowToChannel);
  }

  listForMember(memberName: string): Channel[] {
    const rows = this.selectForMemberStmt.all(memberName) as unknown as ChannelRow[];
    return rows.map(rowToChannel);
  }

  get(id: string): Channel | null {
    const row = this.selectByIdStmt.get(id) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  getBySlug(slug: string): Channel | null {
    const row = this.selectBySlugStmt.get(slug) as ChannelRow | undefined;
    return row ? rowToChannel(row) : null;
  }

  create({
    slug,
    description = '',
    creator,
    now = Date.now(),
  }: {
    slug: string;
    description?: string;
    creator: string;
    now?: number;
  }): Channel {
    validateSlug(slug);
    if (slug === GENERAL_CHANNEL_SLUG) {
      throw new ChannelsError('reserved', `slug "${slug}" is reserved`);
    }
    const existing = this.getBySlug(slug);
    if (existing && existing.archivedAt === null) {
      throw new ChannelsError('slug_taken', `a channel called "${slug}" already exists`);
    }
    const id = generateChannelId();
    runInTransaction(this.db, () => {
      this.insertChannelStmt.run(id, slug, description, creator, now);
      this.insertMemberStmt.run(id, creator, 'member', now);
      this.audit(id, creator, 'create', now, { slug, description });
    });
    const created = this.get(id);
    if (!created) throw new Error('channels.create: row vanished after insert');
    return created;
  }

  rename(id: string, newSlug: string, actor: string): Channel {
    return this.update(id, { slug: newSlug }, actor);
  }

  update(
    id: string,
    input: { slug?: string; description?: string },
    actor: string,
    now = Date.now(),
  ): Channel {
    if (input.slug !== undefined) validateSlug(input.slug);
    if (id === GENERAL_CHANNEL_ID) {
      throw new ChannelsError('reserved', 'general cannot be renamed');
    }
    if (input.slug === GENERAL_CHANNEL_SLUG) {
      throw new ChannelsError('reserved', `slug "${input.slug}" is reserved`);
    }
    const channel = this.get(id);
    if (!channel) throw new ChannelsError('not_found', `channel ${id} not found`);
    if (channel.archivedAt !== null) {
      throw new ChannelsError('archived', 'cannot rename an archived channel');
    }
    const nextSlug = input.slug ?? channel.slug;
    const nextDescription = input.description ?? channel.description;
    if (channel.slug === nextSlug && channel.description === nextDescription) return channel;
    const collide = this.getBySlug(nextSlug);
    if (collide && collide.id !== id && collide.archivedAt === null) {
      throw new ChannelsError('slug_taken', `a channel called "${nextSlug}" already exists`);
    }
    runInTransaction(this.db, () => {
      this.updateSlugStmt.run(nextSlug, nextDescription, id);
      if (channel.slug !== nextSlug)
        this.audit(id, actor, 'rename', now, { from: channel.slug, to: nextSlug });
      if (channel.description !== nextDescription)
        this.audit(id, actor, 'description', now, {
          from: channel.description,
          to: nextDescription,
        });
    });
    return this.get(id) as Channel;
  }

  archive(id: string, actor: string, now: number = Date.now()): Channel {
    if (id === GENERAL_CHANNEL_ID) {
      throw new ChannelsError('reserved', 'general cannot be archived');
    }
    const channel = this.get(id);
    if (!channel) throw new ChannelsError('not_found', `channel ${id} not found`);
    if (channel.archivedAt !== null) return channel; // already archived
    runInTransaction(this.db, () => {
      this.archiveStmt.run(now, id);
      this.audit(id, actor, 'archive', now, { slug: channel.slug });
    });
    return this.get(id) as Channel;
  }

  listMembers(id: string): ChannelMember[] {
    if (id === GENERAL_CHANNEL_ID) return [];
    const rows = this.selectMembersStmt.all(id) as unknown as MemberRow[];
    return rows.map(rowToMember);
  }

  addMember({
    channelId,
    memberName,
    role = 'member',
    now = Date.now(),
    actor = memberName,
  }: {
    channelId: string;
    memberName: string;
    role?: ChannelMemberRole;
    now?: number;
    actor?: string;
  }): void {
    if (channelId === GENERAL_CHANNEL_ID) return; // implicit-everyone, no-op
    const channel = this.get(channelId);
    if (!channel) throw new ChannelsError('not_found', `channel ${channelId} not found`);
    if (channel.archivedAt !== null) {
      throw new ChannelsError('archived', 'cannot add members to an archived channel');
    }
    const prior = this.roleOf(channelId, memberName);
    runInTransaction(this.db, () => {
      if (prior !== null) this.deleteMemberStmt.run(channelId, memberName);
      this.insertMemberStmt.run(channelId, memberName, role, now);
      this.audit(channelId, actor, prior === null ? 'member_add' : 'member_role', now, {
        member: memberName,
        from: prior,
        to: role,
      });
    });
  }

  removeMember(channelId: string, memberName: string, actor = memberName, now = Date.now()): void {
    if (channelId === GENERAL_CHANNEL_ID) {
      throw new ChannelsError('reserved', 'general membership is implicit and cannot be modified');
    }
    const channel = this.get(channelId);
    if (!channel) throw new ChannelsError('not_found', `channel ${channelId} not found`);
    const member = this.selectMemberStmt.get(channelId, memberName) as MemberRow | undefined;
    if (!member) throw new ChannelsError('not_member', `${memberName} is not in this channel`);
    runInTransaction(this.db, () => {
      this.deleteMemberStmt.run(channelId, memberName);
      this.audit(channelId, actor, 'member_remove', now, { member: memberName, role: member.role });
    });
  }

  listAudit(id: string): ChannelAuditEntry[] {
    return (
      this.selectAuditStmt.all(id) as Array<{
        id: number;
        channel_id: string;
        actor: string;
        action: ChannelAuditEntry['action'];
        at: number;
        details_json: string;
      }>
    ).map((row) => ({
      id: Number(row.id),
      channelId: row.channel_id,
      actor: row.actor,
      action: row.action,
      at: Number(row.at),
      details: JSON.parse(row.details_json) as Record<string, string | null>,
    }));
  }

  private audit(
    channelId: string,
    actor: string,
    action: ChannelAuditEntry['action'],
    at: number,
    details: Record<string, string | null>,
  ): void {
    this.insertAuditStmt.run(channelId, actor, action, at, JSON.stringify(details));
  }

  isMember(channelId: string, memberName: string): boolean {
    if (channelId === GENERAL_CHANNEL_ID) return true;
    return this.selectMemberStmt.get(channelId, memberName) !== undefined;
  }

  roleOf(channelId: string, memberName: string): ChannelMemberRole | null {
    if (channelId === GENERAL_CHANNEL_ID) return 'member';
    const row = this.selectMemberStmt.get(channelId, memberName) as MemberRow | undefined;
    if (!row) return null;
    return row.role === 'admin' ? 'admin' : 'member';
  }

  recipientNames(channelId: string): string[] | null {
    if (channelId === GENERAL_CHANNEL_ID) return null;
    const rows = this.selectMembersStmt.all(channelId) as unknown as MemberRow[];
    return rows.map((r) => r.member_name);
  }
}

function rowToChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    slug: row.slug,
    description: row.description,
    createdBy: row.created_by,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

function rowToMember(row: MemberRow): ChannelMember {
  return {
    channelId: row.channel_id,
    memberName: row.member_name,
    role: row.role === 'admin' ? 'admin' : 'member',
    joinedAt: row.joined_at,
  };
}

export function createSqliteChannelStore(db: SqlDriver): ChannelStore {
  return new SqliteChannelStore(db);
}

function generateChannelId(): string {
  // Web-Crypto UUID v4 — short, unique, opaque. Same approach as
  // generateObjectiveId so id formats stay consistent across stores.
  return globalThis.crypto.randomUUID();
}
