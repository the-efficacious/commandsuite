import type { Logger } from 'csuite-core';
import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { ActivityAuthState } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthRecoveryController } from '../../src/runtime/auth-recovery.js';
import type { CaptureHost } from '../../src/runtime/trace/host.js';
import { silentLogger } from '../helpers/logger.js';

describe('runner authentication recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces HTTP and WebSocket 401s into one blocked state and recovers only after a good probe', async () => {
    let saved = 'old';
    const events: ActivityAuthState[] = [];
    const capture = {
      setAuthBlocked: vi.fn(),
      enqueueFirst: vi.fn((event: ActivityAuthState) => events.unshift(event)),
      enqueue: vi.fn((event: ActivityAuthState) => events.push(event)),
      blockedStats: vi.fn(() => ({
        queuedEvents: 3,
        queuedBytes: 300,
        evictedEvents: 0,
        evictedBytes: 0,
      })),
      replaceBrokerToken: vi.fn(),
    } as unknown as CaptureHost;
    const client = {
      replaceToken: vi.fn(),
      instructions: vi.fn().mockRejectedValueOnce(new Error('401 stale')).mockResolvedValueOnce({}),
    } as unknown as BrokerClient;
    const controller = createAuthRecoveryController({
      brokerClient: client,
      captureHost: capture,
      initialToken: 'old',
      resolveReplacementToken: () => saved,
      logger: silentLogger() as Logger,
      watchIntervalMs: 10,
    });

    controller.handleUnauthorized('http');
    controller.handleUnauthorized('websocket');
    expect(capture.setAuthBlocked).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.state)).toEqual(['blocked']);

    saved = 'stale';
    await vi.advanceTimersByTimeAsync(10);
    expect(capture.setAuthBlocked).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.state)).toEqual(['blocked']);
    await vi.advanceTimersByTimeAsync(20);
    expect(client.instructions).toHaveBeenCalledTimes(1);

    // The SDK currently holds the rejected candidate. Reverting the store to
    // the original credential is still a distinct store change and must be
    // probed rather than skipped as "already active".
    saved = 'old';
    await vi.advanceTimersByTimeAsync(10);
    expect(client.replaceToken).toHaveBeenLastCalledWith('old');
    expect(capture.replaceBrokerToken).toHaveBeenLastCalledWith('old');
    expect(events.map((event) => event.state)).toEqual(['blocked', 'recovered']);
    expect(capture.setAuthBlocked).toHaveBeenLastCalledWith(false);
    controller.close();
  });
});
