/**
 * Pushes the agent's live ACTIVITY STATE (idle / working / blocked) from
 * the capture host's activity signal up to the broker via
 * `POST /presence/activity`.
 *
 * Behavior:
 *   - On every state transition (idle↔working↔blocked), POST the new
 *     `state` immediately. `busy` is left for the server to derive
 *     (= `state === 'working'`).
 *   - While NON-idle (working or blocked), re-POST the current state
 *     every `heartbeatMs` (default 10s) so the server-side TTL (30s)
 *     stays fresh and doesn't reset the member to idle mid-turn. If the
 *     runner dies the TTL lapses on its own.
 *   - When idle, no traffic — the server treats absence as idle, so
 *     there's nothing to remind it of.
 *
 * POST failures are logged at debug and swallowed: presence is a UI
 * nicety, not an invariant. The next transition or heartbeat retries,
 * and if the runner is offline entirely the broker won't see anything
 * until it reconnects.
 */

import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { ActivityState } from 'csuite-sdk/types';
import type { ActivitySignal } from './trace/busy.js';

export interface ActivityReporterOptions {
  brokerClient: BrokerClient;
  activity: ActivitySignal;
  /** Cancellation. When aborted, the reporter stops heartbeating. */
  signal: AbortSignal;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Override the heartbeat interval. Default 10_000ms. */
  heartbeatMs?: number;
}

export const DEFAULT_HEARTBEAT_MS = 10_000;

export function startActivityReporter(opts: ActivityReporterOptions): void {
  const { brokerClient, activity, signal, log } = opts;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Raw poster — ignores aborted state so we can fire one final
  // `idle` from the abort handler. Internal-only; the subscriber and
  // heartbeat call the abort-aware wrapper below.
  const postRaw = (state: ActivityState): void => {
    void brokerClient.setActivity({ state }).catch((err: unknown) => {
      log('activity-reporter: setActivity failed', {
        state,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const post = (state: ActivityState): void => {
    if (signal.aborted) return;
    postRaw(state);
  };

  const startHeartbeat = (): void => {
    if (heartbeatTimer !== null) return;
    heartbeatTimer = setInterval(() => {
      const state = activity.state();
      // Re-post whatever non-idle state we're in so the TTL stays fresh.
      if (state !== 'idle') post(state);
    }, heartbeatMs);
    // Don't keep the runner process alive just for this heartbeat —
    // when the agent exits and the runner shuts down, the timer should
    // not block process termination.
    if (typeof heartbeatTimer === 'object' && 'unref' in heartbeatTimer) {
      (heartbeatTimer as { unref: () => void }).unref();
    }
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const unsubscribe = activity.subscribe((state) => {
    post(state);
    // Heartbeat while working OR blocked; stop once we're idle.
    if (state !== 'idle') {
      startHeartbeat();
    } else {
      stopHeartbeat();
    }
  });

  signal.addEventListener(
    'abort',
    () => {
      stopHeartbeat();
      unsubscribe();
      // Best-effort final clear so presence drops to idle as soon as the
      // runner exits. The server's TTL would clear it eventually anyway.
      // Uses `postRaw` directly since `post` no-ops on an aborted signal.
      if (activity.state() !== 'idle') postRaw('idle');
    },
    { once: true },
  );
}

/** @deprecated Use {@link startActivityReporter}. */
export const startBusyReporter = startActivityReporter;
