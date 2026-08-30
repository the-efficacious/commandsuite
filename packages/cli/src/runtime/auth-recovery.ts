import type { Logger } from 'csuite-core';
import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { ActivityAuthState } from 'csuite-sdk/types';
import { CLI_VERSION } from '../version.js';
import type { CaptureHost } from './trace/host.js';

export interface AuthRecoveryOptions {
  brokerClient: BrokerClient;
  captureHost: CaptureHost | null;
  resolveReplacementToken?: () => string | null;
  initialToken: string;
  logger: Logger;
  watchIntervalMs?: number;
}

export interface AuthRecoveryController {
  handleUnauthorized(source: 'http' | 'websocket'): void;
  close(): void;
}

/** One state machine for every outbound transport owned by a runner. */
export function createAuthRecoveryController(options: AuthRecoveryOptions): AuthRecoveryController {
  let blocked = false;
  let lastProbedToken = options.initialToken;
  let watchTimer: NodeJS.Timeout | null = null;
  let probeInFlight = false;

  const event = (state: 'blocked' | 'recovered'): ActivityAuthState => ({
    kind: 'auth_state',
    ts: Date.now(),
    state,
    status: 401,
    ...(options.captureHost?.blockedStats() ?? {
      queuedEvents: 0,
      queuedBytes: 0,
      evictedEvents: 0,
      evictedBytes: 0,
    }),
  });

  const probe = async (): Promise<void> => {
    if (!blocked || probeInFlight || !options.resolveReplacementToken) return;
    const candidate = options.resolveReplacementToken();
    if (!candidate || candidate === lastProbedToken) return;
    probeInFlight = true;
    // Advance before the network call: a rejected candidate is not retried
    // every tick. A later store change — including reverting to the last
    // successful token — earns exactly one fresh probe.
    lastProbedToken = candidate;
    options.brokerClient.replaceToken(candidate);
    options.captureHost?.replaceBrokerToken(candidate);
    try {
      await options.brokerClient.instructions({ runnerVersion: CLI_VERSION });
      options.captureHost?.enqueue(event('recovered'));
      options.captureHost?.setAuthBlocked(false);
      blocked = false;
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
      options.logger.info('authentication recovered from saved device auth');
    } catch (err) {
      options.logger.warn('replacement device auth rejected; remaining blocked', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      probeInFlight = false;
    }
  };

  const handleUnauthorized = (source: 'http' | 'websocket'): void => {
    if (!blocked) {
      blocked = true;
      options.captureHost?.setAuthBlocked(true);
      options.captureHost?.enqueueFirst(event('blocked'));
      options.logger.error('authentication blocked; outbound work retained until re-enrolment', {
        source,
        reloadable: options.resolveReplacementToken !== undefined,
      });
    }
    if (options.resolveReplacementToken && watchTimer === null) {
      watchTimer = setInterval(() => void probe(), options.watchIntervalMs ?? 1_000);
      watchTimer.unref?.();
    }
  };

  return {
    handleUnauthorized,
    close() {
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
    },
  };
}
