import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ChannelStore,
  ChannelsError,
  createSqliteChannelStore,
  GENERAL_CHANNEL_ID,
  GENERAL_CHANNEL_SLUG,
  validateSlug,
} from 'csuite-core';
import { afterEach, describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';

describe('ChannelStore', () => {
  const dirsToClean: string[] = [];
  const dbsToClose: DatabaseSyncInstance[] = [];

  afterEach(() => {
    for (const db of dbsToClose.splice(0)) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeStore(): ChannelStore {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-channels-test-'));
    dirsToClean.push(dir);
    const db = openDatabase(join(dir, 'channels.db'));
    dbsToClose.push(db);
    return createSqliteChannelStore(db);
  }

  describe('general channel', () => {
    it('seeds a general channel on construction', () => {
      const store = makeStore();
      const general = store.get(GENERAL_CHANNEL_ID);
      expect(general).not.toBeNull();
      expect(general?.slug).toBe(GENERAL_CHANNEL_SLUG);
      expect(general?.archivedAt).toBeNull();
    });

    it('appears in listAll without explicit creation', () => {
      const store = makeStore();
      expect(store.listAll().some((c) => c.id === GENERAL_CHANNEL_ID)).toBe(true);
    });

    it('appears for any member in listForMember even without a row', async () => {
      const store = makeStore();
      expect(
        await store.listForMember('nobody-special').some((c) => c.id === GENERAL_CHANNEL_ID),
      ).toBe(true);
    });

    it('isMember(general, ...) is always true', () => {
      const store = makeStore();
      expect(store.isMember(GENERAL_CHANNEL_ID, 'alice')).toBe(true);
      expect(store.isMember(GENERAL_CHANNEL_ID, 'random')).toBe(true);
    });

    it('listMembers(general) returns empty (membership is implicit)', () => {
      const store = makeStore();
      expect(store.listMembers(GENERAL_CHANNEL_ID)).toEqual([]);
    });

    it('recipientNames(general) returns null to signal broadcast', () => {
      const store = makeStore();
      expect(store.recipientNames(GENERAL_CHANNEL_ID)).toBeNull();
    });

    it('refuses to rename, archive, or remove members', () => {
      const store = makeStore();
      expect(() => store.rename(GENERAL_CHANNEL_ID, 'lobby', 'alice')).toThrow(ChannelsError);
      expect(() => store.archive(GENERAL_CHANNEL_ID, 'alice')).toThrow(ChannelsError);
      expect(() => store.removeMember(GENERAL_CHANNEL_ID, 'alice')).toThrow(ChannelsError);
    });

    it('refuses to create another channel using the general slug', () => {
      const store = makeStore();
      expect(() => store.create({ slug: 'general', creator: 'alice' })).toThrow(/reserved/i);
    });

    it('addMember(general, ...) is a no-op (does not create a row)', () => {
      const store = makeStore();
      store.addMember({ channelId: GENERAL_CHANNEL_ID, memberName: 'alice' });
      expect(store.listMembers(GENERAL_CHANNEL_ID)).toEqual([]);
    });
  });

  describe('create', () => {
    it('creates a channel and adds the creator as a regular member', () => {
      const store = makeStore();
      const channel = store.create({ slug: 'ops', creator: 'alice', now: 1000 });
      expect(channel.slug).toBe('ops');
      expect(channel.createdBy).toBe('alice');
      expect(channel.createdAt).toBe(1000);
      expect(channel.archivedAt).toBeNull();
      const members = store.listMembers(channel.id);
      expect(members).toHaveLength(1);
      expect(members[0]?.memberName).toBe('alice');
      expect(members[0]?.role).toBe('member');
      expect(store.listAudit(channel.id)).toEqual([
        expect.objectContaining({ actor: 'alice', action: 'create' }),
      ]);
    });

    it('rejects a slug that already exists (active)', () => {
      const store = makeStore();
      store.create({ slug: 'ops', creator: 'alice' });
      expect(() => store.create({ slug: 'ops', creator: 'bob' })).toThrow(/already exists/);
    });

    it('allows reusing a slug after the original is archived', () => {
      const store = makeStore();
      const first = store.create({ slug: 'ops', creator: 'alice' });
      store.archive(first.id, 'alice');
      const second = store.create({ slug: 'ops', creator: 'bob' });
      expect(second.id).not.toBe(first.id);
      expect(second.slug).toBe('ops');
    });

    it.each([
      ['too short', ''],
      ['has uppercase', 'Ops'],
      ['leading dash', '-ops'],
      ['trailing dash', 'ops-'],
      ['consecutive dashes', 'ops--team'],
      ['has space', 'ops team'],
      ['has underscore', 'ops_team'],
      ['too long', 'a'.repeat(33)],
    ])('rejects invalid slug (%s: %s)', (_label, slug) => {
      const store = makeStore();
      expect(() => store.create({ slug, creator: 'alice' })).toThrow(ChannelsError);
    });

    it.each([['ops'], ['customer-research'], ['q4-launch-prep'], ['a'], ['1on1'], ['team-x42']])(
      'accepts valid slug "%s"',
      (slug) => {
        const store = makeStore();
        expect(() => store.create({ slug, creator: 'alice' })).not.toThrow();
      },
    );
  });

  describe('rename', () => {
    it('updates slug while preserving id and members', () => {
      const store = makeStore();
      const ch = store.create({ slug: 'ops', creator: 'alice' });
      const id = ch.id;
      const renamed = store.rename(id, 'ops-team', 'alice');
      expect(renamed.id).toBe(id);
      expect(renamed.slug).toBe('ops-team');
      expect(store.listMembers(id)).toHaveLength(1);
    });

    it('does not authorize in the store from legacy member roles', () => {
      const store = makeStore();
      const ch = store.create({ slug: 'ops', creator: 'alice' });
      store.addMember({ channelId: ch.id, memberName: 'bob' });
      expect(() => store.rename(ch.id, 'ops-team', 'bob')).not.toThrow();
      expect(store.listAudit(ch.id).at(-1)).toMatchObject({ actor: 'bob', action: 'rename' });
    });

    it('refuses if new slug collides with another active channel', () => {
      const store = makeStore();
      const a = store.create({ slug: 'ops', creator: 'alice' });
      store.create({ slug: 'eng', creator: 'alice' });
      expect(() => store.rename(a.id, 'eng', 'alice')).toThrow(/already exists/);
    });

    it('no-op when newSlug equals current slug', () => {
      const store = makeStore();
      const ch = store.create({ slug: 'ops', creator: 'alice' });
      const same = store.rename(ch.id, 'ops', 'alice');
      expect(same.id).toBe(ch.id);
    });

    it('rolls the mutation back when its audit insert fails', () => {
      const db = openDatabase(':memory:');
      dbsToClose.push(db);
      const store = createSqliteChannelStore(db);
      const ch = store.create({ slug: 'ops', creator: 'alice' });
      db.exec('DROP TABLE channel_audit');
      expect(() => store.update(ch.id, { slug: 'operations' }, 'alice')).toThrow();
      expect(store.get(ch.id)?.slug).toBe('ops');
    });
  });

  it('migrates a pre-description channels table additively', () => {
    const db = openDatabase(':memory:');
    dbsToClose.push(db);
    db.exec(`CREATE TABLE channels (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, archived_at INTEGER
    )`);
    const store = createSqliteChannelStore(db);
    expect(store.get('general')?.description).toBe('');
  });

  describe('archive', () => {
    it('soft-archives a channel; it disappears from listAll but stays gettable by id', () => {
      const store = makeStore();
      const ch = store.create({ slug: 'ops', creator: 'alice' });
      store.archive(ch.id, 'alice');
      expect(store.listAll().some((c) => c.id === ch.id)).toBe(false);
      const fetched = store.get(ch.id);
      expect(fetched?.archivedAt).not.toBeNull();
    });

    it('records the actor independent of legacy member role', () => {
      const store = makeStore();
      const ch = store.create({ slug: 'ops', creator: 'alice' });
      store.addMember({ channelId: ch.id, memberName: 'bob' });
      expect(() => store.archive(ch.id, 'bob')).not.toThrow();
      expect(store.listAudit(ch.id).at(-1)).toMatchObject({ actor: 'bob', action: 'archive' });
    });
  });

  describe('membership', () => {
    it('adds and lists members; legacy roles remain observational', () => {
      const store = makeStore();
      const ch = store.create({ slug: 'ops', creator: 'alice', now: 1000 });
      store.addMember({ channelId: ch.id, memberName: 'bob', now: 1010 });
      store.addMember({ channelId: ch.id, memberName: 'carol', role: 'admin', now: 1020 });
      const members = store.listMembers(ch.id);
      expect(members.map((m) => m.memberName)).toEqual(['carol', 'alice', 'bob']);
      expect(members[0]?.role).toBe('admin');
      expect(members[1]?.role).toBe('member');
    });

    it('addMember is idempotent', () => {
      const store = makeStore();
      const ch = store.create({ slug: 'ops', creator: 'alice' });
      store.addMember({ channelId: ch.id, memberName: 'bob' });
      store.addMember({ channelId: ch.id, memberName: 'bob' });
      expect(store.listMembers(ch.id).filter((m) => m.memberName === 'bob')).toHaveLength(1);
    });

    it('removeMember pulls a member from the channel', () => {
      const store = makeStore();
      const ch = store.create({ slug: 'ops', creator: 'alice' });
      store.addMember({ channelId: ch.id, memberName: 'bob' });
      store.removeMember(ch.id, 'bob');
      expect(store.isMember(ch.id, 'bob')).toBe(false);
    });

    it('allows creator removal while other members remain', () => {
      const store = makeStore();
      const ch = store.create({ slug: 'ops', creator: 'alice' });
      store.addMember({ channelId: ch.id, memberName: 'bob' });
      expect(() => store.removeMember(ch.id, 'alice')).not.toThrow();
    });

    it('allows the last admin to leave when no members remain (channel empties out)', () => {
      const store = makeStore();
      const ch = store.create({ slug: 'ops', creator: 'alice' });
      // alice is the only member — leaving is allowed (channel orphans, but that's fine)
      expect(() => store.removeMember(ch.id, 'alice')).not.toThrow();
      expect(store.listMembers(ch.id)).toEqual([]);
    });

    it('listForMember returns general + joined channels', async () => {
      const store = makeStore();
      const ch = store.create({ slug: 'ops', creator: 'alice' });
      store.create({ slug: 'eng', creator: 'bob' });
      const aliceList = await store.listForMember('alice');
      expect(aliceList.map((c) => c.slug).sort()).toEqual(['general', 'ops']);
      expect(aliceList.find((c) => c.slug === 'eng')).toBeUndefined();
      expect(ch.archivedAt).toBeNull();
    });

    it('recipientNames returns explicit member set for non-general', () => {
      const store = makeStore();
      const ch = store.create({ slug: 'ops', creator: 'alice' });
      store.addMember({ channelId: ch.id, memberName: 'bob' });
      const names = store.recipientNames(ch.id);
      expect(names).not.toBeNull();
      expect((names as string[]).sort()).toEqual(['alice', 'bob']);
    });
  });

  describe('validateSlug', () => {
    it('exposes the same rules as create', () => {
      expect(() => validateSlug('ops')).not.toThrow();
      expect(() => validateSlug('Ops')).toThrow();
      expect(() => validateSlug('ops--team')).toThrow();
    });
  });
});
