/**
 * The drain-and-restart coordinator, exercised through controllable
 * hooks: a settable activity signal plus swappable refresh/respawn
 * behaviors so each phase boundary can be held open while requests
 * land on it. The coalescing rules are the contract under test — N
 * edits must cost at most two restarts, and an edit landing after
 * the refetch must never be silently marked applied. The respawn is
 * cold; what the hook receives is the set of REASONS the cycle applied
 * (recorded as `respawn:<reasons>`), which the driver stamps onto the
 * successor's session_start.
 */

import { describe, expect, it } from 'vitest';
import type { ActivityObservation, RestartHooks } from '../../src/runtime/restart.js';
import { createRestartCoordinator } from '../../src/runtime/restart.js';
import { silentLogger } from '../helpers/logger.js';

type State = 'idle' | 'working' | 'blocked';

function fakeActivity(initial: State) {
  let state = initial;
  const listeners = new Set<(s: State) => void>();
  const observation: ActivityObservation = {
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
  };
  return {
    observation,
    set(next: State) {
      state = next;
      for (const l of listeners) l(next);
    },
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(opts: { activity: ActivityObservation | null }) {
  const calls: string[] = [];
  const failures: unknown[] = [];
  const h = {
    calls,
    failures,
    // Swappable per test. Defaults complete immediately.
    onRefresh: (() => Promise.resolve()) as () => Promise<void>,
    onRespawn: (async () => {}) as () => Promise<void>,
    coordinator: undefined as unknown as ReturnType<typeof createRestartCoordinator>,
  };
  const hooks: RestartHooks = {
    activity: () => opts.activity,
    detach: () => calls.push('detach'),
    stopCurrent: async (reason) => {
      calls.push(`stop:${reason}`);
      return { sessionId: 'sess-1' };
    },
    refreshInstructions: () => {
      calls.push('refresh');
      return h.onRefresh();
    },
    refreshSecrets: async () => {
      calls.push('refresh-secrets');
    },
    respawn: async (cycle) => {
      calls.push(`respawn:${cycle.reasons.join('+')}`);
      return h.onRespawn();
    },
    log: silentLogger(),
  };
  h.coordinator = createRestartCoordinator(hooks, {
    onFailure: (err) => failures.push(err),
    delay: async () => {
      calls.push('grace');
    },
  });
  return h;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const respawns = (calls: string[]) => calls.filter((c) => c.startsWith('respawn')).length;

/** Settle repeatedly so follow-up cycles launched from `finally` finish too. */
async function settleFully(h: ReturnType<typeof harness>): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await h.coordinator.settled();
    await tick();
  }
}

describe('drain ordering', () => {
  it('waits for idle, then detaches BEFORE stopping, refetches, respawns cold with the reason', async () => {
    const activity = fakeActivity('working');
    const h = harness({ activity: activity.observation });

    h.coordinator.request('instructions');
    await tick();
    // Mid-turn: nothing has happened yet — the drain is the point.
    expect(h.calls).toEqual([]);

    activity.set('idle');
    await settleFully(h);

    expect(h.calls).toEqual([
      'detach',
      'stop:restart-instructions',
      'refresh',
      'refresh-secrets',
      'respawn:instructions',
    ]);
  });

  it('proceeds immediately when already idle', async () => {
    const h = harness({ activity: fakeActivity('idle').observation });
    h.coordinator.request('instructions');
    await settleFully(h);
    expect(h.calls[0]).toBe('detach');
    expect(respawns(h.calls)).toBe(1);
  });

  it('restarts after a grace period when there is no activity signal', async () => {
    const h = harness({ activity: null });
    h.coordinator.request('instructions');
    await settleFully(h);
    expect(h.calls).toEqual([
      'grace',
      'detach',
      'stop:restart-instructions',
      'refresh',
      'refresh-secrets',
      'respawn:instructions',
    ]);
  });
});

describe('coalescing', () => {
  it('folds requests arriving before the refetch into the running cycle', async () => {
    const h = harness({ activity: fakeActivity('idle').observation });
    const gate = deferred();
    h.onRefresh = () => gate.promise;
    h.coordinator.request('instructions');
    await tick();
    // The cycle is at the held-open refresh: these edits are covered
    // by the fetch that has not resolved yet.
    h.coordinator.request('instructions');
    h.coordinator.request('instructions');
    gate.resolve();
    await settleFully(h);
    expect(respawns(h.calls)).toBe(1);
  });

  it('re-arms one more cycle for an edit landing after the refetch', async () => {
    const h = harness({ activity: fakeActivity('idle').observation });
    const gate = deferred();
    h.onRespawn = () => gate.promise;
    h.coordinator.request('instructions');
    await tick();
    // Refetch done, respawn held open: this edit missed the fetch and
    // must NOT be marked applied by this cycle.
    h.coordinator.request('instructions');
    h.onRespawn = async () => {};
    gate.resolve();
    await settleFully(h);
    expect(respawns(h.calls)).toBe(2);
  });
});

describe('failure paths', () => {
  it('respawns on the cached packet when the refetch fails, and retries with another cycle', async () => {
    const h = harness({ activity: fakeActivity('idle').observation });
    let refreshCalls = 0;
    h.onRefresh = () => {
      refreshCalls++;
      // Only the first fetch fails; the retry cycle's succeeds.
      return refreshCalls === 1 ? Promise.reject(new Error('broker down')) : Promise.resolve();
    };
    h.coordinator.request('instructions');
    await settleFully(h);
    // Cycle 1 respawned despite the failed fetch (a dead session is
    // worse than a stale one); the un-applied edit re-armed a retry
    // whose fetch succeeded — two respawns total, not one, not three.
    expect(h.failures).toEqual([]);
    expect(refreshCalls).toBe(2);
    expect(respawns(h.calls)).toBe(2);
  });

  it('reports through onFailure when the respawn itself fails', async () => {
    const h = harness({ activity: fakeActivity('idle').observation });
    h.onRespawn = () => Promise.reject(new Error('spawn exploded'));
    h.coordinator.request('instructions');
    await settleFully(h);
    expect(h.failures).toHaveLength(1);
  });

  it('abandons a cycle still draining when the session closes', async () => {
    const activity = fakeActivity('working');
    const h = harness({ activity: activity.observation });
    h.coordinator.request('instructions');
    await tick();
    h.coordinator.close();
    activity.set('idle');
    await settleFully(h);
    // Drained, then noticed the close: the agent was never stopped.
    expect(h.calls).toEqual([]);
  });
});

describe('reasons', () => {
  it('carries an environment-only request as its own reason', async () => {
    const h = harness({ activity: fakeActivity('idle').observation });
    h.coordinator.request('environment');
    await settleFully(h);
    expect(h.calls.filter((c) => c.startsWith('respawn'))).toEqual(['respawn:environment']);
  });

  it('names both triggers when an edit and an environment change coalesce into one cycle', async () => {
    const h = harness({ activity: fakeActivity('idle').observation });
    const gate = deferred();
    h.onRefresh = () => gate.promise;
    h.coordinator.request('instructions');
    await tick();
    // Lands before the refetch resolves: folded in, and its reason
    // must not be lost in the fold.
    h.coordinator.request('environment');
    gate.resolve();
    await settleFully(h);
    expect(h.calls.filter((c) => c.startsWith('respawn'))).toEqual([
      'respawn:instructions+environment',
    ]);
  });

  it('attributes a request landing after the refetch to the re-armed cycle only', async () => {
    const h = harness({ activity: fakeActivity('idle').observation });
    const gate = deferred();
    h.onRespawn = () => gate.promise;
    h.coordinator.request('instructions');
    await tick();
    // The snapshot was taken before the respawn was held open; this
    // reason belongs to the next cycle, not the one in flight.
    h.coordinator.request('environment');
    h.onRespawn = async () => {};
    gate.resolve();
    await settleFully(h);
    expect(h.calls.filter((c) => c.startsWith('respawn'))).toEqual([
      'respawn:instructions',
      'respawn:environment',
    ]);
  });
});
