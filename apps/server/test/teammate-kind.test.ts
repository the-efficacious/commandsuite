/**
 * `Teammate.kind` derivation — the roster's person/agent signal.
 *
 * The auth plane is the only distinction the server has: humans enroll
 * TOTP for the web UI, agents authenticate by bearer token alone. A
 * member without TOTP gets NO `kind` field (omitted, not `'agent'`
 * asserted) so the UI renders the neutral treatment for genuinely
 * unknown cases and older-client JSON stays byte-compatible.
 */

import { describe, expect, it } from 'vitest';
import { createMemberStore, teammatesFromMembers } from '../src/members.js';

const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

describe('teammatesFromMembers kind derivation', () => {
  const store = createMemberStore([
    {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: [],
      token: 'csuite_kind_test_person_token',
      totpSecret: TEST_TOTP_SECRET,
    },
    {
      name: 'scout-1',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: 'csuite_kind_test_agent_token',
    },
  ]);

  it('TOTP-enrolled member projects as a person', () => {
    const teammates = teammatesFromMembers(store);
    const person = teammates.find((t) => t.name === 'director-1');
    expect(person?.kind).toBe('person');
  });

  it('token-only member omits kind entirely — absent, not "agent"', () => {
    const teammates = teammatesFromMembers(store);
    const agent = teammates.find((t) => t.name === 'scout-1');
    expect(agent).toBeDefined();
    expect(agent && 'kind' in agent).toBe(false);
  });
});
