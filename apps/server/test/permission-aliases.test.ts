/**
 * The short-lived `objectives.manage` dialback remains readable while
 * the four independently meaningful leaves are canonical again — and
 * the `process.manage` → `team_process.manage` rename rides the same
 * table, so a row stored under the old name keeps the capability
 * without ever being rewritten.
 */

import { createSqliteMemberStore, TeamStore } from 'csuite-core';
import { PermissionSchema, PermissionsSchema } from 'csuite-sdk/schemas';
import { LEGACY_PERMISSION_EXPANSIONS } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore, MemberLoadError, resolvePermissions } from '../src/members.js';

const OBJECTIVE_LEAVES = [
  'objectives.create',
  'objectives.cancel',
  'objectives.reassign',
  'objectives.watch',
] as const;

describe('legacy objectives.manage compatibility', () => {
  it('expands the retired aggregate given directly on a member', () => {
    expect(resolvePermissions(['objectives.manage'], {}, 'member test')).toEqual(OBJECTIVE_LEAVES);
  });

  it('expands the retired aggregate inside a stored bundle', () => {
    const bundles = { oldCoordinator: ['objectives.manage'] as never };
    expect(resolvePermissions(['oldCoordinator'], bundles, 'bundle test')).toEqual(
      OBJECTIVE_LEAVES,
    );
  });

  it('deduplicates aggregate and canonical leaves', () => {
    expect(
      resolvePermissions(['objectives.create', 'objectives.manage', 'activity.read'], {}, 'mix'),
    ).toEqual([...OBJECTIVE_LEAVES, 'activity.read']);
  });

  it('keeps every objective leaf independently grantable', () => {
    for (const leaf of OBJECTIVE_LEAVES) {
      expect(resolvePermissions([leaf], {}, 'canonical')).toEqual([leaf]);
      expect(PermissionSchema.parse(leaf)).toBe(leaf);
    }
  });

  it('still rejects an unknown name', () => {
    expect(() => resolvePermissions(['objectives.destroy'], {}, 'unknown')).toThrow(
      MemberLoadError,
    );
  });
});

describe('schema compatibility', () => {
  it('keeps one-leaf parsing strict', () => {
    expect(() => PermissionSchema.parse('objectives.manage')).toThrow();
  });

  it('expands the aggregate when parsing a list', () => {
    expect(PermissionsSchema.parse(['objectives.manage'])).toEqual(OBJECTIVE_LEAVES);
    expect(LEGACY_PERMISSION_EXPANSIONS['objectives.manage']).toEqual(OBJECTIVE_LEAVES);
  });

  it('still rejects an unknown key', () => {
    expect(() => PermissionsSchema.parse(['objectives.destroy'])).toThrow();
  });
});

// ─── process.manage → team_process.manage ────────────────────────────

/**
 * A rename with ZERO data migration. `raw_permissions` is stored
 * verbatim and resolved on every read, so the old name is mapped at
 * resolution rather than rewritten on disk. That leaves two routes a
 * stored name can take — directly on the member, or as a leaf inside
 * a stored preset — and both are driven below, first through the pure
 * resolver and then through the real SQLite store with rows written
 * the way a pre-rename broker wrote them.
 */
describe('legacy process.manage compatibility', () => {
  it('resolves the old name given directly on a member', () => {
    expect(resolvePermissions(['process.manage'], {}, 'member test')).toEqual([
      'team_process.manage',
    ]);
  });

  it('resolves the old name stored as a leaf inside a preset', () => {
    const bundles = { oldLead: ['process.manage'] as never };
    expect(resolvePermissions(['oldLead'], bundles, 'bundle test')).toEqual([
      'team_process.manage',
    ]);
  });

  it('deduplicates the old and new names held together', () => {
    expect(
      resolvePermissions(['process.manage', 'team_process.manage', 'activity.read'], {}, 'mix'),
    ).toEqual(['activity.read', 'team_process.manage']);
  });

  it('keeps the new name independently grantable', () => {
    expect(resolvePermissions(['team_process.manage'], {}, 'canonical')).toEqual([
      'team_process.manage',
    ]);
    expect(PermissionSchema.parse('team_process.manage')).toBe('team_process.manage');
  });

  it('expands the old name when parsing a list, and rejects it as a single leaf', () => {
    expect(PermissionsSchema.parse(['process.manage'])).toEqual(['team_process.manage']);
    expect(LEGACY_PERMISSION_EXPANSIONS['process.manage']).toEqual(['team_process.manage']);
    expect(() => PermissionSchema.parse('process.manage')).toThrow();
  });

  it('a member row stored under the old name resolves the capability, row untouched', () => {
    const db = openDatabase(':memory:');
    const team = new TeamStore(db);
    const members = createSqliteMemberStore(db, team);
    // Rows as a pre-rename broker left them: the old leaf directly on
    // one member, and inside a stored preset another member references.
    db.prepare(
      `INSERT INTO permission_presets (name, permissions, updated_at, updated_by)
       VALUES ('old-lead', '["process.manage","activity.read"]', 0, NULL)`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO members
         (identity_id, name, role_title, role_description, instructions, raw_permissions,
          totp_secret, totp_last_counter, insertion_order, created_at, updated_at)
       VALUES (?, ?, 'lead', '', '', ?, NULL, 0, ?, 0, 0)`,
    );
    insert.run(crypto.randomUUID(), 'direct', '["process.manage"]', 0);
    insert.run(crypto.randomUUID(), 'via-preset', '["old-lead"]', 1);

    expect(members.findByName('direct')?.permissions).toEqual(['team_process.manage']);
    expect(members.findByName('via-preset')?.permissions).toEqual([
      'activity.read',
      'team_process.manage',
    ]);
    // The stored bytes are what they were: no migration ran.
    expect(members.findByName('direct')?.rawPermissions).toEqual(['process.manage']);
    expect(db.prepare("SELECT raw_permissions FROM members WHERE name = 'direct'").get()).toEqual({
      raw_permissions: '["process.manage"]',
    });
    expect(
      db.prepare("SELECT permissions FROM permission_presets WHERE name = 'old-lead'").get(),
    ).toEqual({ permissions: '["process.manage","activity.read"]' });
  });

  it('accepts the old name on a new write and resolves it to the new leaf', () => {
    const db = openDatabase(':memory:');
    const members = createSqliteMemberStore(db, new TeamStore(db));
    const added = members.addMember({
      name: 'late-writer',
      role: { title: 'lead', description: '' },
      instructions: '',
      rawPermissions: ['process.manage'],
    });
    expect(added.permissions).toEqual(['team_process.manage']);
    expect(members.findByName('late-writer')?.permissions).toEqual(['team_process.manage']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Both stores derive `permissions`; neither takes one from the caller.
//
// `AddMemberInput` used to carry a resolved `permissions` array that
// the DB-backed store discarded and the in-memory store stored
// verbatim, so one input produced two different members. The field is
// gone: `rawPermissions` is the only authority input. Each assertion
// below compares the WHOLE resolved list in canonical leaf order, so a
// store that resolved only the direct leaf, or only the alias, or that
// dropped canonical ordering, fails.
// ─────────────────────────────────────────────────────────────────────

const PARITY_RAW = ['activity.read', 'process.manage', 'objectives.manage'];
const PARITY_RESOLVED = [
  'objectives.create',
  'objectives.cancel',
  'objectives.reassign',
  'objectives.watch',
  'activity.read',
  'team_process.manage',
];

function seededMapStore(): ReturnType<typeof createMemberStore> {
  return createMemberStore([
    {
      name: 'seed',
      role: { title: 'lead', description: '' },
      permissions: [],
      token: 'csuite_parity_seed',
    },
  ]);
}

describe('both member stores derive permissions from rawPermissions', () => {
  it('resolves the whole list in canonical order in the in-memory store', () => {
    const store = seededMapStore();
    const added = store.addMember({
      name: 'derived',
      role: { title: 'engineer', description: '' },
      instructions: '',
      rawPermissions: PARITY_RAW,
      token: 'csuite_parity_derived',
    });
    expect(added.permissions).toEqual(PARITY_RESOLVED);
    expect(store.findByName('derived')?.permissions).toEqual(PARITY_RESOLVED);
    // The raw list is still round-tripped verbatim.
    expect(store.findByName('derived')?.rawPermissions).toEqual(PARITY_RAW);
  });

  it('resolves the same whole list in the DB-backed store', () => {
    const db = openDatabase(':memory:');
    const members = createSqliteMemberStore(db, new TeamStore(db));
    const added = members.addMember({
      name: 'derived',
      role: { title: 'engineer', description: '' },
      instructions: '',
      rawPermissions: PARITY_RAW,
    });
    expect(added.permissions).toEqual(PARITY_RESOLVED);
    expect(members.findByName('derived')?.permissions).toEqual(PARITY_RESOLVED);
  });

  it('refuses a name the in-memory store cannot resolve, storing nothing', () => {
    const store = seededMapStore();
    expect(() =>
      store.addMember({
        name: 'rejected',
        role: { title: 'engineer', description: '' },
        instructions: '',
        rawPermissions: ['activity.read', 'no-such-preset'],
        token: 'csuite_parity_rejected',
      }),
    ).toThrow(MemberLoadError);
    expect(store.findByName('rejected')).toBeNull();
    expect(store.names()).toEqual(['seed']);
  });

  it('has no caller-supplied permissions field left to trust', () => {
    const store = seededMapStore();
    const added = store.addMember({
      name: 'ignored',
      role: { title: 'engineer', description: '' },
      instructions: '',
      rawPermissions: ['activity.read'],
      // @ts-expect-error permissions is derived from rawPermissions, not supplied
      permissions: ['members.manage'],
      token: 'csuite_parity_ignored',
    });
    expect(added.permissions).toEqual(['activity.read']);
  });
});
