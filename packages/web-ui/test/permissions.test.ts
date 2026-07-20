import type { Permission, PermissionPresets } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import {
  findExactPreset,
  matchesPreset,
  privilegeTag,
  sortLeaves,
  summarizePermissions,
} from '../src/lib/permissions.js';

const ADMIN: Permission[] = [
  'team.manage',
  'members.manage',
  'objectives.create',
  'objectives.cancel',
  'objectives.reassign',
  'objectives.watch',
  'activity.read',
];

const OPERATOR: Permission[] = ['objectives.create', 'objectives.cancel'];

const PRESETS: PermissionPresets = {
  admin: ADMIN,
  operator: OPERATOR,
};

describe('matchesPreset', () => {
  it('returns true for same leaves in any order', () => {
    expect(matchesPreset(['objectives.create', 'objectives.cancel'], OPERATOR)).toBe(true);
    expect(matchesPreset(['objectives.cancel', 'objectives.create'], OPERATOR)).toBe(true);
  });
  it('returns false when the leaves differ', () => {
    expect(matchesPreset(['objectives.create'], OPERATOR)).toBe(false);
    expect(matchesPreset(['objectives.create', 'activity.read'], OPERATOR)).toBe(false);
  });
});

describe('findExactPreset', () => {
  it('returns the preset name for an exact match', () => {
    expect(findExactPreset(['objectives.create', 'objectives.cancel'], PRESETS)).toBe('operator');
  });
  it('returns null when no preset matches', () => {
    expect(findExactPreset(['activity.read'], PRESETS)).toBeNull();
    expect(findExactPreset([], PRESETS)).toBeNull();
  });
});

describe('summarizePermissions', () => {
  it('baseline for empty permissions', () => {
    const s = summarizePermissions([], PRESETS);
    expect(s.kind).toBe('baseline');
    expect(s.label).toBe('baseline');
    expect(s.isAdmin).toBe(false);
  });

  it('preset match produces the preset label', () => {
    const s = summarizePermissions(['objectives.create', 'objectives.cancel'], PRESETS);
    expect(s.kind).toBe('preset');
    expect(s.label).toBe('operator');
    expect(s.isAdmin).toBe(false);
  });

  it('flags isAdmin when members.manage is present', () => {
    const s = summarizePermissions(ADMIN, PRESETS);
    expect(s.isAdmin).toBe(true);
    expect(s.label).toBe('admin');
  });

  it('labels custom mixes with the leaf count', () => {
    const s = summarizePermissions(['activity.read'], PRESETS);
    expect(s.kind).toBe('custom');
    expect(s.label).toBe('custom (1)');
    expect(s.isAdmin).toBe(false);
    expect(s.count).toBe(1);
  });
});

describe('privilegeTag', () => {
  it('returns "A" for admin', () => {
    const s = summarizePermissions(ADMIN, PRESETS);
    expect(privilegeTag(s)).toBe('A');
  });
  it('returns the preset prefix for non-admin presets', () => {
    const s = summarizePermissions(OPERATOR, PRESETS);
    expect(privilegeTag(s)).toBe('OP');
  });
  it('returns "C" for a non-admin custom mix', () => {
    const s = summarizePermissions(['activity.read', 'objectives.watch'], PRESETS);
    expect(privilegeTag(s)).toBe('C');
  });
  it('returns null for baseline', () => {
    const s = summarizePermissions([], PRESETS);
    expect(privilegeTag(s)).toBeNull();
  });
});

describe('sortLeaves', () => {
  it('emits leaves in the canonical PERMISSIONS order regardless of input order', () => {
    expect(sortLeaves(['activity.read', 'team.manage', 'objectives.create'])).toEqual([
      'team.manage',
      'objectives.create',
      'activity.read',
    ]);
  });
});
