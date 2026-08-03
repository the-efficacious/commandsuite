import type { RosterResponse } from 'csuite-sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetRosterForTests, memberKind, roster } from '../src/lib/roster.js';
import { senderTextClass } from '../src/lib/sender-color.js';

describe('senderTextClass', () => {
  it('person gets identity blue', () => {
    expect(senderTextClass('person')).toBe('text-ef-identity-person');
  });

  it('agent gets the neutral identity treatment', () => {
    expect(senderTextClass('agent')).toBe('text-ef-identity-agent');
  });

  it('unknown kind fails toward agent-neutral, never person-blue', () => {
    expect(senderTextClass(undefined)).toBe('text-ef-identity-agent');
  });
});

describe('memberKind', () => {
  afterEach(() => {
    __resetRosterForTests();
  });

  const rosterWith = (teammates: RosterResponse['teammates']): RosterResponse =>
    ({ teammates, connected: [] }) as RosterResponse;

  it('reads kind from the roster signal', () => {
    roster.value = rosterWith([
      {
        name: 'andrew',
        role: { title: 'director', description: '' },
        permissions: [],
        kind: 'person',
      },
      { name: 'scout-1', role: { title: 'engineer', description: '' }, permissions: [] },
    ]);
    expect(memberKind('andrew')).toBe('person');
    expect(memberKind('scout-1')).toBeUndefined();
  });

  it('unknown member is undefined, not agent', () => {
    roster.value = rosterWith([]);
    expect(memberKind('nobody')).toBeUndefined();
  });

  it('null roster is undefined', () => {
    expect(memberKind('anyone')).toBeUndefined();
  });
});
