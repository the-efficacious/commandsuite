/**
 * Channels store — SQLite-backed CRUD + membership for named team channels.
 *
 * Sits alongside the event log and objectives store, sharing the same
 * `DatabaseSync` handle. Channels are Slack-style named threads that
 * partition team chat: any team member can create one, the creator
 * becomes its admin, and members explicitly join (the lone exception
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
 *   - `admin`  — can rename, archive, add/remove members. Creator
 *                is auto-admin. Last-admin guard on remove.
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

import type { DatabaseSyncInstance, StatementInstance } from './db.js';

export const GENERAL_CHANNEL_ID = 'general';
export const GENERAL_CHANNEL_SLUG = 'general';
const SYSTEM_ACTOR = '__system__';

export type ChannelMemberRole = 'admin' | 'member';

export interface Channel {
  id: string;
  slug: string;
  createdBy: string;
  createdAt: number;
  archivedAt: number | null;
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
  /** Create a new channel; creator becomes admin. */
  create(input: { slug: string; creator: string; now?: number }): Channel;
  /**
   * Rename (change the slug). Forbidden for general. The id is
   * unchanged so existing message references stay valid.
   */
  rename(id: string, newSlug: string, actor: string): Channel;
  /** Soft-archive a channel. Forbidden for general. */
  archive(id: string, actor: string, now?: number): Channel;

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
  }): void;
  /** Remove a member from a channel. */
  removeMember(channelId: string, memberName: string): void;
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
  private readonly db: DatabaseSyncInstance;
  private readonly insertChannelStmt: StatementInstance;
  private readonly updateSlugStmt: StatementInstance;
  private readonly archiveStmt: StatementInstance;
  private readonly selectByIdStmt: StatementInstance;
  private readonly selectBySlugStmt: StatementInstance;
  private readonly selectAllActiveStmt: StatementInstance;
  private readonly selectForMemberStmt: StatementInstance;

  private readonly insertMemberStmt: StatementInstance;
  private readonly deleteMemberStmt: StatementInstance;
  private readonly selectMembersStmt: StatementInstance;
  private readonly selectMemberStmt: StatementInstance;

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    this.db.exec(CREATE_SCHEMA);

    this.insertChannelStmt = db.prepare(
      'INSERT INTO channels (id, slug, created_by, created_at, archived_at) VALUES (?, ?, ?, ?, NULL)',
    );
    this.updateSlugStmt = db.prepare('UPDATE channels SET slug = ? WHERE id = ?');
    this.archiveStmt = db.prepare('UPDATE channels SET archived_at = ? WHERE id = ?');
    this.selectByIdStmt = db.prepare(
      'SELECT id, slug, created_by, created_at, archived_at FROM channels WHERE id = ?',
    );
    this.selectBySlugStmt = db.prepare(
      'SELECT id, slug, created_by, created_at, archived_at FROM channels WHERE slug = ?',
    );
    this.selectAllActiveStmt = db.prepare(
      'SELECT id, slug, created_by, created_at, archived_at FROM channels WHERE archived_at IS NULL ORDER BY created_at DESC',
    );
    // General is the implicit-everyone channel. Always include it in
    // a member's channel list even though it has no membership row.
    this.selectForMemberStmt = db.prepare(
      `SELECT c.id, c.slug, c.created_by, c.created_at, c.archived_at
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

    this.ensureGeneral();
  }

  private ensureGeneral(): void {
    const existing = this.selectByIdStmt.get(GENERAL_CHANNEL_ID) as ChannelRow | undefined;
    if (existing) return;
    this.insertChannelStmt.run(GENERAL_CHANNEL_ID, GENERAL_CHANNEL_SLUG, SYSTEM_ACTOR, Date.now());
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
    creator,
    now = Date.now(),
  }: {
    slug: string;
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
    this.insertChannelStmt.run(id, slug, creator, now);
    this.insertMemberStmt.run(id, creator, 'admin', now);
    const created = this.get(id);
    if (!created) throw new Error('channels.create: row vanished after insert');
    return created;
  }

  rename(id: string, newSlug: string, actor: string): Channel {
    validateSlug(newSlug);
    if (id === GENERAL_CHANNEL_ID) {
      throw new ChannelsError('reserved', 'general cannot be renamed');
    }
    if (newSlug === GENERAL_CHANNEL_SLUG) {
      throw new ChannelsError('reserved', `slug "${newSlug}" is reserved`);
    }
    const channel = this.get(id);
    if (!channel) throw new ChannelsError('not_found', `channel ${id} not found`);
    if (channel.archivedAt !== null) {
      throw new ChannelsError('archived', 'cannot rename an archived channel');
    }
    if (channel.slug === newSlug) return channel; // no-op
    const role = this.roleOf(id, actor);
    if (role !== 'admin') throw new ChannelsError('forbidden', 'only admins can rename');
    const collide = this.getBySlug(newSlug);
    if (collide && collide.id !== id && collide.archivedAt === null) {
      throw new ChannelsError('slug_taken', `a channel called "${newSlug}" already exists`);
    }
    this.updateSlugStmt.run(newSlug, id);
    return this.get(id) as Channel;
  }

  archive(id: string, actor: string, now: number = Date.now()): Channel {
    if (id === GENERAL_CHANNEL_ID) {
      throw new ChannelsError('reserved', 'general cannot be archived');
    }
    const channel = this.get(id);
    if (!channel) throw new ChannelsError('not_found', `channel ${id} not found`);
    if (channel.archivedAt !== null) return channel; // already archived
    const role = this.roleOf(id, actor);
    if (role !== 'admin') throw new ChannelsError('forbidden', 'only admins can archive');
    this.archiveStmt.run(now, id);
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
  }: {
    channelId: string;
    memberName: string;
    role?: ChannelMemberRole;
    now?: number;
  }): void {
    if (channelId === GENERAL_CHANNEL_ID) return; // implicit-everyone, no-op
    const channel = this.get(channelId);
    if (!channel) throw new ChannelsError('not_found', `channel ${channelId} not found`);
    if (channel.archivedAt !== null) {
      throw new ChannelsError('archived', 'cannot add members to an archived channel');
    }
    this.insertMemberStmt.run(channelId, memberName, role, now);
  }

  removeMember(channelId: string, memberName: string): void {
    if (channelId === GENERAL_CHANNEL_ID) {
      throw new ChannelsError('reserved', 'general membership is implicit and cannot be modified');
    }
    const channel = this.get(channelId);
    if (!channel) throw new ChannelsError('not_found', `channel ${channelId} not found`);
    const member = this.selectMemberStmt.get(channelId, memberName) as MemberRow | undefined;
    if (!member) throw new ChannelsError('not_member', `${memberName} is not in this channel`);
    // Last-admin guard: if this remove would leave the channel with
    // zero admins AND there are other members remaining, refuse so
    // the channel doesn't become orphaned.
    if (member.role === 'admin') {
      const others = (this.selectMembersStmt.all(channelId) as unknown as MemberRow[]).filter(
        (m) => m.member_name !== memberName,
      );
      const remainingAdmins = others.filter((m) => m.role === 'admin');
      if (remainingAdmins.length === 0 && others.length > 0) {
        throw new ChannelsError(
          'forbidden',
          'cannot remove the last admin while other members remain — promote another admin first',
        );
      }
    }
    this.deleteMemberStmt.run(channelId, memberName);
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

export function createSqliteChannelStore(db: DatabaseSyncInstance): ChannelStore {
  return new SqliteChannelStore(db);
}

function generateChannelId(): string {
  // Web-Crypto UUID v4 — short, unique, opaque. Same approach as
  // generateObjectiveId so id formats stay consistent across stores.
  return globalThis.crypto.randomUUID();
}
