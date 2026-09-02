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
 *   5. respawn COLD. The successor does not resume the predecessor's
 *      conversation: the refreshed instructions plus the runner's
 *      `context_refresh` re-brief ARE the context that matters, and
 *      the agent self-orients from there (`objectives_list`, `recent`,
 *      `roster`). Conversation continuity is the agent framework's own
 *      business — CommandSuite owns the team substrate, not the
 *      agent's context — and an earlier design that resumed here
 *      re-read hours of transcript history as new activity on every
 *      restart (see `trace/transcript-reader.ts`).
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

/**
 * What asked for a restart. Both kinds run the same cycle (the refetch
 * covers instructions AND environment either way); the distinction is
 * carried to the successor's `session_start` so the trace says why the
 * conversation was dropped rather than a generic "restarted".
 */
export type RestartReason = 'instructions' | 'environment';

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
   * native session id (diagnostics only — the successor never resumes
   * it). Must not resolve before the process has exited and flushed.
   */
  stopCurrent(reason: string): Promise<{ sessionId: string | null }>;
  /** Refetch instructions. A rejection aborts nothing — see run(). */
  refreshInstructions(): Promise<unknown>;
  /** Refetch secrets and variables; failure keeps the prior atomic snapshot. */
  refreshSecrets(): Promise<unknown>;
  /**
   * Spawn the successor COLD, under the refreshed instructions and
   * environment. `reasons` is every request the cycle applied, in
   * first-seen order, so the caller can name why the conversation was
   * dropped. A `clear` starts cold the same way; the two differ only in
   * what triggered them.
   */
  respawn(cycle: { reasons: readonly RestartReason[] }): Promise<void>;
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
   * Note an instruction edit or an environment change. Idempotent
   * while a cycle is pending or in flight (see coalescing above) —
   * the reason is still recorded so the successor's trace names every
   * trigger the cycle applied. Never throws; failures inside the cycle
   * surface through `onFailure`.
   */
  request(reason: RestartReason): void;
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
  // Reasons accumulated since the last cycle took its snapshot. A
  // request that folds into a running cycle (lands before its refetch)
  // still adds its reason here, so the successor's session_start names
  // it; one that lands after the refetch re-arms AND seeds the next
  // cycle's reasons, because the snapshot was already taken.
  const reasons = new Set<RestartReason>();

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
    hooks.log.info('restart requested — draining at next idle', { reasons: [...reasons] });
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
    try {
      await hooks.refreshSecrets();
    } catch (err) {
      hooks.log.warn('environment refetch failed — respawning with cached environment', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Edits landing after this point missed the fetch; they re-arm.
    // The reasons snapshot is taken at the same moment for the same
    // reason: anything recorded after it belongs to the next cycle.
    covered = false;
    const applied = [...reasons];
    reasons.clear();
    await hooks.respawn({ reasons: applied });
    hooks.log.info('agent respawned cold with current instructions and environment', {
      reasons: applied,
      priorSession: prior.sessionId,
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
    request(reason): void {
      if (closed) return;
      reasons.add(reason);
      if (inFlight !== null) {
        if (covered) {
          // The running cycle has not refetched yet — this edit rides
          // along with it (and its reason is already recorded above).
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
