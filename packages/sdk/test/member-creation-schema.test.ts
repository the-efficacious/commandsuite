import { describe, expect, it } from 'vitest';
import { CreateMemberRequestSchema, CreateMemberResponseSchema } from '../src/schemas.js';

const member = {
  name: 'builder',
  role: { title: 'engineer', description: '' },
  permissions: [],
};

describe('member creation credential modes', () => {
  it('keeps omitted mode on the legacy bootstrap path', () => {
    const parsed = CreateMemberRequestSchema.parse({
      ...member,
      instructions: '',
    });
    expect(parsed.credentialMode).toBe('bootstrap');
  });

  it('parses the pending response without a credential field', () => {
    const parsed = CreateMemberResponseSchema.parse({
      credentialMode: 'pending',
      member,
      enrollment: {
        method: 'device_code',
        connectCommand: 'csuite connect',
        approveCommand: 'csuite connect approve',
      },
    });
    expect(parsed.credentialMode).toBe('pending');
    expect(parsed).not.toHaveProperty('token');
  });

  it('keeps the discriminated bootstrap response for 0.8 callers', () => {
    const parsed = CreateMemberResponseSchema.parse({
      credentialMode: 'bootstrap',
      member,
      token: 'not-a-real-credential',
    });
    expect(parsed).toMatchObject({ credentialMode: 'bootstrap', token: 'not-a-real-credential' });
  });
});
