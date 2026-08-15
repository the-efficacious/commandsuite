import { PERMISSIONS } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import {
  MEMBER_CREATION_PERMISSION_TEMPLATES,
  PERMISSION_META,
  privilegeTag,
  sortLeaves,
  summarizePermissions,
} from '../src/lib/permissions.js';

describe('summarizePermissions', () => {
  it('labels empty permissions as baseline', () => {
    expect(summarizePermissions([])).toEqual({ kind: 'baseline', label: 'baseline', count: 0 });
  });

  it('describes authority by leaf count without inventing a category', () => {
    expect(summarizePermissions(['activity.read'])).toEqual({
      kind: 'custom',
      label: '1 permission',
      count: 1,
    });
    expect(summarizePermissions(['activity.read', 'tools.manage'])).toEqual({
      kind: 'custom',
      label: '2 permissions',
      count: 2,
    });
  });
});

describe('privilegeTag', () => {
  it('uses the explicit leaf count', () => {
    expect(privilegeTag(summarizePermissions(['activity.read', 'tools.manage']))).toBe('2');
  });

  it('returns null for baseline', () => {
    expect(privilegeTag(summarizePermissions([]))).toBeNull();
  });
});

describe('member-creation templates', () => {
  it('makes full access an exact copy of every canonical leaf', () => {
    expect(MEMBER_CREATION_PERMISSION_TEMPLATES[0]?.label).toBe('Full access');
    expect(MEMBER_CREATION_PERMISSION_TEMPLATES[0]?.permissions).toEqual(PERMISSIONS);
  });

  it('keeps objective coordination split into purpose-specific leaves', () => {
    expect(MEMBER_CREATION_PERMISSION_TEMPLATES[1]).toEqual({
      label: 'Coordinate objectives',
      permissions: [
        'objectives.create',
        'objectives.cancel',
        'objectives.reassign',
        'objectives.watch',
      ],
    });
  });
});

describe('sortLeaves', () => {
  it('emits leaves in canonical order regardless of input order', () => {
    expect(sortLeaves(['activity.read', 'objectives.watch', 'team.manage'])).toEqual([
      'team.manage',
      'objectives.watch',
      'activity.read',
    ]);
  });
});

describe('PERMISSION_META parity with the server vocabulary', () => {
  it('carries an entry for every leaf in PERMISSIONS', () => {
    const covered = new Set(PERMISSION_META.map((m) => m.key));
    expect(PERMISSIONS.filter((p) => !covered.has(p))).toEqual([]);
  });

  it('carries no entry the server vocabulary does not know', () => {
    const known = new Set<string>(PERMISSIONS);
    expect(PERMISSION_META.filter((m) => !known.has(m.key)).map((m) => m.key)).toEqual([]);
  });

  it('lists no leaf twice', () => {
    const keys = PERMISSION_META.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
