/**
 * Legacy permission keys keep loading.
 *
 * The four `objectives.*` leaves collapsed into `objectives.manage`.
 * Team configs and stored presets written under the old vocabulary
 * exist in the field (every pre-consolidation deployment), and a
 * loader that rejects them turns an upgrade into a boot failure. The
 * alias map is the back-compat mechanism; these prove it holds at
 * both resolution sites — direct leaf entries and preset leaves —
 * and at the schema layer that validates permission arrays.
 */

import { PermissionSchema } from 'csuite-sdk/schemas';
import { LEGACY_PERMISSION_ALIASES } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { MemberLoadError, resolvePermissions } from '../src/members.js';

const LEGACY = [
  'objectives.create',
  'objectives.cancel',
  'objectives.reassign',
  'objectives.watch',
];

describe('legacy permission keys resolve to objectives.manage', () => {
  it('maps every retired leaf given directly on a member', () => {
    for (const key of LEGACY) {
      expect(resolvePermissions([key], {}, 'member test')).toEqual(['objectives.manage']);
    }
  });

  it('maps retired leaves inside a stored preset', () => {
    const presets = {
      // Written before the consolidation, as `Permission[]` claimed at
      // the type level but legacy on disk.
      operator: LEGACY as never,
    };
    expect(resolvePermissions(['operator'], presets, 'preset test')).toEqual(['objectives.manage']);
  });

  it('deduplicates when legacy and modern keys are mixed', () => {
    expect(
      resolvePermissions(['objectives.create', 'objectives.manage', 'activity.read'], {}, 'mix'),
    ).toEqual(['objectives.manage', 'activity.read']);
  });

  // Positive control — the modern vocabulary still resolves, so the
  // alias path cannot have swallowed normal resolution.
  it('passes a modern leaf through untouched', () => {
    expect(resolvePermissions(['objectives.manage'], {}, 'modern')).toEqual(['objectives.manage']);
  });

  // Negative control — aliasing must not have made the loader accept
  // arbitrary unknown names.
  it('still rejects an unknown name', () => {
    expect(() => resolvePermissions(['objectives.destroy'], {}, 'unknown')).toThrow(
      MemberLoadError,
    );
  });
});

describe('the schema layer maps legacy keys before validating', () => {
  it('parses each retired key to its modern leaf', () => {
    for (const [legacy, modern] of Object.entries(LEGACY_PERMISSION_ALIASES)) {
      expect(PermissionSchema.parse(legacy)).toBe(modern);
    }
  });

  it('parses a modern leaf as itself', () => {
    expect(PermissionSchema.parse('objectives.manage')).toBe('objectives.manage');
  });

  it('still rejects an unknown key', () => {
    expect(() => PermissionSchema.parse('objectives.destroy')).toThrow();
  });
});
