import { describe, expect, it } from 'vitest';
import { InMemorySessionStore, SESSION_TTL_MS, type SessionRow } from '../src/index.js';

function makeStore(overrides: { now?: () => number; idGenerator?: () => string } = {}) {
  let tick = 1000;
  let counter = 0;
  return new InMemorySessionStore({
    now: overrides.now ?? (() => (tick += 100)),
    idGenerator: overrides.idGenerator ?? (() => `sid-${++counter}`),
  });
}

describe('InMemorySessionStore.create', () => {
  it('mints a fresh row with a TTL-bounded expiresAt', async () => {
    const now = 5_000;
    const store = new InMemorySessionStore({
      now: () => now,
      idGenerator: () => 'sid-fixed',
    });
    const row = await store.create('alpha', 'curl/8.1.0');
    expect(row.id).toBe('sid-fixed');
    expect(row.memberName).toBe('alpha');
    expect(row.createdAt).toBe(5_000);
    expect(row.expiresAt).toBe(5_000 + SESSION_TTL_MS);
    expect(row.lastSeen).toBe(5_000);
    expect(row.userAgent).toBe('curl/8.1.0');
  });

  it('assigns distinct ids to distinct sessions', async () => {
    const store = makeStore();
    const a = await store.create('alpha', null);
    const b = await store.create('alpha', null);
    expect(a.id).not.toBe(b.id);
  });
});

describe('InMemorySessionStore.get', () => {
  it('returns the row when still within TTL', async () => {
    const store = makeStore();
    const created = await store.create('alpha', null);
    const got = await store.get(created.id);
    expect(got).toEqual(created);
  });

  it('returns null for unknown ids', async () => {
    const store = makeStore();
    expect(await store.get('nope')).toBeNull();
  });

  it('treats expired rows as nonexistent on read', async () => {
    let now = 1_000;
    const store = new InMemorySessionStore({
      now: () => now,
      idGenerator: () => 'sid-1',
    });
    await store.create('alpha', null);
    now += SESSION_TTL_MS + 1;
    expect(await store.get('sid-1')).toBeNull();
  });
});

describe('InMemorySessionStore.touch', () => {
  it('extends expiresAt and bumps lastSeen', async () => {
    let now = 1_000;
    const store = new InMemorySessionStore({
      now: () => now,
      idGenerator: () => 'sid-1',
    });
    const created = await store.create('alpha', null);
    now += 60_000;
    await store.touch(created.id);
    const got = (await store.get(created.id)) as SessionRow;
    expect(got.lastSeen).toBe(61_000);
    expect(got.expiresAt).toBe(61_000 + SESSION_TTL_MS);
  });

  it('is a no-op for unknown ids', async () => {
    const store = makeStore();
    await expect(store.touch('nope')).resolves.toBeUndefined();
  });
});

describe('InMemorySessionStore.delete', () => {
  it('removes the row', async () => {
    const store = makeStore();
    const created = await store.create('alpha', null);
    await store.delete(created.id);
    expect(await store.get(created.id)).toBeNull();
  });

  it('is a no-op for unknown ids', async () => {
    const store = makeStore();
    await expect(store.delete('nope')).resolves.toBeUndefined();
  });
});

describe('InMemorySessionStore.purgeExpired', () => {
  it('removes only expired rows and returns the count', async () => {
    let now = 1_000;
    const store = new InMemorySessionStore({
      now: () => now,
      idGenerator: (() => {
        let n = 0;
        return () => `sid-${++n}`;
      })(),
    });
    await store.create('alpha', null); // sid-1
    await store.create('bravo', null); // sid-2
    now += SESSION_TTL_MS + 1;
    await store.create('charlie', null); // sid-3 — fresh, should survive
    const removed = await store.purgeExpired();
    expect(removed).toBe(2);
    expect(await store.get('sid-1')).toBeNull();
    expect(await store.get('sid-2')).toBeNull();
    expect(await store.get('sid-3')).not.toBeNull();
  });
});
