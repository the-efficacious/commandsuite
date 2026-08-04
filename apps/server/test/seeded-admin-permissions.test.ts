/**
 * The seeded `admin` preset grants every leaf — including
 * `process.manage`.
 *
 * The preset is derived from `PERMISSIONS` so a new leaf reaches the
 * bootstrap admin without anyone remembering to add it. From its
 * introduction (#130) until 2026-08-03 `process.manage` was the one
 * deliberate exception — held by nobody, granted only on purpose.
 * Andrew reversed that: a leaf nobody holds made the process document
 * invisible on every fresh install, and the control was judged not
 * worth the discoverability loss. This file replaces the test that
 * pinned the withholding (`process-manage-ungranted.test.ts`) and pins
 * the reversal: derivation is COMPLETE.
 *
 * Completeness is asserted leaf-by-leaf rather than as a count so a
 * failure names the missing leaf.
 */

import { PERMISSIONS } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSION_PRESETS } from '../src/wizard.js';

describe('the seeded admin preset', () => {
  it('grants every leaf, process.manage included', () => {
    const admin = DEFAULT_PERMISSION_PRESETS.admin ?? [];
    const missing = PERMISSIONS.filter((p) => !admin.includes(p));
    expect(missing).toEqual([]);
  });

  /**
   * The other direction: complete must not mean "and then some". A
   * preset carrying a leaf the server vocabulary does not know would
   * pass the assertion above.
   */
  it('grants nothing outside the server vocabulary', () => {
    const admin = DEFAULT_PERMISSION_PRESETS.admin ?? [];
    const known = new Set<string>(PERMISSIONS);
    expect(admin.filter((p) => !known.has(p))).toEqual([]);
  });

  /**
   * Deriving admin completely must not widen the OTHER seeded preset.
   * `operator` is a scoped hand-picked list, not a derivation, and in
   * particular must not pick up `process.manage` by accident.
   */
  it('leaves the operator preset scoped', () => {
    expect(DEFAULT_PERMISSION_PRESETS.operator).toEqual([
      'objectives.create',
      'objectives.cancel',
      'objectives.reassign',
    ]);
  });
});
