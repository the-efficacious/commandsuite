/**
 * Multi-token store tests.
 *
 * Exercises `TokenStore` directly against an in-memory SQLite,
 * plus the boot-time bootstrap migration helper. The endpoint-
 * level coverage (rotate, list, revoke as HTTP routes) lives in
 * `members-endpoints.test.ts` — this file is the unit layer.
 */

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { createTokenStoreFromMembers, hashRawToken, TokenStore } from '../src/tokens.js';

function memberFixture() {
  return createMemberStore([
    {
      name: 'alice',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      token: 'csuite_alice_secret',
    },
    {
      name: 'bob',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: 'csuite_bob_secret',
    },
  ]);
}

describe('TokenStore', () => {
  it('inserts a token and resolves it back from the plaintext', () => {
    const db = openDatabase(':memory:');
    const store = new TokenStore(db);
    const row = store.insert({
      memberName: 'alice',
      rawToken: 'csuite_brand_new_token',
      label: 'laptop',
      origin: 'enroll',
      createdBy: 'alice',
    });
    expect(row.id).toMatch(/^[0-9a-f]{8}-/);
    expect(row.label).toBe('laptop');
    expect(row.origin).toBe('enroll');
    expect(row.lastUsedAt).toBeNull();
    expect(row.expiresAt).toBeNull();
    expect(row.createdBy).toBe('alice');

    const resolved = store.resolve('csuite_brand_new_token');
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(row.id);
    expect(resolved?.memberName).toBe('alice');
  });

  it('returns null for unknown plaintext', () => {
    const db = openDatabase(':memory:');
    const store = new TokenStore(db);
    expect(store.resolve('csuite_does_not_exist')).toBeNull();
  });

  it('expires tokens past their expires_at window', () => {
    const db = openDatabase(':memory:');
    let clock = 1_700_000_000_000;
    const store = new TokenStore(db, { now: () => clock });
    store.insert({
      memberName: 'alice',
      rawToken: 'csuite_expiring_token',
      label: 'short-lived',
      origin: 'enroll',
      expiresAt: clock + 1000,
    });
    expect(store.resolve('csuite_expiring_token')).not.toBeNull();
    clock += 2000;
    expect(store.resolve('csuite_expiring_token')).toBeNull();
  });

  it('lists every active token for a member, oldest first', () => {
    const db = openDatabase(':memory:');
    let clock = 1_700_000_000_000;
    const store = new TokenStore(db, { now: () => clock });
    store.insert({
      memberName: 'alice',
      rawToken: 'csuite_first',
      label: 'first',
      origin: 'rotate',
    });
    clock += 1000;
    store.insert({
      memberName: 'alice',
      rawToken: 'csuite_second',
      label: 'second',
      origin: 'enroll',
    });
    clock += 1000;
    store.insert({
      memberName: 'bob',
      rawToken: 'csuite_bob_token',
      label: 'bob-laptop',
      origin: 'enroll',
    });

    const aliceTokens = store.listForMember('alice');
    expect(aliceTokens).toHaveLength(2);
    expect(aliceTokens[0]?.label).toBe('first');
    expect(aliceTokens[1]?.label).toBe('second');

    const bobTokens = store.listForMember('bob');
    expect(bobTokens).toHaveLength(1);
  });

  it('revoke removes a single row, leaving peers intact', () => {
    const db = openDatabase(':memory:');
    const store = new TokenStore(db);
    const a = store.insert({
      memberName: 'alice',
      rawToken: 'csuite_a',
      label: 'a',
      origin: 'enroll',
    });
    const b = store.insert({
      memberName: 'alice',
      rawToken: 'csuite_b',
      label: 'b',
      origin: 'enroll',
    });
    expect(store.revoke(a.id)).toBe(true);
    expect(store.resolve('csuite_a')).toBeNull();
    expect(store.resolve('csuite_b')?.id).toBe(b.id);
    expect(store.revoke(a.id)).toBe(false);
  });

  it('revokeAllForMember nukes every token of one member only', () => {
    const db = openDatabase(':memory:');
    const store = new TokenStore(db);
    store.insert({ memberName: 'alice', rawToken: 'csuite_a1', label: '', origin: 'enroll' });
    store.insert({ memberName: 'alice', rawToken: 'csuite_a2', label: '', origin: 'enroll' });
    store.insert({ memberName: 'bob', rawToken: 'csuite_b1', label: '', origin: 'enroll' });
    const removed = store.revokeAllForMember('alice');
    expect(removed).toBe(2);
    expect(store.listForMember('alice')).toHaveLength(0);
    expect(store.listForMember('bob')).toHaveLength(1);
  });

  it('purgeExpired sweeps expired rows', () => {
    const db = openDatabase(':memory:');
    let clock = 1_700_000_000_000;
    const store = new TokenStore(db, { now: () => clock });
    store.insert({ memberName: 'alice', rawToken: 'csuite_keep', label: '', origin: 'enroll' });
    store.insert({
      memberName: 'alice',
      rawToken: 'csuite_drop',
      label: '',
      origin: 'enroll',
      expiresAt: clock + 100,
    });
    clock += 1000;
    expect(store.purgeExpired()).toBe(1);
    expect(store.resolve('csuite_keep')).not.toBeNull();
    expect(store.resolve('csuite_drop')).toBeNull();
  });

  it('insertHashed is idempotent on the same hash', () => {
    const db = openDatabase(':memory:');
    const store = new TokenStore(db);
    const hash = hashRawToken('csuite_known_hash');
    const a = store.insertHashed({
      memberName: 'alice',
      hash,
      label: 'legacy',
      origin: 'bootstrap',
    });
    const b = store.insertHashed({
      memberName: 'alice',
      hash,
      label: 'second-attempt',
      origin: 'rotate',
    });
    expect(a.id).toBe(b.id);
    expect(store.listForMember('alice')).toHaveLength(1);
  });

  it('touch updates last_used_at but debounces frequent calls', () => {
    const db = openDatabase(':memory:');
    let clock = 1_700_000_000_000;
    const store = new TokenStore(db, { now: () => clock });
    const row = store.insert({
      memberName: 'alice',
      rawToken: 'csuite_a',
      label: '',
      origin: 'enroll',
    });
    expect(store.findById(row.id)?.lastUsedAt).toBeNull();
    store.touch(row.id);
    const t1 = store.findById(row.id)?.lastUsedAt;
    expect(t1).toBe(clock);
    // Within debounce window — no new write.
    clock += 1000;
    store.touch(row.id);
    expect(store.findById(row.id)?.lastUsedAt).toBe(t1);
    // Past debounce window — new write lands.
    clock += 60_000;
    store.touch(row.id);
    expect(store.findById(row.id)?.lastUsedAt).toBe(clock);
  });
});

describe('createTokenStoreFromMembers (bootstrap migration)', () => {
  it('seeds one token row per member with label=legacy', () => {
    const db = openDatabase(':memory:');
    const members = memberFixture();
    const store = createTokenStoreFromMembers(db, members);
    expect(store.resolve('csuite_alice_secret')?.label).toBe('legacy');
    expect(store.resolve('csuite_alice_secret')?.origin).toBe('bootstrap');
    expect(store.resolve('csuite_bob_secret')?.label).toBe('legacy');
  });

  it('is idempotent across re-runs (same DB)', () => {
    const db = openDatabase(':memory:');
    const members = memberFixture();
    const a = createTokenStoreFromMembers(db, members);
    const b = createTokenStoreFromMembers(db, members);
    // Same DB, so each member still has exactly one token row.
    expect(a.listForMember('alice')).toHaveLength(1);
    expect(b.listForMember('alice')).toHaveLength(1);
  });
});
