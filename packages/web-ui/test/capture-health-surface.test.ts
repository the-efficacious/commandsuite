/**
 * The human half of the capture-health surface.
 *
 * The original work item's outcome said the state must be visible "on
 * the surface an agent already reads AND on the human view." Shipping the
 * roster field alone satisfied the agent plane only — caught in
 * verification, because `rg captureHealth packages/web-ui` found
 * nothing. The human plane is the one that would have shown the gap to
 * a person without anyone running a query, which is the entire point.
 *
 * `presenceCaptureWarning` is the single place the shell decides how to
 * read the field, mirroring `presenceActivity`. These tests are on that
 * function because the two absence rules are OPPOSITE and a reader who
 * copies the activity idiom will get this wrong:
 *
 *     activity        absent → idle       a safe default
 *     captureHealth   absent → NO OPINION never "healthy"
 */

import type { Presence } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { presenceCaptureWarning } from '../src/lib/roster.js';

function presence(captureHealth?: Presence['captureHealth']): Presence {
  return {
    name: 'turner',
    connected: 1,
    createdAt: 0,
    lastSeen: 0,
    role: null,
    ...(captureHealth !== undefined ? { captureHealth } : {}),
  };
}

describe('presenceCaptureWarning', () => {
  it('warns for a member in a definitive gap', () => {
    expect(presenceCaptureWarning(presence('gap'))).toBe('gap');
  });

  it('reports unevaluated distinctly — it is not a gap and not health', () => {
    // Collapsing this into either neighbour loses the distinction the
    // whole signal exists to carry.
    expect(presenceCaptureWarning(presence('unevaluated'))).toBe('unevaluated');
  });

  it('stays quiet for a healthy member', () => {
    expect(presenceCaptureWarning(presence('ok'))).toBeNull();
  });

  it('stays quiet when the broker has no opinion, without claiming health', () => {
    // An older broker omits the field. The UI must render nothing —
    // NOT a healthy badge, which would be this surface asserting a
    // property no broker evaluated.
    expect(presenceCaptureWarning(presence(undefined))).toBeNull();
  });

  it('stays quiet for a member with no presence entry at all', () => {
    expect(presenceCaptureWarning(undefined)).toBeNull();
  });

  it('does not read the activity field by mistake', () => {
    // The two live side by side on Presence and have opposite absence
    // rules. A `working` member with no capture opinion must produce no
    // capture warning.
    const p: Presence = { ...presence(undefined), activity: 'working', busy: true };
    expect(presenceCaptureWarning(p)).toBeNull();
  });

  it('a gap is reported regardless of activity or connection state', () => {
    // The failure that prompted this was a member who looked online and
    // busy the entire time. If the warning were gated on idleness or
    // disconnection it would never have fired for them.
    const p: Presence = { ...presence('gap'), activity: 'working', busy: true, connected: 3 };
    expect(presenceCaptureWarning(p)).toBe('gap');
  });
});
