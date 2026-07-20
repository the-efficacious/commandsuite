/**
 * Activity-reporter tests.
 *
 * Pins:
 *   - POSTs the `state` once per transition (idle → working → blocked → idle).
 *   - Heartbeats the current non-idle state on the configured interval.
 *   - Stops heartbeating when the state returns to idle.
 *   - Final `idle` clear on signal abort.
 *   - Swallows POST failures — presence is best-effort.
 */

import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { ActivityState } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startActivityReporter } from '../../src/runtime/busy-reporter.js';
import { createActivitySignal } from '../../src/runtime/trace/busy.js';

describe('startActivityReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSTs the state once per transition (idle → working → idle)', async () => {
    const setActivity = vi.fn(async (_: { state: ActivityState }) => {});
    const broker = { setActivity } as unknown as BrokerClient;
    const activity = createActivitySignal();
    const ac = new AbortController();
    startActivityReporter({ brokerClient: broker, activity, signal: ac.signal, log: () => {} });
    // Initial-state fire from subscribe — equals current state, idle.
    expect(setActivity).toHaveBeenCalledTimes(1);
    expect(setActivity).toHaveBeenLastCalledWith({ state: 'idle' });

    const h = activity.start();
    expect(setActivity).toHaveBeenCalledTimes(2);
    expect(setActivity).toHaveBeenLastCalledWith({ state: 'working' });

    h.finish();
    expect(setActivity).toHaveBeenCalledTimes(3);
    expect(setActivity).toHaveBeenLastCalledWith({ state: 'idle' });

    ac.abort();
  });

  it('reports the blocked state on transition', async () => {
    const setActivity = vi.fn(async (_: { state: ActivityState }) => {});
    const broker = { setActivity } as unknown as BrokerClient;
    const activity = createActivitySignal();
    const ac = new AbortController();
    startActivityReporter({ brokerClient: broker, activity, signal: ac.signal, log: () => {} });
    setActivity.mockClear();

    activity.setBlocked(true);
    expect(setActivity).toHaveBeenLastCalledWith({ state: 'blocked' });

    activity.setBlocked(false);
    expect(setActivity).toHaveBeenLastCalledWith({ state: 'idle' });

    ac.abort();
  });

  it('heartbeats the current non-idle state every heartbeatMs', async () => {
    const setActivity = vi.fn(async (_: { state: ActivityState }) => {});
    const broker = { setActivity } as unknown as BrokerClient;
    const activity = createActivitySignal();
    const ac = new AbortController();
    startActivityReporter({
      brokerClient: broker,
      activity,
      signal: ac.signal,
      log: () => {},
      heartbeatMs: 1_000,
    });
    setActivity.mockClear();

    activity.start();
    expect(setActivity).toHaveBeenCalledTimes(1); // transition

    await vi.advanceTimersByTimeAsync(1_000);
    expect(setActivity).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(setActivity).toHaveBeenCalledTimes(3);
    expect(setActivity).toHaveBeenLastCalledWith({ state: 'working' });

    ac.abort();
  });

  it('keeps heartbeating while blocked', async () => {
    const setActivity = vi.fn(async (_: { state: ActivityState }) => {});
    const broker = { setActivity } as unknown as BrokerClient;
    const activity = createActivitySignal();
    const ac = new AbortController();
    startActivityReporter({
      brokerClient: broker,
      activity,
      signal: ac.signal,
      log: () => {},
      heartbeatMs: 1_000,
    });
    activity.setBlocked(true);
    setActivity.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(setActivity).toHaveBeenLastCalledWith({ state: 'blocked' });

    ac.abort();
  });

  it('stops heartbeating after returning to idle', async () => {
    const setActivity = vi.fn(async (_: { state: ActivityState }) => {});
    const broker = { setActivity } as unknown as BrokerClient;
    const activity = createActivitySignal();
    const ac = new AbortController();
    startActivityReporter({
      brokerClient: broker,
      activity,
      signal: ac.signal,
      log: () => {},
      heartbeatMs: 1_000,
    });
    setActivity.mockClear();

    const h = activity.start();
    await vi.advanceTimersByTimeAsync(1_000);
    h.finish();
    setActivity.mockClear();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(setActivity).not.toHaveBeenCalled();

    ac.abort();
  });

  it('on abort, posts a final `idle` to clear presence', async () => {
    const setActivity = vi.fn(async (_: { state: ActivityState }) => {});
    const broker = { setActivity } as unknown as BrokerClient;
    const activity = createActivitySignal();
    const ac = new AbortController();
    startActivityReporter({
      brokerClient: broker,
      activity,
      signal: ac.signal,
      log: () => {},
      heartbeatMs: 1_000,
    });
    activity.start();
    setActivity.mockClear();

    ac.abort();
    expect(setActivity).toHaveBeenCalledWith({ state: 'idle' });
  });

  it('does not crash when setActivity rejects — logs at debug and keeps going', async () => {
    const setActivity = vi.fn(async () => {
      throw new Error('network');
    });
    const broker = { setActivity } as unknown as BrokerClient;
    const log = vi.fn();
    const activity = createActivitySignal();
    const ac = new AbortController();
    startActivityReporter({
      brokerClient: broker,
      activity,
      signal: ac.signal,
      log,
      heartbeatMs: 1_000,
    });
    activity.start();
    // Let the rejected promise settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toMatch(/setActivity failed/);

    ac.abort();
  });
});
