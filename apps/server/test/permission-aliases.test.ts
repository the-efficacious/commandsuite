/**
 * The short-lived `objectives.manage` dialback remains readable while
 * the four independently meaningful leaves are canonical again.
 */

import { PermissionSchema, PermissionsSchema } from 'csuite-sdk/schemas';
import { LEGACY_PERMISSION_EXPANSIONS } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { MemberLoadError, resolvePermissions } from '../src/members.js';

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
