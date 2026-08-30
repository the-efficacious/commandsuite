/**
 * Legacy-DB migration: databases created before the directive field
 * was retired carry a `directive` column on the `team` table. Opening
 * a `TeamStore` against one must fold the directive into the head of
 * `context` and drop the column, so no deployed team loses its
 * standing prose when upgrading.
 */

import { openTeamAndMembers } from 'csuite-core';
import { describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';

const LEGACY_SCHEMA = `
  CREATE TABLE team (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    name        TEXT NOT NULL,
    directive   TEXT NOT NULL,
    context     TEXT NOT NULL DEFAULT '',
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
  );
`;

function legacyDb(row: { name: string; directive: string; context: string }): DatabaseSyncInstance {
  const db = openDatabase(':memory:');
  db.exec(LEGACY_SCHEMA);
  db.prepare(
    'INSERT INTO team (id, name, directive, context, updated_at, updated_by) VALUES (1, ?, ?, ?, 0, NULL)',
  ).run(row.name, row.directive, row.context);
  return db;
}

function teamColumns(db: DatabaseSyncInstance): string[] {
  const rows = db.prepare('PRAGMA table_info(team)').all() as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function legacyMembersDb(): DatabaseSyncInstance {
  const db = openDatabase(':memory:');
  db.exec(`
    CREATE TABLE team (
      id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, updated_by TEXT
    );
    CREATE TABLE permission_presets (
      name TEXT PRIMARY KEY, permissions TEXT NOT NULL,
      updated_at INTEGER NOT NULL, updated_by TEXT
    );
    CREATE TABLE members (
      name TEXT PRIMARY KEY, role_title TEXT NOT NULL,
      role_description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
      raw_permissions TEXT NOT NULL, totp_secret TEXT, totp_last_counter INTEGER NOT NULL DEFAULT 0,
      insertion_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO members VALUES
      ('legacy', 'engineer', '', '', '[]', NULL, 0, 0, 1, 1),
      ('second', 'reviewer', '', '', '[]', NULL, 0, 1, 1, 1);
  `);
  return db;
}

describe('team-store directive → context migration', () => {
  it('folds a legacy directive into the head of context and drops the column', () => {
    const db = legacyDb({
      name: 'legacy-team',
      directive: 'Ship the payment service.',
      context: 'We own the full lifecycle.',
    });
    const { team } = openTeamAndMembers(db);
    expect(team.getTeam().context).toBe('Ship the payment service.\n\nWe own the full lifecycle.');
    expect(teamColumns(db)).not.toContain('directive');
    db.close();
  });

  it('uses the directive alone when the legacy context is empty', () => {
    const db = legacyDb({ name: 'legacy-team', directive: 'Ship it.', context: '' });
    const { team } = openTeamAndMembers(db);
    expect(team.getTeam().context).toBe('Ship it.');
    db.close();
  });

  it('leaves context untouched when the legacy directive is empty', () => {
    const db = legacyDb({ name: 'legacy-team', directive: '', context: 'Background only.' });
    const { team } = openTeamAndMembers(db);
    expect(team.getTeam().context).toBe('Background only.');
    expect(teamColumns(db)).not.toContain('directive');
    db.close();
  });

  it('is a no-op on a fresh database and survives repeated opens', () => {
    const db = openDatabase(':memory:');
    const first = openTeamAndMembers(db);
    first.team.setTeam({ name: 'fresh-team', context: 'ctx' });
    // Re-open the stores on the same handle — must not throw or mutate.
    const second = openTeamAndMembers(db);
    expect(second.team.getTeam()).toMatchObject({ name: 'fresh-team', context: 'ctx' });
    expect(teamColumns(db)).not.toContain('directive');
    db.close();
  });
});

describe('member stable-identity migration', () => {
  it('backfills distinct UUIDs in a pre-migration database and preserves them across reopen', () => {
    const db = legacyMembersDb();
    const first = openTeamAndMembers(db).members.members();
    expect(first.map((member) => member.identityId)).toHaveLength(2);
    expect(first[0]?.identityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first[1]?.identityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first[0]?.identityId).not.toBe(first[1]?.identityId);

    const reopened = openTeamAndMembers(db).members.members();
    expect(reopened.map((member) => member.identityId)).toEqual(
      first.map((member) => member.identityId),
    );
    expect(
      (db.prepare('PRAGMA index_list(members)').all() as unknown as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ).toContain('members_identity_id_idx');
    db.close();
  });

  it('backfills active lifecycle state and retains a departed identity under its reserved name', () => {
    const db = legacyMembersDb();
    const members = openTeamAndMembers(db, { now: () => 1234 }).members;
    expect(members.members().map((member) => member.state)).toEqual(['active', 'active']);

    const departed = members.departMember('legacy', 'second');
    expect(departed).toMatchObject({
      name: 'legacy',
      state: 'departed',
      departedAt: 1234,
      departedBy: 'second',
    });
    expect(members.findByName('legacy')).toBeNull();
    expect(members.findAnyByName('legacy')?.identityId).toBe(departed.identityId);
    expect(members.members().map((member) => member.name)).toEqual(['second']);
    expect(members.allMembers().map((member) => member.name)).toEqual(['legacy', 'second']);
    expect(() =>
      members.addMember({
        name: 'legacy',
        role: { title: 'new', description: '' },
        instructions: '',
        rawPermissions: [],
        permissions: [],
      }),
    ).toThrow("duplicate name 'legacy'");
    db.close();
  });
});
