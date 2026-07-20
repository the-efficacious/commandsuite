/**
 * ActivityTracker tests.
 *
 * Pins the in-memory activity-state semantics (idle/working/blocked):
 *   - `report(name, 'working'|'blocked')` extends the TTL window
 *   - `report(name, 'idle')` clears the entry immediately
 *   - `getActivity` resolves to 'idle' past the TTL even if a non-idle
 *     report was the last write (the safety net for crashed runners)
 *   - `isBusy` mirrors `activity === 'working'` (blocked is NOT busy)
 *   - `forget` drops the entry
 *   - `purgeStale` is a no-op for fresh entries
 *
 * The clock is injectable so tests don't have to wait wall-clock time.
 */

import { describe, expect, it } from 'vitest';
import { ACTIVITY_TTL_MS, createActivityTracker } from '../src/activity-tracker.js';

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('createActivityTracker', () => {
  it('starts with no entries — every name reads idle / not busy', () => {
    const t = createActivityTracker(() => 1);
    expect(t.getActivity('alice')).toBe('idle');
    expect(t.isBusy('alice')).toBe(false);
    expect(t.getActivity('bob')).toBe('idle');
  });

  it('flips to working on `report(name, "working")` within the TTL window', () => {
    const clock = makeClock();
    const t = createActivityTracker(clock.now);
    t.report('alice', 'working');
    expect(t.getActivity('alice')).toBe('working');
    expect(t.isBusy('alice')).toBe(true);
    clock.advance(ACTIVITY_TTL_MS - 1);
    expect(t.getActivity('alice')).toBe('working');
  });

  it('holds blocked distinctly and reports it as NOT busy', () => {
    const clock = makeClock();
    const t = createActivityTracker(clock.now);
    t.report('alice', 'blocked');
    expect(t.getActivity('alice')).toBe('blocked');
    // blocked means "an operator should look", not "working".
    expect(t.isBusy('alice')).toBe(false);
  });

  it('clears immediately on `report(name, "idle")`', () => {
    const clock = makeClock();
    const t = createActivityTracker(clock.now);
    t.report('alice', 'working');
    t.report('alice', 'idle');
    expect(t.getActivity('alice')).toBe('idle');
    expect(t.isBusy('alice')).toBe(false);
  });

  it('transitions working → blocked → working in place', () => {
    const clock = makeClock();
    const t = createActivityTracker(clock.now);
    t.report('alice', 'working');
    expect(t.getActivity('alice')).toBe('working');
    t.report('alice', 'blocked');
    expect(t.getActivity('alice')).toBe('blocked');
    t.report('alice', 'working');
    expect(t.getActivity('alice')).toBe('working');
  });

  it('resolves to idle past the TTL even if no idle report ever arrives', () => {
    // Regression: this is the safety net. A runner that crashes mid-turn
    // would otherwise leave the member stuck "working"/"blocked" forever.
    const clock = makeClock();
    const t = createActivityTracker(clock.now);
    t.report('alice', 'working');
    clock.advance(ACTIVITY_TTL_MS + 1);
    expect(t.getActivity('alice')).toBe('idle');
    expect(t.isBusy('alice')).toBe(false);
  });

  it('refreshing with another non-idle report extends the window', () => {
    const clock = makeClock();
    const t = createActivityTracker(clock.now);
    t.report('alice', 'working');
    clock.advance(ACTIVITY_TTL_MS - 1_000);
    // Heartbeat — runner re-asserts working.
    t.report('alice', 'working');
    clock.advance(ACTIVITY_TTL_MS - 1_000);
    // Without refresh this would have lapsed; with refresh it's still live.
    expect(t.getActivity('alice')).toBe('working');
  });

  it('isolates per-name state', () => {
    const clock = makeClock();
    const t = createActivityTracker(clock.now);
    t.report('alice', 'working');
    expect(t.getActivity('alice')).toBe('working');
    expect(t.getActivity('bob')).toBe('idle');
    t.report('bob', 'blocked');
    t.report('alice', 'idle');
    expect(t.getActivity('alice')).toBe('idle');
    expect(t.getActivity('bob')).toBe('blocked');
  });

  it('forget() drops the entry', () => {
    const t = createActivityTracker(() => 1);
    t.report('alice', 'working');
    t.forget('alice');
    expect(t.getActivity('alice')).toBe('idle');
  });

  it('purgeStale() removes only expired entries', () => {
    const clock = makeClock();
    const t = createActivityTracker(clock.now);
    t.report('alice', 'working');
    clock.advance(ACTIVITY_TTL_MS / 2);
    t.report('bob', 'blocked');
    clock.advance(ACTIVITY_TTL_MS / 2 + 1); // alice has lapsed, bob hasn't
    t.purgeStale();
    expect(t.getActivity('alice')).toBe('idle');
    expect(t.getActivity('bob')).toBe('blocked');
  });
});
