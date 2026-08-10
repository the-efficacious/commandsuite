import { describe, expect, it } from 'vitest';
import {
  ApproveEnrollmentRequestSchema,
  CreateMemberRequestSchema,
  InstructionsResponseSchema,
  MemberSchema,
  RoleSchema,
  TeamSchema,
  UpdateMemberRequestSchema,
} from '../src/schemas.js';
import { formatTextMetrics, measureText } from '../src/text-metrics.js';

const LONG = 'instruction text '.repeat(700);

describe('authored instruction fields have no length cap', () => {
  it('accepts oversized role descriptions at the shared role schema', () => {
    expect(RoleSchema.parse({ title: 'engineer', description: LONG }).description).toBe(LONG);
  });

  it('accepts oversized team context', () => {
    expect(TeamSchema.parse({ name: 'team', context: LONG }).context).toBe(LONG);
  });

  it('accepts oversized member instructions on stored and request shapes', () => {
    const role = { title: 'engineer', description: '' };
    expect(
      MemberSchema.parse({ name: 'member', role, permissions: [], instructions: LONG })
        .instructions,
    ).toBe(LONG);
    expect(
      CreateMemberRequestSchema.parse({
        name: 'member',
        role,
        permissions: [],
        instructions: LONG,
      }).instructions,
    ).toBe(LONG);
    expect(UpdateMemberRequestSchema.parse({ instructions: LONG }).instructions).toBe(LONG);
    const enrollment = ApproveEnrollmentRequestSchema.parse({
      mode: 'create',
      userCode: 'ABCD-EFGH',
      memberName: 'member',
      role,
      permissions: [],
      instructions: LONG,
    });
    expect(enrollment.mode).toBe('create');
    if (enrollment.mode === 'create') expect(enrollment.instructions).toBe(LONG);
  });

  it('parses composed instructions longer than the former authored-text cap', () => {
    const parsed = InstructionsResponseSchema.parse({
      name: 'member',
      role: { title: 'engineer', description: '' },
      permissions: [],
      instructions: LONG,
      team: { name: 'team', context: '', permissionPresets: {} },
      teammates: [],
      toolSources: [],
    });
    expect(parsed.instructions.length).toBeGreaterThan(8_192);
  });
});

describe('instruction text estimates', () => {
  it('counts Unicode code points and labels the estimate and method', () => {
    expect(measureText('abc😀')).toEqual({ characters: 4, estimatedTokens: 1 });
    expect(formatTextMetrics('12345')).toBe('5 characters · ≈2 estimated tokens (characters ÷ 4)');
  });
});
