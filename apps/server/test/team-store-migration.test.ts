/**
 * Legacy-DB migration: databases created before the directive field
 * was retired carry a `directive` column on the `team` table. Opening
 * a `TeamStore` against one must fold the directive into the head of
 * `context` and drop the column, so no deployed team loses its
 * standing prose when upgrading.
 */

import { describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';
import { openTeamAndMembers } from '../src/team-store.js';

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
