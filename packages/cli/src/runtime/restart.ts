/**
 * The drain-and-restart coordinator — the runner-side half of the
 * instruction-block contract.
 *
 * An instruction edit cannot reach a live agent at full authority:
 * both supported frameworks freeze their system-level context at
 * session start (the Agent SDK has no setSystemPrompt on a live
 * query; codex takes `developerInstructions` only on thread open).
 * The broker therefore fans out a `kind: 'instructions'` event and
 * lists the member restart-pending; this coordinator is what answers.
 *
 * DRAIN, DON'T KILL. The policy is restart at the next SAFE boundary
 * — the choice an operator retains is when, not whether:
 *
 *   1. wait for the activity signal to read `idle` (a request landing
 *      mid-turn waits for the turn, not the other way around);
 *   2. detach ambient input so events arriving during the swap buffer
 *      for the successor instead of dying with the predecessor;
 *   3. gracefully stop the agent process — its capture readers flush;
 *   4. refetch instructions so the successor composes from what the
 *      broker holds NOW (this also un-stales the MCP toolbox);
 *   5. respawn, RESUMING the prior conversation where the framework
 *      supports it. Resume is what makes the continuity cost ~zero:
 *      the successor holds the same conversation under the new system
 *      prompt, rather than a summary of it.
 *
 * COALESCING. Requests arriving while a restart is already draining
 * or swapping are folded into it when they land before the refetch
 * (the refetch reads current state, so they are already covered) and
 * re-arm one more cycle when they land after it. N edits cost at most
 * two restarts, usually one.
 *
 * WITHOUT AN ACTIVITY SIGNAL (`--no-trace`) there is no turn-boundary
 * observation. The coordinator restarts after a short grace rather
 * than never: a mid-turn interrupt loses at most the current turn,
 * while "never" silently disables the feature exactly where nobody is
 * watching. The grace lets the channel sinks' bundling windows clear.
 */

import type { AgentLog } from './agents/adapter.js';

/** Where the coordinator gets its idle observation. */
export interface ActivityObservation {
  /** Fires immediately with the current state, then on transitions. */
  subscribe(listener: (state: 'idle' | 'working' | 'blocked') => void): () => void;
}

export interface RestartHooks {
  /**
   * The activity signal, or `null` when capture is off. Read lazily
   * per restart so a host that comes up late still counts.
   */
  activity(): ActivityObservation | null;
  /** Re-point ambient input at a buffer for the successor. Optional. */
  detach(): void;
  /**
   * Gracefully stop the current agent process and resolve with its
   * native session id (for resume). Must not resolve before the
   * process has exited and flushed.
   */
  stopCurrent(reason: string): Promise<{ sessionId: string | null }>;
  /** Refetch instructions. A rejection aborts nothing — see run(). */
  refreshInstructions(): Promise<unknown>;
  /**
   * Spawn the successor. An instruction restart ALWAYS resumes — the
   * whole point is that the successor holds the same conversation under
   * the new system prompt, so continuity costs ~nothing. Dropping the
   * conversation is `clear`'s job, not this one's.
   */
  respawn(prior: { resume: true; sessionId: string | null }): Promise<void>;
  /**
   * Run the stop→refetch→respawn cycle under the shared
   * agent-lifecycle lock. A `clear` swaps the same process this does,
   * so the two must never interleave — and the unit that has to be
   * atomic is the WHOLE cycle, not its individual steps, which is why
   * this wraps rather than being three guarded hooks.
   *
   * Optional: callers with no second swapper (tests, single-purpose
   * drivers) omit it and get pass-through.
   */
  gate?<T>(fn: () => Promise<T>): Promise<T>;
  log: AgentLog;
}

export interface RestartCoordinator {
  /**
   * Note an instruction edit. Idempotent while a cycle is pending or
   * in flight (see coalescing above). Never throws; failures inside
   * the cycle surface through `onFailure`.
   */
  request(): void;
  /**
   * Stop reacting to requests — the session is ending. A cycle
   * already past its drain keeps running to completion (a half-swapped
   * agent is worse than a completed swap at teardown; the driver's
   * teardown serializes behind it via `settled()`).
   */
  close(): void;
  /** Resolves when no cycle is in flight. For teardown ordering. */
  settled(): Promise<void>;
}

export const NO_SIGNAL_GRACE_MS = 1_500;

export function createRestartCoordinator(
  hooks: RestartHooks,
  opts: {
    /**
     * Invoked when a cycle fails after the old agent is already down —
     * the session cannot continue and the driver must tear down. A
     * failure BEFORE stopCurrent leaves the old agent running and is
     * only logged.
     */
    onFailure: (err: unknown) => void;
    /** Test seam. Defaults to setTimeout. */
    delay?: (ms: number) => Promise<void>;
  },
): RestartCoordinator {
  const delay =
    opts.delay ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
      }));

  let closed = false;
  let pending = false;
  let inFlight: Promise<void> | null = null;
  // Set when a request lands after the refetch of the running cycle —
  // that edit is NOT covered by the successor's instructions, so one
  // more cycle runs when the current one completes.
  let rearm = false;
  let covered = true;

  const waitForIdle = async (): Promise<void> => {
    const activity = hooks.activity();
    if (activity === null) {
      hooks.log.warn('no activity signal (--no-trace) — restarting after grace');
      await delay(NO_SIGNAL_GRACE_MS);
      return;
    }
    await new Promise<void>((resolve) => {
      const unsubscribe = activity.subscribe((state) => {
        if (state === 'idle') {
          // Subscribe fires synchronously with the current state, so
          // an already-idle agent resolves before unsubscribe exists.
          setImmediate(() => unsubscribe());
          resolve();
        }
      });
    });
  };

  const runCycle = async (): Promise<void> => {
    // Until the refetch below completes, any request that arrives is
    // covered by this cycle — the fetch reads current broker state.
    covered = true;
    hooks.log.info('instruction edit observed — draining at next idle');
    // The idle wait sits OUTSIDE the lock deliberately: it can block
    // for the length of a turn, and holding the lifecycle lock while
    // merely waiting would stall a `clear` that is itself about to
    // wait for the same boundary.
    await waitForIdle();
    if (closed) {
      hooks.log.info('session ending — drained cycle abandoned before stop');
      return;
    }
    const gate = hooks.gate ?? (<T>(fn: () => Promise<T>): Promise<T> => fn());
    return gate(() => swap());
  };

  const swap = async (): Promise<void> => {
    if (closed) {
      hooks.log.info('session ending — cycle abandoned at the lock');
      return;
    }
    hooks.detach();
    const prior = await hooks.stopCurrent('restart-instructions');
    // From here failure is fatal to the session: the old agent is gone.
    try {
      await hooks.refreshInstructions();
    } catch (err) {
      // Proceed on the cached packet: a restart that applies SOME
      // pending edits (any picked up by earlier refetches) beats a
      // dead session. The broker still lists the member pending, so
      // nothing is silently marked resolved.
      hooks.log.warn('instructions refetch failed — respawning on cached packet', {
        error: err instanceof Error ? err.message : String(err),
      });
      // The edit that triggered us is NOT applied — keep the cycle
      // armed so a later attempt retries the fetch.
      rearm = true;
    }
    // Edits landing after this point missed the fetch; they re-arm.
    covered = false;
    await hooks.respawn({ resume: true, sessionId: prior.sessionId });
    hooks.log.info('agent respawned with current instructions', {
      resumedSession: prior.sessionId,
    });
  };

  const launch = (): void => {
    if (inFlight !== null) return;
    pending = false;
    inFlight = runCycle()
      .catch((err) => {
        opts.onFailure(err);
      })
      .finally(() => {
        inFlight = null;
        if (!closed && (pending || rearm)) {
          rearm = false;
          launch();
        }
      });
  };

  return {
    request(): void {
      if (closed) return;
      if (inFlight !== null) {
        if (covered) {
          // The running cycle has not refetched yet — this edit rides
          // along with it.
          return;
        }
        rearm = true;
        return;
      }
      pending = true;
      launch();
    },
    close(): void {
      closed = true;
    },
    settled(): Promise<void> {
      return inFlight ?? Promise.resolve();
    },
  };
}
