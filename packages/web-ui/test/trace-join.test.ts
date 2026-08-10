/**
 * `joinTurns` unit tests — the llm_exchange ↔ GenAI-inference join.
 *
 * These cases were extracted verbatim from the former
 * `trace-panel.test.tsx` when the objectives UI (and with it
 * `TracePanel`, which merely re-exported `joinTurns`) was removed. The
 * join itself lives in `src/lib/trace-join.ts` and is still used by
 * `AgentTimeline`, so the coverage moved here rather than going out
 * with the panel.
 *
 * `trace-join-conformance.test.ts` runs the shared broker/UI corpus and
 * covers exact-id matching, containment, and the model/source-class
 * rejections. Two properties below are NOT in that corpus and are the
 * reason this file exists:
 *
 *   - several calls aggregating into one codex turn, ts-ascending —
 *     every corpus case joins at most one call per turn, so neither the
 *     aggregation nor the ordering is exercised there;
 *   - the positive control for source-class matching — the corpus only
 *     proves a subagent record is REFUSED by a main-thread window, never
 *     that it is ACCEPTED by its own same-tagged exchange. A join that
 *     rejected everything would satisfy the corpus.
 */

import type { ActivityLlmExchange, GenAiInferenceRecord } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { joinTurns } from '../src/lib/trace-join.js';

function mkExchange(overrides: {
  ts: number;
  model?: string;
  responseId?: string | null;
  startedAt?: number;
  endedAt?: number;
  querySource?: string;
}): ActivityLlmExchange {
  return {
    kind: 'llm_exchange',
    ts: overrides.ts,
    duration: 100,
    ...(overrides.querySource !== undefined ? { querySource: overrides.querySource } : {}),
    entry: {
      kind: 'anthropic_messages',
      startedAt: overrides.startedAt ?? overrides.ts,
      endedAt: overrides.endedAt ?? (overrides.startedAt ?? overrides.ts) + 100,
      request: {
        model: overrides.model ?? 'claude-fable-5',
        maxTokens: null,
        temperature: null,
        system: null,
        messages: [],
        tools: null,
      },
      response: {
        stopReason: 'end_turn',
        stopSequence: null,
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
        },
        status: null,
        responseId: overrides.responseId === undefined ? null : overrides.responseId,
      },
    },
  };
}

function mkInference(overrides: {
  id: number;
  ts: number;
  model?: string;
  responseId?: string | null;
  querySource?: string | null;
}): GenAiInferenceRecord {
  return {
    id: overrides.id,
    memberName: 'engineer-1',
    operationName: 'chat',
    provider: 'anthropic',
    model: overrides.model ?? 'claude-fable-5',
    responseId: overrides.responseId === undefined ? null : overrides.responseId,
    finishReasons: ['end_turn'],
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
    },
    systemInstructions: [{ type: 'text', content: 'You are Claude Code, full block.' }],
    inputMessages: [{ role: 'user', parts: [{ type: 'text', content: 'the actual prompt' }] }],
    outputMessages: [{ role: 'assistant', parts: [{ type: 'text', content: 'ok' }] }],
    querySource: overrides.querySource === undefined ? 'repl_main_thread' : overrides.querySource,
    agentName: null,
    ts: overrides.ts,
    receivedAt: overrides.ts + 5,
  };
}

describe('joinTurns', () => {
  const T0 = 1_700_000_000_000;

  it('joins exactly on responseId regardless of timestamp distance', () => {
    const ex = mkExchange({ ts: T0, responseId: 'msg_A' });
    const inf = mkInference({ id: 1, ts: T0 + 90_000, responseId: 'msg_A' });
    const { turns, orphans } = joinTurns([ex], [inf]);
    expect(turns[0]?.calls[0]?.id).toBe(1);
    expect(orphans).toHaveLength(0);
  });

  it('joins by interval containment — a long call still matches at its start', () => {
    // A 52-second call: the record's ts is the request START, the
    // old point-±3s join (measured from the turn end) always missed
    // these. Interval containment must not.
    const ex = mkExchange({ ts: T0, startedAt: T0, endedAt: T0 + 52_000 });
    const inf = mkInference({ id: 1, ts: T0 + 40 });
    const { turns, orphans } = joinTurns([ex], [inf]);
    expect(turns[0]?.calls[0]?.id).toBe(1);
    expect(orphans).toHaveLength(0);
  });

  it('aggregates several calls into one codex turn, ts-ascending', () => {
    const ex = mkExchange({
      ts: T0,
      startedAt: T0,
      endedAt: T0 + 30_000,
      model: 'gpt-5-codex',
      querySource: 'codex_main_thread',
    });
    const calls = [
      mkInference({
        id: 3,
        ts: T0 + 20_000,
        model: 'gpt-5-codex',
        querySource: 'codex_main_thread',
      }),
      mkInference({ id: 1, ts: T0 + 500, model: 'gpt-5-codex', querySource: 'codex_main_thread' }),
      mkInference({
        id: 2,
        ts: T0 + 9_000,
        model: 'gpt-5-codex',
        querySource: 'codex_main_thread',
      }),
    ];
    const { turns, orphans } = joinTurns([ex], calls);
    expect(turns[0]?.calls.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(orphans).toHaveLength(0);
  });

  it('never glues a subagent/sidecar call to a main-thread turn window', () => {
    const ex = mkExchange({ ts: T0, startedAt: T0, endedAt: T0 + 20_000 });
    const subagent = mkInference({
      id: 1,
      ts: T0 + 5_000,
      querySource: 'agent:builtin:general-purpose',
    });
    const sidecar = mkInference({ id: 2, ts: T0 + 6_000, querySource: 'web_search_tool' });
    const { turns, orphans } = joinTurns([ex], [subagent, sidecar]);
    expect(turns[0]?.calls).toHaveLength(0);
    expect(orphans.map((o) => o.id)).toEqual([1, 2]);
  });

  it('matches codex subagent records only to the same-tagged exchange', () => {
    const main = mkExchange({
      ts: T0,
      startedAt: T0,
      endedAt: T0 + 20_000,
      model: 'gpt-5-codex',
      querySource: 'codex_main_thread',
    });
    const sub = mkExchange({
      ts: T0 + 1_000,
      startedAt: T0 + 1_000,
      endedAt: T0 + 15_000,
      model: 'gpt-5-codex',
      querySource: 'codex_subagent:abc12345',
    });
    const subCall = mkInference({
      id: 1,
      ts: T0 + 2_000,
      model: 'gpt-5-codex',
      querySource: 'codex_subagent:abc12345',
    });
    const { turns, orphans } = joinTurns([main, sub], [subCall]);
    expect(turns[0]?.calls).toHaveLength(0);
    expect(turns[1]?.calls[0]?.id).toBe(1);
    expect(orphans).toHaveLength(0);
  });

  it('refuses interval joins across models or outside the slack', () => {
    const ex = mkExchange({ ts: T0, startedAt: T0, endedAt: T0 + 1_000 });
    const wrongModel = mkInference({ id: 1, ts: T0 + 500, model: 'claude-opus-4-8' });
    const tooFar = mkInference({ id: 2, ts: T0 + 10_000 });
    const { turns, orphans } = joinTurns([ex], [wrongModel, tooFar]);
    expect(turns[0]?.calls).toHaveLength(0);
    expect(orphans.map((o) => o.id)).toEqual([1, 2]);
  });

  it('keeps interval strays off an exactly-matched exchange', () => {
    const ex = mkExchange({ ts: T0, startedAt: T0, endedAt: T0 + 10_000, responseId: 'msg_A' });
    const exact = mkInference({ id: 1, ts: T0 + 10, responseId: 'msg_A' });
    // A main-thread record inside the window that is NOT this call
    // (e.g. a compaction call the transcript never logged) must
    // surface as an orphan, not get glued on.
    const stray = mkInference({ id: 2, ts: T0 + 4_000, responseId: 'msg_B' });
    const { turns, orphans } = joinTurns([ex], [exact, stray]);
    expect(turns[0]?.calls.map((c) => c.id)).toEqual([1]);
    expect(orphans.map((o) => o.id)).toEqual([2]);
  });
});
