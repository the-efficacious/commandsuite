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
 * THREE SHAPES, and only one of them is ever reported:
 *
 *   RESET     the running total went DOWN. REPORTED under the flag.
 *   SHRANK    the LAST request's tokens fell sharply while the running
 *             total kept growing. Log-only.
 *   SATURATED the last request reached the declared window. Log-only —
 *             by this file's own account nothing has been discarded
 *             YET, so reporting it as `dump_declared` would be
 *             reporting a forecast as an event.
 *
 * WHICH SHAPE IS ACTUALLY THE COMPACTION IS AN OPEN QUESTION, and
 * writing that down is the most useful thing this spike does. `total`
 * reads like a CUMULATIVE BILLING COUNTER for the thread: if it is,
 * it does not reset when context is compacted — it resets when a
 * THREAD RESTARTS, which is a different event that happens to look
 * identical here. The shape that should track a compaction is
 * `last` collapsing (the next request carries a summarised prefix
 * instead of the full history) while `total` continues upward. That is
 * why SHRANK is measured even though nothing acts on it: the point of
 * a spike is to come back with data about which signal to trust, and
 * a spike that only records the shape it already believed in returns
 * its own assumption.
 *
 * EDGE-TRIGGERED. A saturated window stays saturated across every
 * notification of a long turn, and a level-triggered watcher would log
 * the same line ten times — a stream of identical lines is how an
 * operator learns to stop reading a channel.
 */

import type { SpineDumpSource } from 'csuite-sdk/types';
import type { JsonRpcClient } from './json-rpc.js';
import { NOTIFICATIONS, type TokenUsageUpdatedNotification } from './protocol.js';

/** The env flag that turns the inference into a reported signal. Default off. */
export const CODEX_DUMP_SIGNAL_ENV = 'CSUITE_SPINE_CODEX_DUMP_SIGNAL';

/** The exact log line the spike must produce. Named so tests can grep for it. */
export const CODEX_DUMP_LOG_LINE = 'spine: possible codex dump detected';

export type TokenDiscontinuity = 'total_reset' | 'last_shrank' | 'window_saturated';

/**
 * The only shape that is ever REPORTED as a dump, and then only under
 * the env flag. The other two are measurements.
 */
const REPORTABLE: ReadonlySet<TokenDiscontinuity> = new Set<TokenDiscontinuity>(['total_reset']);

/**
 * How far `last` must fall, as a fraction of its previous value,
 * before it counts as a collapse rather than a short turn. Turns vary
 * enormously in size, so a small drop is the normal texture of a
 * session; losing three quarters of the prompt in one step is not.
 */
const LAST_COLLAPSE_RATIO = 0.25;

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
  // `last` collapsing while `total` keeps climbing: the shape a real
  // compaction should leave, and the one worth coming back with
  // numbers about. The `total` guard is what separates it from a
  // restart, which the first branch already claimed.
  if (
    previous !== null &&
    previous.last !== null &&
    next.last !== null &&
    previous.last > 0 &&
    next.last < previous.last * LAST_COLLAPSE_RATIO &&
    previous.total !== null &&
    next.total !== null &&
    next.total >= previous.total
  ) {
    return 'last_shrank';
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
  let lastReported: TokenDiscontinuity | null = null;
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
    if (discontinuity === null) {
      lastReported = null;
      return;
    }
    // EDGE, not level. A saturated window is still saturated on the
    // next notification, and the next, and the next.
    if (discontinuity === lastReported) return;
    lastReported = discontinuity;
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
      // Whether this line became a signal, on the line itself, so an
      // operator reading stderr never has to work out which of the
      // three shapes the flag covers.
      reported: reporting && REPORTABLE.has(discontinuity),
    });
    if (reporting && REPORTABLE.has(discontinuity) && options.reportDump) {
      options.reportDump('token_discontinuity');
    }
  });

  return {
    seen: () => seen,
    detected: () => [...detected],
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
