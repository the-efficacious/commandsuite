/**
 * The context-control coordinator, exercised through controllable
 * hooks.
 *
 * THE CONTRACT UNDER TEST IS THE ACKNOWLEDGEMENT. A broker that
 * pushes a compaction request and reports success has asserted
 * something it did not observe, so the load-bearing property is not
 * "compaction happens" — it is that every terminal state produces
 * exactly one outcome event, that the four outcomes stay distinct, and
 * that a refusal carries the framework's reason rather than being
 * flattened into a failure.
 *
 * `unsupported` vs `declined` is the distinction most at risk of being
 * quietly collapsed: one says retrying cannot help, the other says the
 * agent was asked and said no. A test suite that only checked "not
 * applied" would pass against an implementation that lost that.
 */

import type { ActivityContextControl } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import type { CompactAttempt, ContextControlHooks } from '../../src/runtime/context-control.js';
import { createContextControlCoordinator } from '../../src/runtime/context-control.js';
import type { ContextControlEvent } from '../../src/runtime/forwarder.js';
import type { ActivityObservation } from '../../src/runtime/restart.js';

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
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function harness(
  opts: {
    activity?: ActivityObservation | null;
    compact?: (reason: string | undefined) => Promise<CompactAttempt>;
    clear?: (reason: string) => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const acks: ActivityContextControl[] = [];
  // `'activity' in opts` and not `??`: a test passing an explicit
  // `null` is asking for the no-capture path, and a nullish default
  // would silently give it an idle signal instead — the assertion
  // would then pass against an implementation that had no grace path
  // at all.
  const activity: ActivityObservation | null =
    'activity' in opts ? (opts.activity ?? null) : fakeActivity('idle').observation;
  const hooks: ContextControlHooks = {
    activity: () => activity,
    compact: async (reason) => {
      calls.push(`compact:${reason ?? '-'}`);
      return (
        opts.compact?.(reason) ??
        Promise.resolve<CompactAttempt>({ supported: true, applied: true })
      );
    },
    clear: async (reason) => {
      calls.push(`clear:${reason}`);
      await opts.clear?.(reason);
    },
    report: (event) => {
      acks.push(event);
    },
    gate: (fn) => fn(),
    log: () => {},
    now: () => 1_700_000_000_000,
  };
  return {
    calls,
    acks,
    coordinator: createContextControlCoordinator(hooks, {
      delay: async () => {
        calls.push('grace');
      },
    }),
  };
}

function control(over: Partial<ContextControlEvent> = {}): ContextControlEvent {
  return {
    requestId: 'req-1',
    verb: 'compact',
    target: 'me',
    requestedBy: 'director',
    ...over,
  };
}

describe('acknowledgement', () => {
  it('acks `applied` with the measured token delta when the framework reports one', async () => {
    const h = harness({
      compact: async () => ({
        supported: true,
        applied: true,
        tokensBefore: 25_920,
        tokensAfter: 2_091,
      }),
    });

    await h.coordinator.handle(control());

    expect(h.acks).toHaveLength(1);
    // Assert the WHOLE event, not that a field appeared — a partially
    // populated ack is exactly the degradation a presence check misses.
    expect(h.acks[0]).toEqual({
      kind: 'context_control',
      ts: 1_700_000_000_000,
      requestId: 'req-1',
      verb: 'compact',
      outcome: 'applied',
      requestedBy: 'director',
      tokens: { before: 25_920, after: 2_091 },
    });
  });

  it('acks `applied` WITHOUT a tokens field when the framework measured nothing', async () => {
    const h = harness({ compact: async () => ({ supported: true, applied: true }) });

    await h.coordinator.handle(control());

    // Absence of the measurement is not absence of the effect, and a
    // fabricated zero would read as "compacted to nothing".
    expect(h.acks[0]?.outcome).toBe('applied');
    expect(h.acks[0]).not.toHaveProperty('tokens');
  });

  it('acks `declined` carrying the framework reason verbatim', async () => {
    const h = harness({
      compact: async () => ({
        supported: true,
        applied: false,
        detail: 'Not enough messages to compact.',
      }),
    });

    await h.coordinator.handle(control());

    expect(h.acks[0]?.outcome).toBe('declined');
    expect(h.acks[0]?.detail).toBe('Not enough messages to compact.');
  });

  it('keeps `unsupported` distinct from `declined`', async () => {
    const h = harness({
      compact: async () => ({ supported: false, detail: 'the codex runner has no compaction op' }),
    });

    await h.coordinator.handle(control());

    // The difference is actionable: `unsupported` means stop asking,
    // `declined` means the ask was heard. Collapsing them loses that.
    expect(h.acks[0]?.outcome).toBe('unsupported');
    expect(h.acks[0]?.detail).toBe('the codex runner has no compaction op');
  });

  it('acks `failed` when the actuator throws, and does not rethrow', async () => {
    const h = harness({
      clear: async () => {
        throw new Error('respawn exploded');
      },
    });

    await expect(h.coordinator.handle(control({ verb: 'clear' }))).resolves.toBeUndefined();

    expect(h.acks[0]?.outcome).toBe('failed');
    expect(h.acks[0]?.detail).toBe('respawn exploded');
  });

  it('emits exactly ONE ack per request on every path', async () => {
    const outcomes: CompactAttempt[] = [
      { supported: true, applied: true },
      { supported: true, applied: false, detail: 'no' },
      { supported: false, detail: 'nope' },
    ];
    for (const [i, attempt] of outcomes.entries()) {
      const h = harness({ compact: async () => attempt });
      await h.coordinator.handle(control({ requestId: `req-${i}` }));
      expect(h.acks).toHaveLength(1);
      expect(h.acks[0]?.requestId).toBe(`req-${i}`);
    }
  });

  it('correlates the ack to the request that produced it', async () => {
    const h = harness();
    await h.coordinator.handle(control({ requestId: 'abc-123', requestedBy: 'cora' }));
    // Without the id the broker can execute a control and never close
    // it out; without the requester it cannot say who interrupted whom.
    expect(h.acks[0]?.requestId).toBe('abc-123');
    expect(h.acks[0]?.requestedBy).toBe('cora');
  });
});

describe('clear', () => {
  it('waits for idle before swapping, and passes the requester through', async () => {
    const activity = fakeActivity('working');
    const h = harness({ activity: activity.observation });

    const done = h.coordinator.handle(
      control({ verb: 'clear', reason: 'context is full', requestedBy: 'cora' }),
    );
    await new Promise((r) => setImmediate(r));
    // Mid-turn: the drain is the point — nothing has swapped yet.
    expect(h.calls).toEqual([]);

    activity.set('idle');
    await done;

    expect(h.calls).toEqual(['clear:context-clear (cora): context is full']);
    expect(h.acks[0]?.outcome).toBe('applied');
  });

  it('clears after a grace when there is no activity signal', async () => {
    const h = harness({ activity: null });

    await h.coordinator.handle(control({ verb: 'clear' }));

    // "Never" would silently disable the verb exactly where nobody is
    // watching (`--no-trace`), so the grace is the deliberate trade.
    expect(h.calls).toEqual(['grace', 'clear:context-clear (director)']);
    expect(h.acks[0]?.outcome).toBe('applied');
  });

  it('runs `clear` under the shared lifecycle lock and `compact` outside it', async () => {
    const gated: string[] = [];
    const acks: ActivityContextControl[] = [];
    const coordinator = createContextControlCoordinator({
      activity: () => fakeActivity('idle').observation,
      compact: async () => ({ supported: true, applied: true }),
      clear: async () => {},
      report: (e) => acks.push(e),
      gate: async (fn) => {
        gated.push('enter');
        const out = await fn();
        gated.push('exit');
        return out;
      },
      log: () => {},
    });

    await coordinator.handle(control({ verb: 'compact' }));
    // A compaction can take 20s+; holding the process lock across it
    // would stall an unrelated instruction-restart for no benefit.
    expect(gated).toEqual([]);

    await coordinator.handle(control({ verb: 'clear', requestId: 'req-2' }));
    expect(gated).toEqual(['enter', 'exit']);
  });
});

describe('serialization and shutdown', () => {
  it('runs queued controls one at a time rather than interleaving swaps', async () => {
    const order: string[] = [];
    const first = deferred();
    let n = 0;
    const acks: ActivityContextControl[] = [];
    const coordinator = createContextControlCoordinator({
      activity: () => fakeActivity('idle').observation,
      compact: async () => ({ supported: true, applied: true }),
      clear: async () => {
        const id = ++n;
        order.push(`start:${id}`);
        if (id === 1) await first.promise;
        order.push(`end:${id}`);
      },
      report: (e) => acks.push(e),
      gate: (fn) => fn(),
      log: () => {},
    });

    const a = coordinator.handle(control({ requestId: 'r1', verb: 'clear' }));
    const b = coordinator.handle(control({ requestId: 'r2', verb: 'clear' }));
    await new Promise((r) => setImmediate(r));

    // The second must not have started while the first is mid-swap.
    expect(order).toEqual(['start:1']);
    first.resolve();
    await Promise.all([a, b]);

    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
    // Both still answered — serializing must not drop a request.
    expect(acks.map((e) => e.requestId)).toEqual(['r1', 'r2']);
  });

  it('answers `failed` instead of vanishing once closed', async () => {
    const h = harness();
    h.coordinator.close();

    await h.coordinator.handle(control({ requestId: 'late' }));

    // A dropped control is a request the broker never resolves. Even
    // at teardown it gets an outcome.
    expect(h.acks).toHaveLength(1);
    expect(h.acks[0]?.outcome).toBe('failed');
    expect(h.acks[0]?.requestId).toBe('late');
    expect(h.calls).toEqual([]);
  });

  it('settles when no control is in flight', async () => {
    const h = harness();
    await expect(h.coordinator.settled()).resolves.toBeUndefined();
    await h.coordinator.handle(control());
    await expect(h.coordinator.settled()).resolves.toBeUndefined();
  });
});
