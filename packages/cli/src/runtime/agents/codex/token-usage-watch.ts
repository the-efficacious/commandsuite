/**
 * The codex dump-signal SPIKE: inferring a context discard from token
 * accounting, because codex has no compaction hook to declare one.
 *
 * WHAT THIS IS AND IS NOT. Claude Code tells us its context was
 * discarded — the SessionStart hook fires with `source: compact`, and
 * that is a declaration by the party that would know. Codex declares
 * nothing of the kind. What it does emit is
 * `thread/tokenUsage/updated`, carrying a running thread total, the
 * last request's breakdown, and `modelContextWindow`; and a context
 * discard leaves a shape in that series. So this is an INFERENCE where
 * the other runner has a REPORT, and the two must not be confused:
 *
 *   - it is LOG-ONLY by default. The line goes to the operator's
 *     stderr and nowhere else.
 *   - reporting it to the curator is behind an env flag
 *     (`CSUITE_SPINE_CODEX_DUMP_SIGNAL=1`), default OFF.
 *   - `CODEX_META.spineSignals.dumpSignal` stays FALSE until this has
 *     been measured against real compactions. Declaring a capability
 *     the runner does not reliably have is worse than declaring none,
 *     because the roster's entire value is that a declaration is
 *     believed.
 *
 * And it is measurement, not correctness. A false positive costs one
 * redundant re-orientation; a false negative costs the latency the
 * clock would have taken anyway. Neither can make the spine wrong,
 * which is exactly why a spike is allowed to land here at all.
 *
 * TWO SHAPES, and they are different events:
 *
 *   RESET     the running total went DOWN. Totals only ever grow
 *             within one continuous context, so a decrease means the
 *             accounting restarted under us — the strongest evidence
 *             available that the thread's context is not what it was.
 *   SATURATED the last request's tokens reached the declared context
 *             window. Nothing has been discarded YET, but this is the
 *             state a discard happens from, and it is worth a line
 *             because it is the only forewarning codex gives.
 */

import type { SpineDumpSource } from 'csuite-sdk/types';
import type { JsonRpcClient } from './json-rpc.js';
import { NOTIFICATIONS, type TokenUsageUpdatedNotification } from './protocol.js';

/** The env flag that turns the inference into a reported signal. Default off. */
export const CODEX_DUMP_SIGNAL_ENV = 'CSUITE_SPINE_CODEX_DUMP_SIGNAL';

/** The exact log line the spike must produce. Named so tests can grep for it. */
export const CODEX_DUMP_LOG_LINE = 'spine: possible codex dump detected';

export type TokenDiscontinuity = 'total_reset' | 'window_saturated';

export interface TokenUsageObservation {
  /** Running thread total, when the payload carried one. */
  total: number | null;
  /** The most recent request's tokens, when the payload carried them. */
  last: number | null;
  /** The model's declared window, when codex knew it. */
  window: number | null;
}

/**
 * The whole judgement, as a pure function of two observations.
 *
 * Pure and exported because it is the part worth testing: the wiring
 * below is three lines of subscription, and the series shapes are the
 * thing nobody can check by reading. `previous === null` returns null
 * rather than a discontinuity — the first observation of a session
 * cannot be a discontinuity in anything.
 */
export function classifyTokenUsage(
  previous: TokenUsageObservation | null,
  next: TokenUsageObservation,
): TokenDiscontinuity | null {
  if (previous !== null && previous.total !== null && next.total !== null) {
    // STRICTLY less. An equal total is a notification that repeated or
    // a turn that consumed nothing, and calling either a discard would
    // make an idle thread look like it was losing its memory.
    if (next.total < previous.total) return 'total_reset';
  }
  if (next.last !== null && next.window !== null && next.window > 0) {
    if (next.last >= next.window) return 'window_saturated';
  }
  return null;
}

export interface CodexTokenUsageWatchOptions {
  rpc: JsonRpcClient;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
  /**
   * Report the inference as a floor signal. Called ONLY when the env
   * flag is set — the wiring is unconditional, the reporting is not,
   * so the code path is exercised in every run and the side effect is
   * not.
   */
  reportDump?: (source: SpineDumpSource) => void;
  /** Env to read the flag from. Injected for tests; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface CodexTokenUsageWatch {
  /** Observations seen, for the spike's own accounting. */
  seen(): number;
  /** Discontinuities detected this session. */
  detected(): TokenDiscontinuity[];
}

/**
 * Subscribe to `thread/tokenUsage/updated` and watch the series.
 *
 * The adapter never subscribed to this notification before now, which
 * is the whole reason a token-based dump signal was buildable with no
 * new vendor surface: codex has been emitting it the entire time.
 */
export function attachCodexTokenUsageWatch(
  options: CodexTokenUsageWatchOptions,
): CodexTokenUsageWatch {
  const env = options.env ?? process.env;
  const reporting = env[CODEX_DUMP_SIGNAL_ENV] === '1';
  let previous: TokenUsageObservation | null = null;
  let seen = 0;
  const detected: TokenDiscontinuity[] = [];

  options.rpc.onNotification(NOTIFICATIONS.tokenUsageUpdated, (params) => {
    const payload = params as TokenUsageUpdatedNotification;
    const usage = payload?.tokenUsage;
    const next: TokenUsageObservation = {
      total: numberOrNull(usage?.total?.totalTokens),
      last: numberOrNull(usage?.last?.totalTokens),
      window: numberOrNull(usage?.modelContextWindow),
    };
    seen++;
    const discontinuity = classifyTokenUsage(previous, next);
    previous = next;
    if (discontinuity === null) return;
    detected.push(discontinuity);
    // Structured, with both operands, because an operator reading this
    // has to be able to tell a real compaction from a codex build that
    // changed how it counts.
    options.log(CODEX_DUMP_LOG_LINE, {
      discontinuity,
      total: next.total,
      last: next.last,
      modelContextWindow: next.window,
      threadId: payload?.threadId ?? null,
      turnId: payload?.turnId ?? null,
      reported: reporting,
    });
    if (reporting && options.reportDump) options.reportDump('token_discontinuity');
  });

  return {
    seen: () => seen,
    detected: () => [...detected],
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
