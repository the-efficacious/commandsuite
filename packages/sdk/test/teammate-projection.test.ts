/**
 * What a `Teammate` — and therefore a `Member` — is, exactly.
 *
 * Two properties, both asserted as complete sets rather than as the
 * presence of individual fields, because the failure these replace was
 * a field that was declared, schema-accepted and never produced.
 *
 *   1. `identityId` is gone from the wire (D32). It was declared on
 *      `Teammate`, validated as a UUID by `TeammateSchema`, stored
 *      `NOT NULL UNIQUE` with a backfill migration — and no projection
 *      ever emitted it, so every client that believed the doc comment
 *      and keyed on it collected the whole team under one `undefined`.
 *      The id stays server-internal; the schema no longer declares it,
 *      so a body carrying one has it stripped rather than blessed.
 *   2. `Member` really extends `Teammate` on the wire: the full record
 *      is the public record plus `instructions`, and nothing else.
 */

import { describe, expect, it } from 'vitest';
import { MemberSchema, TeammateSchema } from '../src/schemas.js';

const TEAMMATE_KEYS = ['kind', 'name', 'permissions', 'role'];
const MEMBER_KEYS = [...TEAMMATE_KEYS, 'instructions'].sort();

const wire = {
  name: 'builder',
  role: { title: 'engineer', description: 'builds' },
  permissions: [],
  kind: 'person' as const,
};

describe('Teammate no longer carries identityId', () => {
  it('strips identityId from a body that sends one', () => {
    // The schema is a stripping `z.object`, not `.strict()`, so the
    // assertion is on the parsed OUTPUT: a client cannot round-trip an
    // identity id through the SDK and believe the broker accepted it.
    const parsed = TeammateSchema.parse({
      ...wire,
      identityId: '3f2a1c88-8f4e-4a1a-9b6d-2f1d0d2f6a55',
    });

    expect(Object.hasOwn(parsed, 'identityId')).toBe(false);
    expect(parsed).not.toHaveProperty('identityId');
    expect(Object.keys(parsed).sort()).toEqual(TEAMMATE_KEYS);
  });

  it('strips it from a Member too — the subtype inherits the omission', () => {
    const parsed = MemberSchema.parse({
      ...wire,
      instructions: 'stay on task',
      identityId: '3f2a1c88-8f4e-4a1a-9b6d-2f1d0d2f6a55',
    });

    expect(Object.hasOwn(parsed, 'identityId')).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(MEMBER_KEYS);
  });
});

describe('Member is exactly Teammate plus instructions', () => {
  it('pins the declared key set of each, so neither can drift alone', () => {
    const teammate = TeammateSchema.parse(wire);
    const member = MemberSchema.parse({ ...wire, instructions: 'stay on task' });

    expect(Object.keys(teammate).sort()).toEqual(TEAMMATE_KEYS);
    expect(Object.keys(member).sort()).toEqual(MEMBER_KEYS);
    // Superset, field for field — not "has some of the same fields".
    for (const key of Object.keys(teammate)) {
      expect(member).toHaveProperty(key);
    }
  });

  it('omits kind rather than defaulting it, on both', () => {
    // Absence is the neutral (agent) treatment. A default would make
    // "we do not know" indistinguishable from "we looked".
    const { kind: _kind, ...withoutKind } = wire;
    const teammate = TeammateSchema.parse(withoutKind);
    const member = MemberSchema.parse({ ...withoutKind, instructions: '' });

    expect(Object.keys(teammate).sort()).toEqual(['name', 'permissions', 'role']);
    expect(Object.keys(member).sort()).toEqual(['instructions', 'name', 'permissions', 'role']);
  });
});
