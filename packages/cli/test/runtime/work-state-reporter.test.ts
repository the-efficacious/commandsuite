/**
 * Work-state-reporter tests.
 *
 * Pins:
 *   - Reports through `Client.setWorkState`, the D6 method that targets
 *     `POST /presence/work-state`. The deprecated `setActivity` still
 *     exists on the client for external callers; the runner must not be
 *     one of them, or shipping the rename would leave its own runner
 *     the stale client the deprecation warning is hunting for.
 *   - POSTs the `state` once per transition (idle → working → blocked → idle).
 *   - Heartbeats the current non-idle state on the configured interval.
 *   - Stops heartbeating when the state returns to idle.
 *   - Final `idle` clear on signal abort.
 *   - Swallows POST failures — presence is best-effort.
 */

import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { WorkState } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkStateSignal } from '../../src/runtime/trace/work-state.js';
import { startWorkStateReporter } from '../../src/runtime/work-state-reporter.js';
import { recordingLogger, silentLogger } from '../helpers/logger.js';

describe('startWorkStateReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports through setWorkState and never the deprecated setActivity', async () => {
    // Both methods exist on the client during the compat window and
    // both reach the broker, so a reporter wired to the old one would
    // pass every state-machine test in this file. This is the only
    // assertion that says which of the two the runner actually calls —
    // and it asserts the old one was NOT called, alongside the new one
    // carrying the real value, so "neither was called" cannot pass it.
    const setWorkState = vi.fn(async (_: { state: WorkState }) => {});
    const setActivity = vi.fn(async (_: { state: WorkState }) => {});
    const broker = { setWorkState, setActivity } as unknown as BrokerClient;
    const workState = createWorkStateSignal();
    const ac = new AbortController();
    startWorkStateReporter({
      brokerClient: broker,
      workState,
      signal: ac.signal,
      logger: silentLogger(),
    });
    const handle = workState.start('turn_active');
    expect(setWorkState).toHaveBeenLastCalledWith({ state: 'working' });
    expect(setActivity).not.toHaveBeenCalled();
    handle.finish();
    ac.abort();
  });

  it('POSTs the state once per transition (idle → working → idle)', async () => {
    const setWorkState = vi.fn(async (_: { state: WorkState }) => {});
    const broker = { setWorkState } as unknown as BrokerClient;
    const workState = createWorkStateSignal();
    const ac = new AbortController();
    startWorkStateReporter({
      brokerClient: broker,
      workState,
      signal: ac.signal,
      logger: silentLogger(),
    });
    // Initial-state fire from subscribe — equals current state, idle.
    expect(setWorkState).toHaveBeenCalledTimes(1);
    expect(setWorkState).toHaveBeenLastCalledWith({ state: 'idle' });

    const h = workState.start();
    expect(setWorkState).toHaveBeenCalledTimes(2);
    expect(setWorkState).toHaveBeenLastCalledWith({ state: 'working' });

    h.finish();
    expect(setWorkState).toHaveBeenCalledTimes(3);
    expect(setWorkState).toHaveBeenLastCalledWith({ state: 'idle' });

    ac.abort();
  });

  it('reports the blocked state on transition', async () => {
    const setWorkState = vi.fn(async (_: { state: WorkState }) => {});
    const broker = { setWorkState } as unknown as BrokerClient;
    const workState = createWorkStateSignal();
    const ac = new AbortController();
    startWorkStateReporter({
      brokerClient: broker,
      workState,
      signal: ac.signal,
      logger: silentLogger(),
    });
    setWorkState.mockClear();

    workState.setBlocked(true);
    expect(setWorkState).toHaveBeenLastCalledWith({ state: 'blocked' });

    workState.setBlocked(false);
    expect(setWorkState).toHaveBeenLastCalledWith({ state: 'idle' });

    ac.abort();
  });

  it('heartbeats the current non-idle state every heartbeatMs', async () => {
    const setWorkState = vi.fn(async (_: { state: WorkState }) => {});
    const broker = { setWorkState } as unknown as BrokerClient;
    const workState = createWorkStateSignal();
    const ac = new AbortController();
    startWorkStateReporter({
      brokerClient: broker,
      workState,
      signal: ac.signal,
      logger: silentLogger(),
      heartbeatMs: 1_000,
    });
    setWorkState.mockClear();

    workState.start();
    expect(setWorkState).toHaveBeenCalledTimes(1); // transition

    await vi.advanceTimersByTimeAsync(1_000);
    expect(setWorkState).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(setWorkState).toHaveBeenCalledTimes(3);
    expect(setWorkState).toHaveBeenLastCalledWith({ state: 'working' });

    ac.abort();
  });

  it('keeps heartbeating while blocked', async () => {
    const setWorkState = vi.fn(async (_: { state: WorkState }) => {});
    const broker = { setWorkState } as unknown as BrokerClient;
    const workState = createWorkStateSignal();
    const ac = new AbortController();
    startWorkStateReporter({
      brokerClient: broker,
      workState,
      signal: ac.signal,
      logger: silentLogger(),
      heartbeatMs: 1_000,
    });
    workState.setBlocked(true);
    setWorkState.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(setWorkState).toHaveBeenLastCalledWith({ state: 'blocked' });

    ac.abort();
  });

  it('stops heartbeating after returning to idle', async () => {
    const setWorkState = vi.fn(async (_: { state: WorkState }) => {});
    const broker = { setWorkState } as unknown as BrokerClient;
    const workState = createWorkStateSignal();
    const ac = new AbortController();
    startWorkStateReporter({
      brokerClient: broker,
      workState,
      signal: ac.signal,
      logger: silentLogger(),
      heartbeatMs: 1_000,
    });
    setWorkState.mockClear();

    const h = workState.start();
    await vi.advanceTimersByTimeAsync(1_000);
    h.finish();
    setWorkState.mockClear();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(setWorkState).not.toHaveBeenCalled();

    ac.abort();
  });

  it('on abort, posts a final `idle` to clear presence', async () => {
    const setWorkState = vi.fn(async (_: { state: WorkState }) => {});
    const broker = { setWorkState } as unknown as BrokerClient;
    const workState = createWorkStateSignal();
    const ac = new AbortController();
    startWorkStateReporter({
      brokerClient: broker,
      workState,
      signal: ac.signal,
      logger: silentLogger(),
      heartbeatMs: 1_000,
    });
    workState.start();
    setWorkState.mockClear();

    ac.abort();
    expect(setWorkState).toHaveBeenCalledWith({ state: 'idle' });
  });

  it('does not crash when setWorkState rejects — logs at debug and keeps going', async () => {
    const setWorkState = vi.fn(async () => {
      throw new Error('network');
    });
    const broker = { setWorkState } as unknown as BrokerClient;
    const rec = recordingLogger();
    const workState = createWorkStateSignal();
    const ac = new AbortController();
    startWorkStateReporter({
      brokerClient: broker,
      workState,
      signal: ac.signal,
      logger: rec.logger,
      heartbeatMs: 1_000,
    });
    workState.start();
    // Let the rejected promise settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.records.length).toBeGreaterThan(0);
    expect(rec.messages()[0]).toMatch(/setWorkState failed/);

    ac.abort();
  });
});
