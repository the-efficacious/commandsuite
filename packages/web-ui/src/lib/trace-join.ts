/**
 * The llm_exchange ↔ GenAI-inference join — shared by the objective
 * TracePanel and the member AgentTimeline.
 *
 * The two capture layers observe the same model work from different
 * points: the exchange marker (activity stream) is the
 * always-present, live turn narrative read from the agent's
 * transcript; the inference record (genai store) is the
 * rich-but-intermittent wiretap of one actual API call. The
 * relationship between them is TURN-CENTRIC and genuinely
 * one-to-many: a Claude turn is usually one API call, but a codex
 * turn aggregates every Responses-API call the turn made, and some
 * calls (subagents, server-tool sidecars like web search, away
 * summaries) have NO turn marker at all.
 *
 * So the join produces a turn spine, not row pairs:
 *   - each exchange gets `calls: T[]` — 0..N inference records
 *   - records that belong to no turn come back as `orphans`, to be
 *     rendered in their own right (a subagent lane / sidecar row),
 *     never silently dropped
 *
 * Matching, per call:
 *   1. EXACT — the exchange's `response.responseId` equals the
 *      record's `responseId` (Claude rows carry it; same id space as
 *      `gen_ai.response.id`). An exactly-matched exchange is done —
 *      it takes no interval strays.
 *   2. INTERVAL — the record's capture ts (its request START) falls
 *      inside the exchange's `[startedAt, endedAt]` window (± slack
 *      for clock skew / codex's second-granular rollout stamps),
 *      gated by SOURCE CLASS (below) and by model equality when both
 *      sides carry one. This is what makes codex turn↔calls work
 *      without ids, and it fixes the old point-distance join, which
 *      measured from the turn's END and silently failed for any call
 *      longer than the window.
 *
 * SOURCE CLASS: a member's work interleaves threads — the main
 * conversation, named subagents, server-tool sidecar calls. The
 * genai layer attributes each record (`querySource`); exchanges
 * carry it for codex threads. A main-thread turn's interval would
 * happily swallow a subagent call that ran DURING it, so interval
 * matching only pairs records and exchanges of the same class:
 * main-thread markers (`repl_main_thread` / `codex_main_thread` /
 * absent) join main-thread records; a `codex_subagent:<id>` exchange
 * joins only records with the same tag; everything else
 * (`agent:*`, `web_search_tool`, `away_summary`, …) never joins a
 * turn implicitly and surfaces as an orphan.
 */

import type { ActivityLlmExchange } from 'csuite-sdk/types';

/**
 * The fields the join needs from an inference record — satisfied by
 * both `GenAiInferenceSummary` (timeline) and the full
 * `GenAiInferenceRecord` (TracePanel).
 */
export interface JoinableCall {
  id: number;
  ts: number;
  model: string | null;
  responseId: string | null;
  querySource: string | null;
}

/** One joined turn: the always-present marker plus its API calls. */
export interface TurnJoin<T extends JoinableCall> {
  exchange: ActivityLlmExchange;
  /** The turn's inference records, ts-ascending. Often 1 (Claude), N (codex), or 0 (body never exported). */
  calls: T[];
}

export interface JoinResult<T extends JoinableCall> {
  /** One entry per input exchange, in input order. */
  turns: Array<TurnJoin<T>>;
  /** Records that matched no turn — subagent / sidecar calls, or markers the activity capture missed. Ts-ascending. */
  orphans: T[];
}

/** Clock-skew slack around a turn's [startedAt, endedAt] interval. */
const INTERVAL_SLACK_MS = 2_000;

/**
 * Collapse a `querySource` into its join class. Main-thread spellings
 * unify (Claude exchanges don't stamp one; their records say
 * `repl_main_thread`; codex says `codex_main_thread`); every other
 * source is its own class and only joins its exact counterpart.
 */
export function sourceClass(querySource: string | null | undefined): string {
  if (
    querySource === undefined ||
    querySource === null ||
    querySource === 'repl_main_thread' ||
    querySource === 'codex_main_thread'
  ) {
    return 'main';
  }
  return querySource;
}

/**
 * Join inference records onto exchange markers, turn-centric. Pure;
 * input order of `exchanges` is preserved in `turns`.
 */
export function joinTurns<T extends JoinableCall>(
  exchanges: ActivityLlmExchange[],
  calls: T[],
): JoinResult<T> {
  const used = new Set<number>();
  const turnCalls = new Map<number, T[]>();
  const exactMatched = new Set<number>();

  // Pass 1 — exact response-id matches.
  const byResponseId = new Map<string, T>();
  for (const call of calls) {
    if (call.responseId !== null && !byResponseId.has(call.responseId)) {
      byResponseId.set(call.responseId, call);
    }
  }
  exchanges.forEach((ex, exIndex) => {
    const rid = ex.entry.response?.responseId;
    if (typeof rid !== 'string') return;
    const call = byResponseId.get(rid);
    if (call === undefined || used.has(call.id)) return;
    turnCalls.set(exIndex, [call]);
    used.add(call.id);
    exactMatched.add(exIndex);
  });

  // Pass 2 — interval containment for the rest. Each remaining call
  // picks the turn whose window it falls into (same source class,
  // compatible model); ties go to the window it sits deepest inside,
  // then the nearest start. Exactly-matched exchanges don't
  // participate — their call identity is already known, and a stray
  // main-thread record in their window (e.g. a compaction call the
  // transcript never logged) should surface as an orphan instead of
  // being silently glued to the wrong turn.
  for (const call of calls) {
    if (used.has(call.id)) continue;
    const callClass = sourceClass(call.querySource);
    let bestIndex = -1;
    let bestOutside = Number.POSITIVE_INFINITY;
    let bestStartDelta = Number.POSITIVE_INFINITY;
    exchanges.forEach((ex, exIndex) => {
      if (exactMatched.has(exIndex)) return;
      if (sourceClass(ex.querySource) !== callClass) return;
      const exModel = ex.entry.request.model;
      if (exModel !== null && call.model !== null && exModel !== call.model) return;
      const start = ex.entry.startedAt;
      const end = Math.max(ex.entry.endedAt, start);
      const outside = Math.max(0, start - call.ts, call.ts - end);
      if (outside > INTERVAL_SLACK_MS) return;
      const startDelta = Math.abs(call.ts - start);
      if (outside < bestOutside || (outside === bestOutside && startDelta < bestStartDelta)) {
        bestIndex = exIndex;
        bestOutside = outside;
        bestStartDelta = startDelta;
      }
    });
    if (bestIndex >= 0) {
      const list = turnCalls.get(bestIndex);
      if (list === undefined) turnCalls.set(bestIndex, [call]);
      else list.push(call);
      used.add(call.id);
    }
  }

  const turns = exchanges.map((ex, exIndex) => {
    const list = turnCalls.get(exIndex) ?? [];
    list.sort((a, b) => a.ts - b.ts);
    return { exchange: ex, calls: list };
  });
  const orphans = calls.filter((c) => !used.has(c.id)).sort((a, b) => a.ts - b.ts);
  return { turns, orphans };
}
