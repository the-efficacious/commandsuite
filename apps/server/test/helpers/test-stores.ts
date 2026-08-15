/**
 * Test fixture: open an in-memory DB, seed the team + members + tokens
 * so a test can call `createApp` with the new `teamStore`/`members`
 * surface. Mirrors what the wizard + index.ts do at boot, just compact
 * enough to fit in a test setup function.
 */

import type { TeamStore } from 'csuite-core';
import { openTeamAndMembers, SqliteTokenStore, type TokenStore } from 'csuite-core';
import type { Permission, PermissionPresets, Role, Team } from 'csuite-sdk/types';
import { type DatabaseSyncInstance, openDatabase } from '../../src/db.js';
import type { MemberStore } from '../../src/members.js';

/**
 * Lightweight `TeamStore` stand-in for tests that exercise `createApp`
 * without going through the full DB seed path. Implements the read
 * surface (`getTeam`, `getPresets`, `hasTeam`) plus minimal mutation
 * methods that update the in-memory team object so the new team API
 * handlers can be exercised without a database. Tests that do go
 * through `seedStores` should prefer the real DB-backed store.
 */
export function mockTeamStore(team: Team): TeamStore {
  let current: Team = { name: team.name, context: team.context };
  let legacyPresets: PermissionPresets = { ...(team.permissionPresets ?? {}) };
  const snapshot = (): Team => ({ ...current });
  const store: Partial<TeamStore> = {
    getTeam: snapshot,
    hasTeam: () => true,
    getPresets: () => ({ ...legacyPresets }),
    setTeam: (input) => {
      current = {
        ...current,
        name: input.name,
        context: input.context,
      };
      return snapshot();
    },
    updateTeam: (patch) => {
      current = {
        ...current,
        name: patch.name ?? current.name,
        context: patch.context ?? current.context,
      };
      return snapshot();
    },
    setPreset: (name, leaves) => {
      legacyPresets = { ...legacyPresets, [name]: [...leaves] };
    },
    deletePreset: (name) => {
      if (!(name in legacyPresets)) return false;
      const next: PermissionPresets = { ...legacyPresets };
      delete next[name];
      legacyPresets = next;
      return true;
    },
    membersReferencingPreset: (name, members) => {
      const out: string[] = [];
      for (const m of members.members()) {
        if (m.rawPermissions.includes(name)) out.push(m.name);
      }
      return out;
    },
  };
  return store as TeamStore;
}

export interface SeedMember {
  name: string;
  role: Role;
  instructions?: string;
  rawPermissions?: string[];
  permissions?: Permission[];
  /** Plaintext bearer token. Inserted into the tokens table with origin='bootstrap'. */
  token: string;
  totpSecret?: string | null;
}

export interface SeededStores {
  db: DatabaseSyncInstance;
  members: MemberStore;
  teamStore: TeamStore;
  tokens: TokenStore;
}

export interface SeedTeamInput {
  name: string;
  context?: string;
  permissionPresets?: Record<string, Permission[]>;
}

export async function seedStores(input: {
  team: SeedTeamInput;
  members: SeedMember[];
}): Promise<SeededStores> {
  const db = openDatabase(':memory:');
  const stores = openTeamAndMembers(db);
  stores.team.setTeam({
    name: input.team.name,
    context: input.team.context ?? '',
  });
  for (const [name, leaves] of Object.entries(input.team.permissionPresets ?? {})) {
    stores.team.setPreset(name, leaves);
  }
  const tokens = new SqliteTokenStore(db);
  for (const m of input.members) {
    stores.members.addMember({
      name: m.name,
      role: m.role,
      instructions: m.instructions ?? '',
      rawPermissions: m.rawPermissions ?? (m.permissions as string[] | undefined) ?? [],
      permissions: m.permissions ?? [],
      totpSecret: m.totpSecret ?? null,
    });
    await tokens.insert({
      memberName: m.name,
      rawToken: m.token,
      label: 'test',
      origin: 'bootstrap',
      createdBy: null,
    });
  }
  return { db, members: stores.members, teamStore: stores.team, tokens };
}
