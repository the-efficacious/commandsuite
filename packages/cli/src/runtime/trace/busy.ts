/**
 * "Agent activity" signal for the runner.
 *
 * Tracks what the agent is doing right now as a live 3-STATE model —
 * `idle | working | blocked` (see `ActivityState` in the SDK) — derived
 * from multiple independent in-flight sources plus a `blocked` flag. The
 * runner reports the state to the broker, which surfaces it on `/roster`
 * so the web UI can render presence distinctly (a spinner while working,
 * an "operator should look" marker while blocked).
 *
 * This is ORTHOGONAL to connection presence (online/connecting/offline),
 * which the SSE forwarder tracks separately. Where connection answers
 * "is the link alive", this answers "what is the agent doing on it".
 *
 * State derivation (priority `blocked > working > idle`):
 *
 *     blocked ? 'blocked' : count > 0 ? 'working' : 'idle'
 *
 * The signal is multi-sourced because no single observation point sees
 * everything an agent does:
 *
 *   - `turn_active` — the WHOLE turn window. Claude Code's
 *     UserPromptSubmit → Stop hooks bracket it; codex's
 *     turn/started → turn/completed notifications bracket it. Lights up
 *     `working` for model generation AND tool execution, not just tool
 *     windows. (Formerly `llm_inflight`, which only the old MITM proxy
 *     lit while a model request was on the wire.)
 *   - `tool_inflight` — bumped by per-runner integrations watching tool
 *     lifecycle events (claude Pre/PostToolUse hooks, codex
 *     `item/started`/`item/completed`). Lights up during bash, file-edit,
 *     MCP-tool, and other tool execution windows. Overlaps `turn_active`
 *     during a turn; it stands alone only if a feeder drops a turn
 *     bracket, and keeps `working` correct in that degraded case.
 *
 * The `blocked` flag is a separate boolean, NOT a counter — an agent is
 * either waiting on a human or it isn't. Claude Code's Notification hook
 * (permission_prompt / agent_needs_input / elicitation_dialog) sets it;
 * an idle_prompt notification or a turn-ending Stop clears it. It wins
 * over `working` so an operator sees "look here" even mid-turn.
 *
 * Why per-source counters: any single feeder can stall (a misbehaving
 * hook that never decrements, a JSON-RPC stream that drops a
 * notification). With separate counters, a stuck source can't poison
 * the others — and `getSourceCounts()` lets diagnostics tell us which
 * one is wedged. The public observable stays a single ActivityState so
 * the UI never has to merge sources.
 *
 * Why a count rather than a bool per source: many concurrent in-flight
 * units are normal (parallel tool fan-out, a turn wrapping several
 * tools). Using a count means we don't accidentally flip out of
 * `working` mid-burst when one of N completes. Subscribers still see
 * only STATE transitions, so the UI never thrashes.
 *
 * Listeners are notified on every transition of the derived state
 * (idle ↔ working ↔ blocked). Increments while the state is unchanged
 * (a second concurrent tool while already `working`) don't fire.
 *
 * Defense in depth — handles that never see their `finish()` call:
 *
 *   - Each handle has an auto-finish timer (see `DEFAULT_MAX_AGE_MS`).
 *     If `finish()` hasn't run by then we force it. A keep-alive socket
 *     surviving a TUI interrupt, a dropped tool-lifecycle notification,
 *     or a missed Stop hook would all otherwise wedge the indicator.
 *     We'd rather flicker idle after a long legitimate operation than
 *     show working forever.
 *   - `forceFinishAll()` drains every live handle and is called from
 *     `CaptureHost.close()` after sub-systems shut down — a teardown-time
 *     safety net for any handle a sub-system's own cleanup missed. It
 *     does NOT clear `blocked` (that's a distinct dimension a caller
 *     owns explicitly via `setBlocked`).
 */

import type { ActivityState } from 'csuite-sdk/types';

export type ActivitySource = 'turn_active' | 'tool_inflight';

/** @deprecated Use {@link ActivitySource}. Retained for existing imports. */
export type BusySource = ActivitySource;

const ALL_SOURCES: readonly ActivitySource[] = ['turn_active', 'tool_inflight'];

/**
 * Per-source upper bound on how long a single handle is allowed to
 * stay open before the safety net force-finishes it.
 *
 *   - `turn_active` — 30 minutes. A whole turn can legitimately run a
 *     long time (extended thinking plus a long chain of tool calls),
 *     and it stays open from UserPromptSubmit/turn-started until the
 *     matching Stop/turn-completed. 30 minutes leaves generous headroom
 *     while still bounding a turn whose closing bracket was dropped.
 *   - `tool_inflight` — 15 minutes. Tool calls can include long bash
 *     commands (npm install, docker build, large checkouts). Beyond
 *     15 minutes we'd rather risk flickering than show stuck-working
 *     forever.
 *
 * Callers with legitimate need for a different cap (or no cap) can
 * pass `maxAgeMs` explicitly to `start()`. Use `Infinity` to disable
 * the timer entirely; non-positive / non-finite values fall back to
 * the source default.
 */
export const DEFAULT_MAX_AGE_MS: Readonly<Record<ActivitySource, number>> = {
  turn_active: 30 * 60_000,
  tool_inflight: 15 * 60_000,
};

export interface ActivitySignalOptions {
  /**
   * Optional logger for non-routine events: handle auto-finished by
   * the max-age timer, handles drained via `forceFinishAll()`, etc.
   * The signal is normally silent on the happy path.
   */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

/** @deprecated Use {@link ActivitySignalOptions}. */
export type BusySignalOptions = ActivitySignalOptions;

export interface ActivityStartOptions {
  /**
   * Hard cap on the handle's lifetime in milliseconds. If `finish()`
   * isn't called by then we force-finish, log a warning, and drop the
   * count. Defaults to `DEFAULT_MAX_AGE_MS[source]`. Pass `Infinity`
   * to disable the safety net for this handle.
   */
  maxAgeMs?: number;
}

/** @deprecated Use {@link ActivityStartOptions}. */
export type BusyStartOptions = ActivityStartOptions;

export interface ActivityHandle {
  finish(): void;
}

/** @deprecated Use {@link ActivityHandle}. */
export type BusyHandle = ActivityHandle;

export interface ActivitySignal {
  /** Sum of in-flight counts across all sources. */
  readonly count: number;
  /**
   * Back-compat mirror of `state() === 'working'`. NOTE this is false
   * while `blocked` even if a turn/tool is in flight, since `blocked`
   * wins the derivation. Prefer `state()` for the full picture.
   */
  readonly busy: boolean;
  /** Whether a human-blocking signal is currently set. */
  readonly blocked: boolean;
  /** The derived 3-state activity: `blocked > working > idle`. */
  state(): ActivityState;
  /**
   * Set/clear the human-blocking flag. `true` when the agent is stuck
   * waiting on a person (needs input / an approval it can't self-resolve),
   * `false` when that resolves or the turn ends. Fires a state transition
   * to/from `blocked` when it changes the derived state.
   */
  setBlocked(blocked: boolean): void;
  /**
   * Mark a new unit of work as started. Returns a handle that
   * decrements on `finish()`. Defaults to `turn_active`.
   *
   * Each handle auto-finishes after `maxAgeMs` if `finish()` hasn't
   * been called — see the file-level comment on defense in depth.
   */
  start(source?: ActivitySource, options?: ActivityStartOptions): ActivityHandle;
  /**
   * Subscribe to activity-STATE changes. Listener fires immediately with
   * the current state, then on every transition (idle ↔ working ↔
   * blocked). Returns an unsubscribe function.
   */
  subscribe(listener: (state: ActivityState) => void): () => void;
  /**
   * Diagnostics: read the live per-source counts. Useful when a
   * subscriber suspects one source is stuck — see which counter
   * refuses to drain.
   */
  getSourceCounts(): Readonly<Record<ActivitySource, number>>;
  /**
   * Force every outstanding handle to finish. Returns the number of
   * handles that were drained (zero when no work was in flight). Emits
   * a single working→(idle|blocked) transition if draining changed the
   * derived state. Does NOT touch `blocked`.
   *
   * The trace host calls this from its `close()` path after the hook
   * server and codex sniff have shut down, as a final safety net for
   * handles a sub-system's own cleanup missed. Tests can also use it to
   * scrub state between cases.
   */
  forceFinishAll(): number;
}

/** @deprecated Use {@link ActivitySignal}. */
export type BusySignal = ActivitySignal;

interface InternalHandle {
  source: ActivitySource;
  finish: (reason: 'normal' | 'timeout' | 'force') => void;
}

export function createActivitySignal(options: ActivitySignalOptions = {}): ActivitySignal {
  const log = options.log ?? (() => {});
  const counts = new Map<ActivitySource, number>();
  for (const source of ALL_SOURCES) counts.set(source, 0);
  const listeners = new Set<(state: ActivityState) => void>();
  const liveHandles = new Set<InternalHandle>();
  let blocked = false;

  const totalCount = (): number => {
    let total = 0;
    for (const v of counts.values()) total += v;
    return total;
  };

  const deriveState = (): ActivityState =>
    blocked ? 'blocked' : totalCount() > 0 ? 'working' : 'idle';

  // Last state we told subscribers about. We only emit on genuine
  // transitions so the reporter's POST traffic doesn't thrash when a
  // source increments while the derived state is unchanged.
  let lastState: ActivityState = deriveState();

  const emitIfChanged = (): void => {
    const next = deriveState();
    if (next === lastState) return;
    lastState = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        /* listener threw — not our problem */
      }
    }
  };

  const resolveMaxAge = (source: ActivitySource, requested: number | undefined): number => {
    if (requested === undefined) return DEFAULT_MAX_AGE_MS[source];
    if (typeof requested !== 'number') return DEFAULT_MAX_AGE_MS[source];
    if (Number.isNaN(requested)) return DEFAULT_MAX_AGE_MS[source];
    // Positive Infinity is the documented opt-out signal — let it
    // through so the timer setup below sees a non-finite value and
    // skips scheduling.
    if (requested === Number.POSITIVE_INFINITY) return requested;
    if (requested <= 0) return DEFAULT_MAX_AGE_MS[source];
    return requested;
  };

  const start = (
    source: ActivitySource = 'turn_active',
    startOpts: ActivityStartOptions = {},
  ): ActivityHandle => {
    counts.set(source, (counts.get(source) ?? 0) + 1);
    emitIfChanged();

    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const finish = (reason: 'normal' | 'timeout' | 'force'): void => {
      // Idempotent — a callback wired to two completion paths
      // (e.g., onExchange + closeSession) shouldn't double-decrement.
      if (finished) return;
      finished = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      liveHandles.delete(handleEntry);
      const next = Math.max(0, (counts.get(source) ?? 0) - 1);
      counts.set(source, next);
      emitIfChanged();
      if (reason !== 'normal') {
        log('activity: handle auto-finished', {
          source,
          reason,
          ageMs: Date.now() - startedAt,
        });
      }
    };

    const handleEntry: InternalHandle = {
      source,
      finish,
    };
    liveHandles.add(handleEntry);

    const maxAgeMs = resolveMaxAge(source, startOpts.maxAgeMs);
    if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
      timer = setTimeout(() => finish('timeout'), maxAgeMs);
      // Don't keep the runner process alive just to fire this watchdog —
      // if the runner is exiting and this is the only live timer, we
      // want the loop to drain so close() can proceed.
      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as { unref: () => void }).unref();
      }
    }

    return {
      finish: () => finish('normal'),
    };
  };

  const forceFinishAll = (): number => {
    if (liveHandles.size === 0) return 0;
    const drained = liveHandles.size;
    // Snapshot before iterating since each finish() mutates the set.
    for (const entry of [...liveHandles]) {
      entry.finish('force');
    }
    log('activity: force-finished outstanding handles', { drained });
    return drained;
  };

  return {
    get count() {
      return totalCount();
    },
    get busy() {
      return deriveState() === 'working';
    },
    get blocked() {
      return blocked;
    },
    state() {
      return deriveState();
    },
    setBlocked(next: boolean) {
      const coerced = next === true;
      if (coerced === blocked) return;
      blocked = coerced;
      emitIfChanged();
    },
    start,
    subscribe(listener) {
      listeners.add(listener);
      // Late subscribers see the current state.
      try {
        listener(deriveState());
      } catch {
        /* ignore */
      }
      return () => {
        listeners.delete(listener);
      };
    },
    getSourceCounts() {
      const out = { turn_active: 0, tool_inflight: 0 } as Record<ActivitySource, number>;
      for (const [k, v] of counts) out[k] = v;
      return out;
    },
    forceFinishAll,
  };
}

/** @deprecated Use {@link createActivitySignal}. */
export const createBusySignal = createActivitySignal;
