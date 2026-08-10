/**
 * The instructions response schema: new fields parse, and the parser
 * stays non-strict.
 *
 * Non-strict matters for FORWARD compatibility: a broker newer than
 * the client will add fields, and a client whose schema rejects
 * unknown keys turns every additive broker release into a client
 * outage. What this file pins is that the schema keeps that property
 * — a future refactor must not quietly reach for `.strict()`.
 */

import { InstructionsResponseSchema } from 'csuite-sdk/schemas';
import { describe, expect, it } from 'vitest';

const BASE = {
  name: 'cora',
  role: { title: 'engineer', description: '' },
  permissions: [],
  instructions: 'Sign your own work.',
  team: { name: 'demo-team', context: 'ctx', permissionPresets: {} },
  teammates: [],
  processDocument: null,
};

const SHA = 'a'.repeat(64);

describe('InstructionsResponseSchema', () => {
  it('parses block descriptors and the composed hash', () => {
    const parsed = InstructionsResponseSchema.parse({
      ...BASE,
      blocks: [{ kind: 'team_context', sha256: SHA }],
      composedSha256: SHA,
    });
    expect(parsed.blocks).toEqual([{ kind: 'team_context', sha256: SHA }]);
    expect(parsed.composedSha256).toBe(SHA);
  });

  it('parses a response from a broker that predates the block model', () => {
    const parsed = InstructionsResponseSchema.parse(BASE);
    // Absent, not defaulted: an older broker has no opinion, and
    // inventing an empty block list would claim one.
    expect(parsed.blocks).toBeUndefined();
    expect(parsed.composedSha256).toBeUndefined();
  });

  it('rejects a descriptor whose hash is not a sha256', () => {
    const result = InstructionsResponseSchema.safeParse({
      ...BASE,
      blocks: [{ kind: 'team_context', sha256: 'not-a-hash' }],
    });
    expect(result.success).toBe(false);
  });

  it('stays non-strict, so a superset response from a newer broker parses', () => {
    const parsed = InstructionsResponseSchema.parse({
      ...BASE,
      composedSha256: SHA,
      someFieldFromAFutureBroker: true,
    });
    // Unknown keys strip rather than reject — the property forward
    // compatibility rests on.
    expect('someFieldFromAFutureBroker' in parsed).toBe(false);
    expect(parsed.name).toBe('cora');
  });
});
