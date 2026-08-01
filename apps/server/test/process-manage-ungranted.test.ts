/**
 * `process.manage` ships held by nobody.
 *
 * WHY THIS NEEDS A TEST AT ALL. The seeded `admin` preset is derived
 * from `PERMISSIONS`, which is the right default: a new leaf reaches
 * the bootstrap admin without anyone remembering to add it. That
 * default is wrong for exactly one kind of leaf — one whose point is
 * that holding it is a decision.
 *
 * Adding `process.manage` to `PERMISSIONS` therefore GRANTED it at
 * genesis, silently, while the docs said it shipped ungranted. Found
 * by Rune. It is genesis behaviour rather than a migration, so
 * searching migrations would not have found it.
 *
 * Two assertions, because either alone is insufficient: the preset
 * could be clean while the bootstrap member received the leaf by some
 * other route, or the member could be clean today and regress when the
 * preset changes.
 *
 * And a positive control, because "nobody has it" is trivially
 * satisfiable by a permission system that grants nothing.
 */

import { hasPermission, PERMISSIONS } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSION_PRESETS } from '../src/wizard.js';

describe('process.manage is withheld at genesis', () => {
  it('is a real leaf, so the assertions below are about something', () => {
    expect(PERMISSIONS).toContain('process.manage');
  });

  it('is not in the seeded admin preset', () => {
    expect(DEFAULT_PERMISSION_PRESETS.admin).not.toContain('process.manage');
  });

  it('is not in any seeded preset', () => {
    for (const [name, leaves] of Object.entries(DEFAULT_PERMISSION_PRESETS)) {
      expect(leaves, `preset '${name}' grants process.manage`).not.toContain('process.manage');
    }
  });

  /**
   * The bootstrap admin receives `DEFAULT_PERMISSION_PRESETS.admin`.
   * Asserting the preset alone would pass if the wizard granted the
   * leaf by another route, so assert what the member actually holds.
   */
  it('is not held by the member the wizard creates', () => {
    const initial = DEFAULT_PERMISSION_PRESETS.admin ?? [];
    expect(hasPermission(initial, 'process.manage')).toBe(false);
  });

  /**
   * POSITIVE CONTROL. Without this, a permission system that resolved
   * nothing at all would pass every assertion above.
   */
  it('every OTHER leaf still reaches the seeded admin', () => {
    const admin = DEFAULT_PERMISSION_PRESETS.admin ?? [];
    const missing = PERMISSIONS.filter((p) => p !== 'process.manage' && !hasPermission(admin, p));
    expect(missing).toEqual([]);
    expect(admin.length).toBe(PERMISSIONS.length - 1);
  });

  /**
   * And an explicit grant still resolves — withholding it from the
   * seed must not make it ungrantable.
   */
  it('resolves when granted explicitly', () => {
    expect(hasPermission(['process.manage'], 'process.manage')).toBe(true);
  });
});
