/** The bootstrap member receives every leaf directly, with no named category. */

import { PERMISSIONS } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';

describe('bootstrap authority', () => {
  it('keeps the canonical vocabulary free of persona names', () => {
    expect(PERMISSIONS.some((leaf) => /director|admin|operator/i.test(leaf))).toBe(false);
  });
});
