/**
 * The context-control coordinator — the runner-side half of
 * `POST /members/:name/context`.
 *
 * The broker is authoritative about a team and could already SEE a
 * member's context drift (`context-watchdog.ts` distinguishes present
 * from missing from stale, and re-sends on a cooldown). What it had no
 * verb for was making a context SMALLER. Every existing member-stream
 * event adds; the only lifecycle control a runner took was `shutdown`,
 * which costs the member its MCP wiring and its place on the net.
 *
 * Two verbs, and the difference between them is who does the work:
 *
 *   `clear`   — IMPOSED. The runner swaps the agent process without
 *     resuming the prior conversation. It does not need the agent's
 *     cooperation and cannot be declined, so its only failure mode is
 *     mechanical.
 *   `compact` — COOPERATIVE. The agent has to do the summarising, so
 *     the runner can only ASK, and the ask can be refused. What makes
 *     this honest rather than fire-and-forget is that both supported
 *     answers are observable: the framework reports the outcome, and
 *     this coordinator reports it onward as the ack.
 *
 * THE ACK IS THE POINT. Every path out of `handle()` emits exactly one
 * `context_control` activity event carrying the request id — including
 * `unsupported` (this runner has no such op) and `declined` (the agent
 * was asked and said no, with its reason). A control that reported
 * success on delivery would assert something nobody observed, which is
 * the failure shape this feature exists to avoid.
 *
 * DRAIN, DON'T INTERRUPT. Like `restart.ts`, a `clear` waits for the
 * activity signal to read idle before swapping, so a control landing
 * mid-turn costs the turn nothing. `compact` does not wait: the
 * framework queues a slash command behind the running turn on its own,
 * and holding it here would only add a second queue.
 *
 * SERIALIZED AGAINST RESTART. Both coordinators stop and respawn the
 * same agent process, so they share one lock (`gate`). A `clear` that
 * lands while an instruction-restart is draining waits for it — and
 * benefits from it, since a restart that has already refetched
 * instructions has done half a clear's work.
 */

import type { Logger } from 'csuite-core';
import type { ActivityContextControl } from 'csuite-sdk/types';
import type { ContextControlEvent } from './forwarder.js';
import type { ActivityObservation } from './restart.js';

/**
 * What a `compact` attempt produced, as reported by the agent
 * framework. Adapters that cannot compact at all return
 * `{ supported: false }` and never reach the ask.
 */
export type CompactAttempt =
  | { supported: false; detail: string }
  | { supported: true; applied: true; tokensBefore?: number; tokensAfter?: number }
  | { supported: true; applied: false; detail: string };

export interface ContextControlHooks {
  /**
   * The activity signal, or `null` when capture is off. Read lazily
   * per control so a host that comes up late still counts.
   */
  activity(): ActivityObservation | null;
  /**
   * Ask the agent to compact, and RESOLVE ONLY ONCE THE FRAMEWORK HAS
   * ANSWERED. An adapter that resolves on send has converted a
   * cooperative request into an unverified claim — the one thing this
   * coordinator exists to prevent.
   */
  compact(reason: string | undefined): Promise<CompactAttempt>;
  /**
   * Drop the conversation and start the agent cold, preserving the
   * runner (broker subscription, IPC socket, objectives tracker,
   * capture host). Resolves once the successor is up.
   */
  clear(reason: string): Promise<void>;
  /**
   * Restart cold under refreshed instructions and environment. Like
   * `clear`, the successor holds none of the prior conversation; the
   * two differ in what asked for the swap, which its session_start
   * names (`environment reloaded` vs `context cleared`).
   */
  reload(reason: string): Promise<void>;
  /** Emit the ack onto the member's activity stream. */
  report(event: ActivityContextControl): void;
  /**
   * Run `fn` under the shared agent-lifecycle lock, so a clear and an
   * instruction-restart can never swap the process concurrently.
   */
  gate<T>(fn: () => Promise<T>): Promise<T>;
  logger: Logger;
  /** Test seam. Defaults to `Date.now`. */
  now?: () => number;
}

export interface ContextControlCoordinator {
  /** Execute one control. Never throws; failures become `failed` acks. */
  handle(control: ContextControlEvent): Promise<void>;
  /** Stop accepting controls — the session is ending. */
  close(): void;
  /** Resolves when no control is in flight. For teardown ordering. */
  settled(): Promise<void>;
}

/**
 * How long a `clear` waits for the agent to reach idle before swapping
 * anyway. Without a capture host there is no turn-boundary observation
 * at all, and "never" would silently disable the verb exactly where
 * nobody is watching — the same trade `restart.ts` makes, and the same
 * reasoning: a mid-turn swap loses at most the current turn.
 */
export const CLEAR_IDLE_GRACE_MS = 1_500;

export function createContextControlCoordinator(
  hooks: ContextControlHooks,
  opts: { delay?: (ms: number) => Promise<void> } = {},
): ContextControlCoordinator {
  const now = hooks.now ?? (() => Date.now());
  const delay =
    opts.delay ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
      }));

  let closed = false;
  let inFlight: Promise<void> | null = null;

  const waitForIdle = async (): Promise<void> => {
    const activity = hooks.activity();
    if (activity === null) {
      hooks.logger.info('no activity signal — clearing after grace');
      await delay(CLEAR_IDLE_GRACE_MS);
      return;
    }
    await new Promise<void>((resolve) => {
      const unsubscribe = activity.subscribe((state) => {
        if (state === 'idle') {
          // `subscribe` fires synchronously with the current state, so
          // an already-idle agent resolves before `unsubscribe` exists.
          setImmediate(() => unsubscribe());
          resolve();
        }
      });
    });
  };

  const ack = (
    control: ContextControlEvent,
    outcome: ActivityContextControl['outcome'],
    extra: { detail?: string; tokens?: { before: number; after: number } } = {},
  ): void => {
    hooks.report({
      kind: 'context_control',
      ts: now(),
      requestId: control.requestId,
      verb: control.verb,
      outcome,
      requestedBy: control.requestedBy,
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      ...(extra.tokens !== undefined ? { tokens: extra.tokens } : {}),
    });
    hooks.logger.info('reported outcome', {
      requestId: control.requestId,
      verb: control.verb,
      outcome,
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    });
  };

  const runCompact = async (control: ContextControlEvent): Promise<void> => {
    const attempt = await hooks.compact(control.reason);
    if (!attempt.supported) {
      // Distinct from `declined` on purpose: nothing was ever asked,
      // so retrying cannot help and a policy above should stop trying.
      ack(control, 'unsupported', { detail: attempt.detail });
      return;
    }
    if (!attempt.applied) {
      ack(control, 'declined', { detail: attempt.detail });
      return;
    }
    // Token counts ride along only when the framework measured them.
    // A compaction reported successful without a measurement is still
    // `applied` — absence of the number is not absence of the effect,
    // and inventing a zero would be worse than omitting the field.
    ack(
      control,
      'applied',
      attempt.tokensBefore !== undefined && attempt.tokensAfter !== undefined
        ? { tokens: { before: attempt.tokensBefore, after: attempt.tokensAfter } }
        : {},
    );
  };

  const runClear = async (control: ContextControlEvent): Promise<void> => {
    await waitForIdle();
    if (closed) {
      hooks.logger.warn('session ending — clear abandoned before swap');
      ack(control, 'failed', { detail: 'session ended before the clear could be applied' });
      return;
    }
    await hooks.clear(
      control.reason !== undefined
        ? `context-clear (${control.requestedBy}): ${control.reason}`
        : `context-clear (${control.requestedBy})`,
    );
    ack(control, 'applied');
  };

  const runReload = async (control: ContextControlEvent): Promise<void> => {
    await waitForIdle();
    if (closed) {
      hooks.logger.warn('session ending — reload abandoned before swap');
      ack(control, 'failed', { detail: 'session ended before the reload could be applied' });
      return;
    }
    await hooks.reload(
      control.reason !== undefined
        ? `context-reload (${control.requestedBy}): ${control.reason}`
        : `context-reload (${control.requestedBy})`,
    );
    ack(control, 'applied');
  };

  const run = async (control: ContextControlEvent): Promise<void> => {
    try {
      if (control.verb === 'compact') {
        await runCompact(control);
        return;
      }
      // Only `clear` takes the lifecycle lock. `compact` never swaps
      // the process, so holding the gate across a summarisation that
      // can take 20s+ would stall an unrelated instruction-restart for
      // no benefit.
      await hooks.gate(() => (control.verb === 'reload' ? runReload(control) : runClear(control)));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      hooks.logger.error('control failed', {
        requestId: control.requestId,
        verb: control.verb,
        error: detail,
      });
      ack(control, 'failed', { detail });
    }
  };

  return {
    async handle(control: ContextControlEvent): Promise<void> {
      if (closed) {
        ack(control, 'failed', { detail: 'runner is shutting down' });
        return;
      }
      // Serialize controls against each other so two clears cannot
      // interleave their swaps. Chaining rather than rejecting keeps
      // every request answered — a dropped control is a request the
      // broker never gets an outcome for.
      const prior = inFlight ?? Promise.resolve();
      const next = prior.then(() => run(control));
      inFlight = next.finally(() => {
        if (inFlight === next) inFlight = null;
      });
      await inFlight;
    },
    close(): void {
      closed = true;
    },
    settled(): Promise<void> {
      return inFlight ?? Promise.resolve();
    },
  };
}
