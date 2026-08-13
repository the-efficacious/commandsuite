/**
 * Multi-token store tests.
 *
 * Exercises `TokenStore` directly against an in-memory SQLite,
 * plus the boot-time bootstrap migration helper. The endpoint-
 * level coverage (rotate, list, revoke as HTTP routes) lives in
 * `members-endpoints.test.ts` — this file is the unit layer.
 */

import { createTokenStoreFromMembers, hashRawToken, SqliteTokenStore } from 'csuite-core';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';

async function memberFixture() {
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

describe('TokenStore', async () => {
  it('inserts a token and resolves it back from the plaintext', async () => {
    const db = openDatabase(':memory:');
    const store = new SqliteTokenStore(db);
    const row = await store.insert({
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

    const resolved = await store.resolve('csuite_brand_new_token');
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(row.id);
    expect(resolved?.memberName).toBe('alice');
  });

  it('returns null for unknown plaintext', async () => {
    const db = openDatabase(':memory:');
    const store = new SqliteTokenStore(db);
    expect(await store.resolve('csuite_does_not_exist')).toBeNull();
  });

  it('expires tokens past their expires_at window', async () => {
    const db = openDatabase(':memory:');
    let clock = 1_700_000_000_000;
    const store = new SqliteTokenStore(db, { now: () => clock });
    await store.insert({
      memberName: 'alice',
      rawToken: 'csuite_expiring_token',
      label: 'short-lived',
      origin: 'enroll',
      expiresAt: clock + 1000,
    });
    expect(await store.resolve('csuite_expiring_token')).not.toBeNull();
    clock += 2000;
    expect(await store.resolve('csuite_expiring_token')).toBeNull();
  });

  it('lists every active token for a member, oldest first', async () => {
    const db = openDatabase(':memory:');
    let clock = 1_700_000_000_000;
    const store = new SqliteTokenStore(db, { now: () => clock });
    await store.insert({
      memberName: 'alice',
      rawToken: 'csuite_first',
      label: 'first',
      origin: 'rotate',
    });
    clock += 1000;
    await store.insert({
      memberName: 'alice',
      rawToken: 'csuite_second',
      label: 'second',
      origin: 'enroll',
    });
    clock += 1000;
    await store.insert({
      memberName: 'bob',
      rawToken: 'csuite_bob_token',
      label: 'bob-laptop',
      origin: 'enroll',
    });

    const aliceTokens = await store.listForMember('alice');
    expect(aliceTokens).toHaveLength(2);
    expect(aliceTokens[0]?.label).toBe('first');
    expect(aliceTokens[1]?.label).toBe('second');

    const bobTokens = await store.listForMember('bob');
    expect(bobTokens).toHaveLength(1);
  });

  it('revoke removes a single row, leaving peers intact', async () => {
    const db = await openDatabase(':memory:');
    const store = new SqliteTokenStore(db);
    const a = await store.insert({
      memberName: 'alice',
      rawToken: 'csuite_a',
      label: 'a',
      origin: 'enroll',
    });
    const b = await store.insert({
      memberName: 'alice',
      rawToken: 'csuite_b',
      label: 'b',
      origin: 'enroll',
    });
    expect(await store.revoke(a.id)).toBe(true);
    expect(await store.resolve('csuite_a')).toBeNull();
    expect((await store.resolve('csuite_b'))?.id).toBe(b.id);
    expect(await store.revoke(a.id)).toBe(false);
  });

  it('revokeAllForMember nukes every token of one member only', async () => {
    const db = openDatabase(':memory:');
    const store = new SqliteTokenStore(db);
    await store.insert({ memberName: 'alice', rawToken: 'csuite_a1', label: '', origin: 'enroll' });
    await store.insert({ memberName: 'alice', rawToken: 'csuite_a2', label: '', origin: 'enroll' });
    await store.insert({ memberName: 'bob', rawToken: 'csuite_b1', label: '', origin: 'enroll' });
    const removed = await store.revokeAllForMember('alice');
    expect(removed).toBe(2);
    expect(await store.listForMember('alice')).toHaveLength(0);
    expect(await store.listForMember('bob')).toHaveLength(1);
  });

  it('purgeExpired sweeps expired rows', async () => {
    const db = openDatabase(':memory:');
    let clock = 1_700_000_000_000;
    const store = new SqliteTokenStore(db, { now: () => clock });
    await store.insert({
      memberName: 'alice',
      rawToken: 'csuite_keep',
      label: '',
      origin: 'enroll',
    });
    await store.insert({
      memberName: 'alice',
      rawToken: 'csuite_drop',
      label: '',
      origin: 'enroll',
      expiresAt: clock + 100,
    });
    clock += 1000;
    expect(await store.purgeExpired()).toBe(1);
    expect(await store.resolve('csuite_keep')).not.toBeNull();
    expect(await store.resolve('csuite_drop')).toBeNull();
  });

  it('insertHashed is idempotent on the same hash', async () => {
    const db = await openDatabase(':memory:');
    const store = new SqliteTokenStore(db);
    const hash = await hashRawToken('csuite_known_hash');
    const a = await store.insertHashed({
      memberName: 'alice',
      hash,
      label: 'legacy',
      origin: 'bootstrap',
    });
    const b = await store.insertHashed({
      memberName: 'alice',
      hash,
      label: 'second-attempt',
      origin: 'rotate',
    });
    expect(a.id).toBe(b.id);
    expect(await store.listForMember('alice')).toHaveLength(1);
  });

  it('touch updates last_used_at but debounces frequent calls', async () => {
    const db = await openDatabase(':memory:');
    let clock = 1_700_000_000_000;
    const store = new SqliteTokenStore(db, { now: () => clock });
    const row = await store.insert({
      memberName: 'alice',
      rawToken: 'csuite_a',
      label: '',
      origin: 'enroll',
    });
    expect((await store.findById(row.id))?.lastUsedAt).toBeNull();
    await store.touch(row.id);
    const t1 = (await store.findById(row.id))?.lastUsedAt;
    expect(t1).toBe(clock);
    // Within debounce window — no new write.
    clock += 1000;
    await store.touch(row.id);
    expect((await store.findById(row.id))?.lastUsedAt).toBe(t1);
    // Past debounce window — new write lands.
    clock += 60_000;
    await store.touch(row.id);
    expect((await store.findById(row.id))?.lastUsedAt).toBe(clock);
  });
});

describe('createTokenStoreFromMembers (bootstrap migration)', async () => {
  it('seeds one token row per member with label=legacy', async () => {
    const db = await openDatabase(':memory:');
    const members = await memberFixture();
    const store = await createTokenStoreFromMembers(db, members);
    expect((await store.resolve('csuite_alice_secret'))?.label).toBe('legacy');
    expect((await store.resolve('csuite_alice_secret'))?.origin).toBe('bootstrap');
    expect((await store.resolve('csuite_bob_secret'))?.label).toBe('legacy');
  });

  it('is idempotent across re-runs (same DB)', async () => {
    const db = openDatabase(':memory:');
    const members = memberFixture();
    const a = await createTokenStoreFromMembers(db, await members);
    const b = await createTokenStoreFromMembers(db, await members);
    // Same DB, so each member still has exactly one token row.
    expect(await a.listForMember('alice')).toHaveLength(1);
    expect(await b.listForMember('alice')).toHaveLength(1);
  });
});
