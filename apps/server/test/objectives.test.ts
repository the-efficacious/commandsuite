/**
 * Objectives store tests.
 *
 * Exercises `SqliteObjectivesStore` directly against an in-memory
 * SQLite. Endpoint-level coverage (auth gates, request/response
 * shapes, channel fanout) lives in objectives-endpoints.test.ts;
 * here we just want to pin the state machine, the audit-log
 * behaviour, and the input-normalization rules.
 */

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createSqliteObjectivesStore, ObjectivesError } from '../src/objectives.js';

function newStore() {
  return createSqliteObjectivesStore(openDatabase(':memory:'));
}

const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;

function basicCreate(store = newStore()) {
  const { objective, events } = store.create(
    {
      title: 'Ship the thing',
      outcome: 'PR merged to main',
      body: 'context',
      assignee: 'alice',
    },
    'manager',
    NOW,
  );
  return { store, objective, events };
}

describe('ObjectivesStore.create', () => {
  it('returns a fresh active objective and an `assigned` event', () => {
    const { objective, events } = basicCreate();
    expect(objective.title).toBe('Ship the thing');
    expect(objective.outcome).toBe('PR merged to main');
    expect(objective.body).toBe('context');
    expect(objective.status).toBe('active');
    expect(objective.assignee).toBe('alice');
    expect(objective.originator).toBe('manager');
    expect(objective.watchers).toEqual([]);
    expect(objective.completedAt).toBeNull();
    expect(objective.result).toBeNull();
    expect(objective.blockReason).toBeNull();
    expect(objective.createdAt).toBe(NOW);
    expect(objective.updatedAt).toBe(NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('assigned');
    expect(events[0]?.actor).toBe('manager');
    expect(events[0]?.payload).toMatchObject({
      title: 'Ship the thing',
      outcome: 'PR merged to main',
      assignee: 'alice',
    });
  });

  it('trims whitespace on title, outcome, and body', () => {
    const store = newStore();
    const { objective } = store.create(
      { title: '  hello  ', outcome: '\t done \n', body: ' ctx ', assignee: 'a' },
      'm',
      NOW,
    );
    expect(objective.title).toBe('hello');
    expect(objective.outcome).toBe('done');
    expect(objective.body).toBe('ctx');
  });

  it('rejects an empty title', () => {
    const store = newStore();
    expect(() => store.create({ title: '   ', outcome: 'x', assignee: 'a' }, 'm', NOW)).toThrow(
      ObjectivesError,
    );
  });

  it('rejects an empty outcome', () => {
    const store = newStore();
    expect(() => store.create({ title: 'x', outcome: '   ', assignee: 'a' }, 'm', NOW)).toThrow(
      ObjectivesError,
    );
  });

  it('dedupes initial watchers and drops the assignee + originator', () => {
    const store = newStore();
    const { objective, events } = store.create(
      {
        title: 't',
        outcome: 'o',
        assignee: 'alice',
        watchers: ['alice', 'manager', 'bob', 'bob', 'carol', ''],
      },
      'manager',
      NOW,
    );
    expect(objective.watchers).toEqual(['bob', 'carol']);
    // One assigned + one watcher_added per net-new watcher.
    expect(events.map((e) => e.kind)).toEqual(['assigned', 'watcher_added', 'watcher_added']);
    const watcherEvents = events.filter((e) => e.kind === 'watcher_added');
    expect(watcherEvents.map((e) => e.payload.name)).toEqual(['bob', 'carol']);
  });

  it('assigns unique ids across rapid creates', () => {
    const store = newStore();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { objective } = store.create({ title: 't', outcome: 'o', assignee: 'a' }, 'm', NOW);
      ids.add(objective.id);
    }
    expect(ids.size).toBe(50);
  });
});

describe('ObjectivesStore.list and get', () => {
  it('newest-first by created_at', () => {
    const store = newStore();
    store.create({ title: 'first', outcome: 'o', assignee: 'a' }, 'm', NOW);
    store.create({ title: 'second', outcome: 'o', assignee: 'a' }, 'm', NOW + 1_000);
    store.create({ title: 'third', outcome: 'o', assignee: 'a' }, 'm', NOW + 2_000);
    const titles = store.list().map((o) => o.title);
    expect(titles).toEqual(['third', 'second', 'first']);
  });

  it('filters by assignee', () => {
    const store = newStore();
    store.create({ title: 'a-one', outcome: 'o', assignee: 'alice' }, 'm', NOW);
    store.create({ title: 'b-one', outcome: 'o', assignee: 'bob' }, 'm', NOW);
    expect(store.list({ assignee: 'alice' }).map((o) => o.title)).toEqual(['a-one']);
    expect(store.list({ assignee: 'bob' }).map((o) => o.title)).toEqual(['b-one']);
    expect(store.list({ assignee: 'ghost' })).toEqual([]);
  });

  it('filters by status', () => {
    const store = newStore();
    const { objective: a } = store.create({ title: 'a', outcome: 'o', assignee: 'a' }, 'm', NOW);
    const { objective: b } = store.create(
      { title: 'b', outcome: 'o', assignee: 'a' },
      'm',
      NOW + 1,
    );
    store.update(a.id, { status: 'blocked', blockReason: 'waiting' }, 'm', NOW + 2);
    store.complete(b.id, { result: 'shipped' }, 'm', NOW + 3);
    expect(store.list({ status: 'active' }).map((o) => o.title)).toEqual([]);
    expect(store.list({ status: 'blocked' }).map((o) => o.title)).toEqual(['a']);
    expect(store.list({ status: 'done' }).map((o) => o.title)).toEqual(['b']);
  });

  it('combines assignee + status filters', () => {
    const store = newStore();
    store.create({ title: 'a-act', outcome: 'o', assignee: 'alice' }, 'm', NOW);
    const { objective: bDone } = store.create(
      { title: 'b-done', outcome: 'o', assignee: 'bob' },
      'm',
      NOW + 1,
    );
    store.complete(bDone.id, { result: 'r' }, 'm', NOW + 2);
    expect(store.list({ assignee: 'alice', status: 'active' }).map((o) => o.title)).toEqual([
      'a-act',
    ]);
    expect(store.list({ assignee: 'bob', status: 'done' }).map((o) => o.title)).toEqual(['b-done']);
    expect(store.list({ assignee: 'alice', status: 'done' })).toEqual([]);
  });

  it('get returns null for unknown ids', () => {
    expect(newStore().get('nope')).toBeNull();
  });
});

describe('ObjectivesStore.update', () => {
  it('transitions active → blocked with a reason', () => {
    const { store, objective } = basicCreate();
    const result = store.update(
      objective.id,
      { status: 'blocked', blockReason: '  waiting on Bob  ' },
      'alice',
      LATER,
    );
    expect(result.objective.status).toBe('blocked');
    expect(result.objective.blockReason).toBe('waiting on Bob');
    expect(result.objective.updatedAt).toBe(LATER);
    expect(result.events.map((e) => e.kind)).toEqual(['blocked']);
    expect(result.events[0]?.payload).toMatchObject({ reason: 'waiting on Bob' });
  });

  it('rejects blocked transition without a reason', () => {
    const { store, objective } = basicCreate();
    expect(() => store.update(objective.id, { status: 'blocked' }, 'alice', LATER)).toThrow(
      ObjectivesError,
    );
    expect(() =>
      store.update(objective.id, { status: 'blocked', blockReason: '   ' }, 'alice', LATER),
    ).toThrow(ObjectivesError);
  });

  it('transitions blocked → active and clears the reason', () => {
    const { store, objective } = basicCreate();
    store.update(objective.id, { status: 'blocked', blockReason: 'waiting' }, 'alice', NOW + 1_000);
    const { objective: unblocked, events } = store.update(
      objective.id,
      { status: 'active' },
      'alice',
      NOW + 2_000,
    );
    expect(unblocked.status).toBe('active');
    expect(unblocked.blockReason).toBeNull();
    expect(events.map((e) => e.kind)).toEqual(['unblocked']);
  });

  it('returns events: [] for a no-op update', () => {
    const { store, objective } = basicCreate();
    const result = store.update(objective.id, { status: 'active' }, 'alice', LATER);
    expect(result.events).toEqual([]);
    // updated_at also unchanged because nothing was written.
    expect(result.objective.updatedAt).toBe(NOW);
  });

  it('refuses to update a done objective', () => {
    const { store, objective } = basicCreate();
    store.complete(objective.id, { result: 'r' }, 'alice', LATER);
    expect(() =>
      store.update(objective.id, { status: 'blocked', blockReason: 'x' }, 'alice', LATER),
    ).toThrow(/done/);
  });

  it('refuses to update a cancelled objective', () => {
    const { store, objective } = basicCreate();
    store.cancel(objective.id, { reason: 'nvm' }, 'manager', LATER);
    expect(() => store.update(objective.id, { status: 'active' }, 'alice', LATER)).toThrow(
      /cancelled/,
    );
  });

  it('throws not_found on unknown id', () => {
    expect(() => newStore().update('nope', { status: 'active' }, 'm', NOW)).toThrow(
      ObjectivesError,
    );
  });
});

describe('ObjectivesStore.complete', () => {
  it('marks done with completedAt and result', () => {
    const { store, objective } = basicCreate();
    const { objective: done, events } = store.complete(
      objective.id,
      { result: '  delivered  ' },
      'alice',
      LATER,
    );
    expect(done.status).toBe('done');
    expect(done.completedAt).toBe(LATER);
    expect(done.result).toBe('delivered');
    expect(events.map((e) => e.kind)).toEqual(['completed']);
    expect(events[0]?.payload).toMatchObject({ result: 'delivered' });
  });

  it('clears blockReason on completion from blocked', () => {
    const { store, objective } = basicCreate();
    store.update(objective.id, { status: 'blocked', blockReason: 'waiting' }, 'alice', NOW + 1_000);
    const { objective: done } = store.complete(objective.id, { result: 'shipped' }, 'alice', LATER);
    expect(done.status).toBe('done');
    // The store nulls block_reason in the same UPDATE that flips
    // status — completion is a clean terminal state, so any
    // outstanding block reason should not persist.
    expect(done.blockReason).toBeNull();
  });

  it('rejects an empty result', () => {
    const { store, objective } = basicCreate();
    expect(() => store.complete(objective.id, { result: '   ' }, 'alice', LATER)).toThrow(
      ObjectivesError,
    );
  });

  it('rejects re-completing a done objective', () => {
    const { store, objective } = basicCreate();
    store.complete(objective.id, { result: 'r' }, 'alice', LATER);
    expect(() => store.complete(objective.id, { result: 'r2' }, 'alice', LATER + 1)).toThrow(
      /already done/,
    );
  });

  it('rejects completing a cancelled objective', () => {
    const { store, objective } = basicCreate();
    store.cancel(objective.id, {}, 'manager', LATER);
    expect(() => store.complete(objective.id, { result: 'r' }, 'alice', LATER + 1)).toThrow(
      /cancelled/,
    );
  });
});

describe('ObjectivesStore.cancel', () => {
  it('terminally cancels with an optional reason', () => {
    const { store, objective } = basicCreate();
    const { objective: cancelled, events } = store.cancel(
      objective.id,
      { reason: 'scope changed' },
      'manager',
      LATER,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(events.map((e) => e.kind)).toEqual(['cancelled']);
    expect(events[0]?.payload).toMatchObject({ reason: 'scope changed' });
  });

  it('omits reason in the event payload when none provided', () => {
    const { store, objective } = basicCreate();
    const { events } = store.cancel(objective.id, {}, 'manager', LATER);
    expect(events[0]?.payload).toEqual({});
  });

  it('refuses to cancel a done objective', () => {
    const { store, objective } = basicCreate();
    store.complete(objective.id, { result: 'r' }, 'alice', LATER);
    expect(() => store.cancel(objective.id, {}, 'manager', LATER + 1)).toThrow(/already done/);
  });

  it('refuses to cancel a cancelled objective', () => {
    const { store, objective } = basicCreate();
    store.cancel(objective.id, {}, 'manager', LATER);
    expect(() => store.cancel(objective.id, {}, 'manager', LATER + 1)).toThrow(/already cancelled/);
  });
});

describe('ObjectivesStore.reassign', () => {
  it('moves the assignee and emits a reassigned event with from/to', () => {
    const { store, objective } = basicCreate();
    const { objective: moved, events } = store.reassign(
      objective.id,
      { to: 'bob', note: '  needs more context  ' },
      'manager',
      LATER,
    );
    expect(moved.assignee).toBe('bob');
    expect(events.map((e) => e.kind)).toEqual(['reassigned']);
    expect(events[0]?.payload).toMatchObject({
      from: 'alice',
      to: 'bob',
      note: 'needs more context',
    });
  });

  it('preserves status across reassign', () => {
    const { store, objective } = basicCreate();
    store.update(objective.id, { status: 'blocked', blockReason: 'waiting' }, 'alice', NOW + 1_000);
    const { objective: moved } = store.reassign(objective.id, { to: 'bob' }, 'manager', LATER);
    expect(moved.status).toBe('blocked');
    expect(moved.blockReason).toBe('waiting');
  });

  it('rejects reassign to the current assignee', () => {
    const { store, objective } = basicCreate();
    expect(() => store.reassign(objective.id, { to: 'alice' }, 'manager', LATER)).toThrow(
      /already assigned/,
    );
  });

  it('refuses to reassign a terminal objective', () => {
    const { store, objective } = basicCreate();
    store.complete(objective.id, { result: 'r' }, 'alice', LATER);
    expect(() => store.reassign(objective.id, { to: 'bob' }, 'manager', LATER + 1)).toThrow(/done/);
  });
});

describe('ObjectivesStore.updateWatchers', () => {
  it('adds new watchers and emits one watcher_added per name', () => {
    const { store, objective } = basicCreate();
    const { objective: updated, events } = store.updateWatchers(
      objective.id,
      { add: ['bob', 'carol'] },
      'manager',
      LATER,
    );
    expect(updated.watchers).toEqual(['bob', 'carol']);
    expect(events.map((e) => e.kind)).toEqual(['watcher_added', 'watcher_added']);
    expect(events.map((e) => e.payload.name)).toEqual(['bob', 'carol']);
  });

  it('removes watchers and emits one watcher_removed per name', () => {
    const { store, objective } = basicCreate();
    store.updateWatchers(objective.id, { add: ['bob', 'carol'] }, 'manager', NOW + 1_000);
    const { objective: updated, events } = store.updateWatchers(
      objective.id,
      { remove: ['bob'] },
      'manager',
      LATER,
    );
    expect(updated.watchers).toEqual(['carol']);
    expect(events.map((e) => e.kind)).toEqual(['watcher_removed']);
    expect(events[0]?.payload).toMatchObject({ name: 'bob' });
  });

  it('add + remove in one call lands both event kinds', () => {
    const { store, objective } = basicCreate();
    store.updateWatchers(objective.id, { add: ['bob'] }, 'manager', NOW + 1_000);
    const { objective: updated, events } = store.updateWatchers(
      objective.id,
      { add: ['carol'], remove: ['bob'] },
      'manager',
      LATER,
    );
    expect(updated.watchers).toEqual(['carol']);
    expect(events.map((e) => e.kind)).toEqual(['watcher_added', 'watcher_removed']);
  });

  it('silently drops adds for assignee + originator', () => {
    const { store, objective } = basicCreate();
    const { objective: updated, events } = store.updateWatchers(
      objective.id,
      { add: ['alice', 'manager'] },
      'manager',
      LATER,
    );
    expect(updated.watchers).toEqual([]);
    expect(events).toEqual([]);
  });

  it('silently drops adds for already-watching names', () => {
    const { store, objective } = basicCreate();
    store.updateWatchers(objective.id, { add: ['bob'] }, 'manager', NOW + 1_000);
    const { events } = store.updateWatchers(objective.id, { add: ['bob'] }, 'manager', LATER);
    expect(events).toEqual([]);
  });

  it('silently drops removes for non-watchers', () => {
    const { store, objective } = basicCreate();
    const { events } = store.updateWatchers(objective.id, { remove: ['ghost'] }, 'manager', LATER);
    expect(events).toEqual([]);
  });

  it('returns events: [] for a fully no-op call', () => {
    const { store, objective } = basicCreate();
    const result = store.updateWatchers(objective.id, {}, 'manager', LATER);
    expect(result.events).toEqual([]);
    expect(result.objective.updatedAt).toBe(NOW);
  });

  it('allows watcher mutation on a terminal objective', () => {
    // A reviewer might be looped in after an objective is done to
    // read the result; the store deliberately allows this.
    const { store, objective } = basicCreate();
    store.complete(objective.id, { result: 'r' }, 'alice', LATER);
    const { objective: updated, events } = store.updateWatchers(
      objective.id,
      { add: ['carol'] },
      'manager',
      LATER + 1,
    );
    expect(updated.watchers).toEqual(['carol']);
    expect(events.map((e) => e.kind)).toEqual(['watcher_added']);
  });
});

describe('ObjectivesStore.events (audit log)', () => {
  it('returns the full append-only log in chronological order', () => {
    const { store, objective } = basicCreate();
    store.update(objective.id, { status: 'blocked', blockReason: 'waiting' }, 'alice', NOW + 1_000);
    store.update(objective.id, { status: 'active' }, 'alice', NOW + 2_000);
    store.updateWatchers(objective.id, { add: ['carol'] }, 'manager', NOW + 3_000);
    store.reassign(objective.id, { to: 'bob' }, 'manager', NOW + 4_000);
    store.complete(objective.id, { result: 'shipped' }, 'bob', NOW + 5_000);

    const events = store.events(objective.id);
    expect(events.map((e) => e.kind)).toEqual([
      'assigned',
      'blocked',
      'unblocked',
      'watcher_added',
      'reassigned',
      'completed',
    ]);
    // Timestamps strictly non-decreasing.
    const ts = events.map((e) => e.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('returns an empty list for unknown ids', () => {
    expect(newStore().events('nope')).toEqual([]);
  });
});

describe('ObjectivesError', () => {
  it('carries a structured code that maps to HTTP status upstream', () => {
    const store = newStore();
    try {
      store.update('nope', { status: 'active' }, 'm', NOW);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ObjectivesError);
      expect((err as ObjectivesError).code).toBe('not_found');
    }
  });
});
