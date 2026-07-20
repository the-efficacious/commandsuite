/**
 * `ActivitySignal` tests.
 *
 * Pins the 3-state contract (idle / working / blocked): subscribers see
 * one notification per STATE transition regardless of how many
 * concurrent in-flight handles are active, `blocked` wins over
 * `working`, and the legacy `busy` mirror stays `state === 'working'`.
 * Reentrant notifications would cause the runner's POST
 * /presence/activity traffic to thrash on parallel tool fan-outs.
 */

import type { ActivityState } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActivitySignal, DEFAULT_MAX_AGE_MS } from '../../src/runtime/trace/busy.js';

describe('createActivitySignal', () => {
  it('starts idle (count=0, busy=false, blocked=false, state=idle)', () => {
    const b = createActivitySignal();
    expect(b.count).toBe(0);
    expect(b.busy).toBe(false);
    expect(b.blocked).toBe(false);
    expect(b.state()).toBe('idle');
  });

  it('flips to working on the first start, back to idle on the matching finish', () => {
    const b = createActivitySignal();
    const observed: ActivityState[] = [];
    b.subscribe((s) => observed.push(s));
    const h = b.start();
    expect(b.state()).toBe('working');
    expect(b.busy).toBe(true);
    h.finish();
    expect(b.state()).toBe('idle');
    // Initial fire on subscribe (idle) + transition to working + back.
    expect(observed).toEqual(['idle', 'working', 'idle']);
  });

  it('does not re-fire on increments while already working (regression)', () => {
    const b = createActivitySignal();
    const listener = vi.fn();
    b.subscribe(listener);
    listener.mockClear();

    const h1 = b.start();
    const h2 = b.start();
    const h3 = b.start();
    expect(listener).toHaveBeenCalledTimes(1); // only the idle→working transition
    expect(listener).toHaveBeenLastCalledWith('working');

    h2.finish();
    h3.finish();
    expect(listener).toHaveBeenCalledTimes(1); // count still > 0; no fire
    h1.finish();
    expect(listener).toHaveBeenCalledTimes(2); // working→idle transition
    expect(listener).toHaveBeenLastCalledWith('idle');
  });

  it('finish() is idempotent — double-finishing one handle does not corrupt count', () => {
    const b = createActivitySignal();
    const h = b.start();
    expect(b.count).toBe(1);
    h.finish();
    h.finish();
    h.finish();
    expect(b.count).toBe(0);
    expect(b.state()).toBe('idle');
  });

  it('fires the current state on subscribe even mid-burst', () => {
    const b = createActivitySignal();
    b.start();
    const observed: ActivityState[] = [];
    b.subscribe((s) => observed.push(s));
    expect(observed).toEqual(['working']);
  });

  it('isolates one listener throwing from the others', () => {
    const b = createActivitySignal();
    const good = vi.fn();
    b.subscribe(() => {
      throw new Error('boom');
    });
    b.subscribe(good);
    good.mockClear();
    b.start();
    expect(good).toHaveBeenCalledWith('working');
  });

  it('supports unsubscribe', () => {
    const b = createActivitySignal();
    const listener = vi.fn();
    const unsubscribe = b.subscribe(listener);
    listener.mockClear();
    unsubscribe();
    b.start();
    expect(listener).not.toHaveBeenCalled();
  });

  it('tracks per-source counts independently', () => {
    const b = createActivitySignal();
    const turn = b.start('turn_active');
    const tool1 = b.start('tool_inflight');
    const tool2 = b.start('tool_inflight');
    expect(b.getSourceCounts()).toEqual({ turn_active: 1, tool_inflight: 2 });
    expect(b.count).toBe(3);
    expect(b.state()).toBe('working');

    turn.finish();
    expect(b.getSourceCounts()).toEqual({ turn_active: 0, tool_inflight: 2 });
    // Still working — tool_inflight is non-zero.
    expect(b.state()).toBe('working');

    tool1.finish();
    tool2.finish();
    expect(b.getSourceCounts()).toEqual({ turn_active: 0, tool_inflight: 0 });
    expect(b.state()).toBe('idle');
  });

  it('emits only one idle→working transition across mixed sources', () => {
    const b = createActivitySignal();
    const listener = vi.fn();
    b.subscribe(listener);
    listener.mockClear();

    const turn = b.start('turn_active');
    const tool = b.start('tool_inflight');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith('working');

    turn.finish();
    // tool_inflight still in flight — no transition.
    expect(listener).toHaveBeenCalledTimes(1);

    tool.finish();
    // Now all sources drained — transition fires.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith('idle');
  });

  it("defaults to 'turn_active' when start() is called without a source", () => {
    const b = createActivitySignal();
    const h = b.start();
    expect(b.getSourceCounts()).toEqual({ turn_active: 1, tool_inflight: 0 });
    h.finish();
    expect(b.getSourceCounts()).toEqual({ turn_active: 0, tool_inflight: 0 });
  });

  it('a wedged source does not poison drain of the other', () => {
    // Regression: if one feeder forgets to decrement, the other should
    // still drain on its own track. The overall state stays `working`
    // (correct — there IS in-flight work) but `getSourceCounts()` makes
    // the culprit diagnosable.
    const b = createActivitySignal();
    b.start('turn_active', { maxAgeMs: Infinity }); // intentionally not finished
    const tool = b.start('tool_inflight');
    tool.finish();
    expect(b.state()).toBe('working');
    expect(b.getSourceCounts()).toEqual({ turn_active: 1, tool_inflight: 0 });
  });
});

describe('createActivitySignal — blocked dimension', () => {
  it('setBlocked(true) transitions idle→blocked; setBlocked(false) back to idle', () => {
    const b = createActivitySignal();
    const observed: ActivityState[] = [];
    b.subscribe((s) => observed.push(s));
    b.setBlocked(true);
    expect(b.state()).toBe('blocked');
    expect(b.blocked).toBe(true);
    expect(b.busy).toBe(false);
    b.setBlocked(false);
    expect(b.state()).toBe('idle');
    expect(observed).toEqual(['idle', 'blocked', 'idle']);
  });

  it('blocked wins over working (priority blocked > working > idle)', () => {
    const b = createActivitySignal();
    const observed: ActivityState[] = [];
    b.subscribe((s) => observed.push(s));
    const h = b.start('turn_active');
    expect(b.state()).toBe('working');
    b.setBlocked(true);
    // In-flight work remains, but blocked wins.
    expect(b.count).toBe(1);
    expect(b.state()).toBe('blocked');
    expect(b.busy).toBe(false);
    b.setBlocked(false);
    // Work still in flight → back to working, not idle.
    expect(b.state()).toBe('working');
    h.finish();
    expect(b.state()).toBe('idle');
    expect(observed).toEqual(['idle', 'working', 'blocked', 'working', 'idle']);
  });

  it('does not re-fire when setBlocked repeats the current value', () => {
    const b = createActivitySignal();
    const listener = vi.fn();
    b.subscribe(listener);
    listener.mockClear();
    b.setBlocked(true);
    b.setBlocked(true);
    expect(listener).toHaveBeenCalledTimes(1); // only the first
    b.setBlocked(false);
    b.setBlocked(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('starting work while blocked does not change the state (blocked wins)', () => {
    const b = createActivitySignal();
    const listener = vi.fn();
    b.subscribe(listener);
    b.setBlocked(true);
    listener.mockClear();
    const h = b.start('tool_inflight');
    expect(b.state()).toBe('blocked');
    expect(listener).not.toHaveBeenCalled();
    h.finish();
    // Still blocked after the work drains.
    expect(b.state()).toBe('blocked');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createActivitySignal — handle max-age safety net', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-finishes a handle that exceeds its max-age and emits the idle transition', () => {
    const log = vi.fn();
    const b = createActivitySignal({ log });
    const listener = vi.fn();
    b.subscribe(listener);
    listener.mockClear();
    log.mockClear();

    b.start('turn_active', { maxAgeMs: 1000 });
    expect(b.state()).toBe('working');
    expect(listener).toHaveBeenCalledWith('working');

    vi.advanceTimersByTime(999);
    expect(b.state()).toBe('working'); // not yet

    vi.advanceTimersByTime(2);
    expect(b.state()).toBe('idle');
    expect(listener).toHaveBeenLastCalledWith('idle');
    // Log carries the diagnostic context.
    expect(log).toHaveBeenCalledWith(
      'activity: handle auto-finished',
      expect.objectContaining({ source: 'turn_active', reason: 'timeout' }),
    );
  });

  it('respects a custom maxAgeMs even when the default is much larger', () => {
    const b = createActivitySignal();
    b.start('tool_inflight', { maxAgeMs: 50 });
    expect(b.state()).toBe('working');
    vi.advanceTimersByTime(60);
    expect(b.state()).toBe('idle');
  });

  it('Infinity maxAgeMs disables the safety net entirely', () => {
    const b = createActivitySignal();
    b.start('turn_active', { maxAgeMs: Number.POSITIVE_INFINITY });
    expect(b.state()).toBe('working');
    // Crank well past any default — handle should still be live.
    vi.advanceTimersByTime(DEFAULT_MAX_AGE_MS.turn_active * 10);
    expect(b.state()).toBe('working');
  });

  it('finish() before the deadline cancels the timer (no double-finish)', () => {
    const log = vi.fn();
    const b = createActivitySignal({ log });
    const h = b.start('turn_active', { maxAgeMs: 1000 });
    expect(b.getSourceCounts().turn_active).toBe(1);

    h.finish();
    expect(b.getSourceCounts().turn_active).toBe(0);

    vi.advanceTimersByTime(5000);
    expect(b.getSourceCounts().turn_active).toBe(0);
    expect(log).not.toHaveBeenCalledWith('activity: handle auto-finished', expect.anything());
  });

  it('applies the per-source default when maxAgeMs is omitted', () => {
    const b = createActivitySignal();
    b.start('tool_inflight');
    vi.advanceTimersByTime(DEFAULT_MAX_AGE_MS.tool_inflight - 1000);
    expect(b.state()).toBe('working');
    vi.advanceTimersByTime(2000);
    expect(b.state()).toBe('idle');
  });

  it('falls back to the default when maxAgeMs is non-positive or NaN', () => {
    const b = createActivitySignal();
    b.start('turn_active', { maxAgeMs: 0 });
    b.start('turn_active', { maxAgeMs: -100 });
    b.start('turn_active', { maxAgeMs: Number.NaN });
    expect(b.getSourceCounts().turn_active).toBe(3);

    vi.advanceTimersByTime(DEFAULT_MAX_AGE_MS.turn_active - 1);
    expect(b.getSourceCounts().turn_active).toBe(3);
    vi.advanceTimersByTime(2);
    expect(b.getSourceCounts().turn_active).toBe(0);
  });
});

describe('createActivitySignal — forceFinishAll', () => {
  it('returns 0 and emits nothing when no work is in flight', () => {
    const b = createActivitySignal();
    const listener = vi.fn();
    b.subscribe(listener);
    listener.mockClear();
    const drained = b.forceFinishAll();
    expect(drained).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('drains every live handle across both sources with a single idle transition', () => {
    const b = createActivitySignal();
    const listener = vi.fn();
    b.subscribe(listener);
    listener.mockClear();

    b.start('turn_active');
    b.start('turn_active');
    b.start('tool_inflight');
    expect(b.getSourceCounts()).toEqual({ turn_active: 2, tool_inflight: 1 });
    expect(listener).toHaveBeenCalledTimes(1); // idle→working

    const drained = b.forceFinishAll();
    expect(drained).toBe(3);
    expect(b.getSourceCounts()).toEqual({ turn_active: 0, tool_inflight: 0 });
    expect(b.state()).toBe('idle');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith('idle');
  });

  it('does not clear the blocked flag (a distinct dimension)', () => {
    const b = createActivitySignal();
    b.setBlocked(true);
    b.start('turn_active');
    // State is `blocked` (wins over working).
    expect(b.state()).toBe('blocked');
    const drained = b.forceFinishAll();
    expect(drained).toBe(1);
    // Handles drained, but blocked persists → still blocked.
    expect(b.blocked).toBe(true);
    expect(b.state()).toBe('blocked');
  });

  it('subsequent finish() on a force-finished handle is a no-op', () => {
    const b = createActivitySignal();
    const h = b.start('turn_active');
    expect(b.getSourceCounts().turn_active).toBe(1);

    b.forceFinishAll();
    expect(b.getSourceCounts().turn_active).toBe(0);

    h.finish();
    expect(b.getSourceCounts().turn_active).toBe(0);
    expect(b.state()).toBe('idle');
  });

  it('logs the drain count for diagnostics', () => {
    const log = vi.fn();
    const b = createActivitySignal({ log });
    b.start('turn_active');
    b.start('tool_inflight');
    b.forceFinishAll();
    expect(log).toHaveBeenCalledWith(
      'activity: force-finished outstanding handles',
      expect.objectContaining({ drained: 2 }),
    );
  });
});
