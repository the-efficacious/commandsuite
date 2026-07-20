import { describe, expect, it } from 'vitest';
import { InMemoryPushSubscriptionStore, type PushSubscriptionInput } from '../src/index.js';

function sampleInput(overrides: Partial<PushSubscriptionInput> = {}): PushSubscriptionInput {
  return {
    memberName: 'alpha',
    endpoint: 'https://push.example/endpoint/xyz',
    p256dh: 'p256dh-key',
    auth: 'auth-key',
    userAgent: 'Mozilla/5.0',
    ...overrides,
  };
}

describe('InMemoryPushSubscriptionStore.upsert', () => {
  it('creates a fresh row with monotonically increasing ids', async () => {
    const store = new InMemoryPushSubscriptionStore({ now: () => 1_000 });
    const a = await store.upsert(sampleInput({ endpoint: 'https://a' }));
    const b = await store.upsert(sampleInput({ endpoint: 'https://b' }));
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.createdAt).toBe(1_000);
    expect(a.lastSuccessAt).toBeNull();
  });

  it('replaces existing row on endpoint collision without duplicating', async () => {
    let now = 1_000;
    const store = new InMemoryPushSubscriptionStore({ now: () => now });
    const first = await store.upsert(sampleInput({ p256dh: 'key-v1', auth: 'auth-v1' }));
    now = 2_000;
    const second = await store.upsert(sampleInput({ p256dh: 'key-v2', auth: 'auth-v2' }));
    expect(second.id).toBe(first.id); // same row, re-used id
    expect(second.p256dh).toBe('key-v2');
    expect(second.createdAt).toBe(2_000);
    expect(store.size()).toBe(1);
  });

  it('clears error state on re-subscribe', async () => {
    const store = new InMemoryPushSubscriptionStore({ now: () => 1_000 });
    const initial = await store.upsert(sampleInput());
    await store.markError(initial.id, 500);
    const refreshed = await store.upsert(sampleInput());
    expect(refreshed.lastErrorAt).toBeNull();
    expect(refreshed.lastErrorCode).toBeNull();
  });
});

describe('InMemoryPushSubscriptionStore.listForMember', () => {
  it('returns only rows owned by the requested slot', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.upsert(sampleInput({ memberName: 'alpha', endpoint: 'https://a' }));
    await store.upsert(sampleInput({ memberName: 'alpha', endpoint: 'https://b' }));
    await store.upsert(sampleInput({ memberName: 'bravo', endpoint: 'https://c' }));
    const alphaRows = await store.listForMember('alpha');
    expect(alphaRows).toHaveLength(2);
    expect(alphaRows.map((r) => r.endpoint).sort()).toEqual(['https://a', 'https://b']);
  });

  it('returns empty array for slots with no subscriptions', async () => {
    const store = new InMemoryPushSubscriptionStore();
    expect(await store.listForMember('ghost')).toEqual([]);
  });
});

describe('InMemoryPushSubscriptionStore.findByEndpoint', () => {
  it('finds by exact endpoint match', async () => {
    const store = new InMemoryPushSubscriptionStore();
    const row = await store.upsert(sampleInput({ endpoint: 'https://x' }));
    const found = await store.findByEndpoint('https://x');
    expect(found?.id).toBe(row.id);
  });

  it('returns null for unknown endpoints', async () => {
    const store = new InMemoryPushSubscriptionStore();
    expect(await store.findByEndpoint('https://nope')).toBeNull();
  });
});

describe('InMemoryPushSubscriptionStore.deleteForMember', () => {
  it('removes the row when slot owns it', async () => {
    const store = new InMemoryPushSubscriptionStore();
    const row = await store.upsert(sampleInput({ memberName: 'alpha', endpoint: 'https://x' }));
    await store.deleteForMember(row.id, 'alpha');
    expect(await store.findByEndpoint('https://x')).toBeNull();
  });

  it('is a no-op when a different slot asks (id-guess protection)', async () => {
    const store = new InMemoryPushSubscriptionStore();
    const row = await store.upsert(sampleInput({ memberName: 'alpha', endpoint: 'https://x' }));
    await store.deleteForMember(row.id, 'bravo');
    expect(await store.findByEndpoint('https://x')).not.toBeNull();
  });
});

describe('InMemoryPushSubscriptionStore.deleteByEndpoint', () => {
  it('removes the row by endpoint (used by dispatch 410/404 cleanup)', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.upsert(sampleInput({ endpoint: 'https://x' }));
    await store.deleteByEndpoint('https://x');
    expect(await store.findByEndpoint('https://x')).toBeNull();
  });
});

describe('InMemoryPushSubscriptionStore.markSuccess / markError', () => {
  it('markSuccess records timestamp and clears prior error', async () => {
    let now = 1_000;
    const store = new InMemoryPushSubscriptionStore({ now: () => now });
    const row = await store.upsert(sampleInput());
    await store.markError(row.id, 500);
    now = 2_000;
    await store.markSuccess(row.id);
    const fresh = await store.findByEndpoint(row.endpoint);
    expect(fresh?.lastSuccessAt).toBe(2_000);
    expect(fresh?.lastErrorAt).toBeNull();
    expect(fresh?.lastErrorCode).toBeNull();
  });

  it('markError records timestamp + code without touching lastSuccessAt', async () => {
    let now = 1_000;
    const store = new InMemoryPushSubscriptionStore({ now: () => now });
    const row = await store.upsert(sampleInput());
    await store.markSuccess(row.id);
    now = 2_000;
    await store.markError(row.id, 503);
    const fresh = await store.findByEndpoint(row.endpoint);
    expect(fresh?.lastSuccessAt).toBe(1_000);
    expect(fresh?.lastErrorAt).toBe(2_000);
    expect(fresh?.lastErrorCode).toBe(503);
  });

  it('both are no-ops for unknown ids', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await expect(store.markSuccess(999)).resolves.toBeUndefined();
    await expect(store.markError(999, 500)).resolves.toBeUndefined();
  });
});
