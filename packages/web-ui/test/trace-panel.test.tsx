/**
 * TracePanel render tests.
 *
 * We render the component with a stubbed client that returns
 * canned member-activity rows, then assert:
 *
 *   - LLM exchanges surface model, token counts, text blocks,
 *     and tool_use blocks
 *   - Empty result shows the "no exchanges" placeholder
 *   - Fetch errors render an error banner, not a crash
 *
 * The director gate is enforced one level up in ObjectiveDetail
 * (client) and at the GET /members/:name/activity server
 * endpoint. The server endpoint test in
 * apps/server/test/member-activity.test.ts is the source of truth
 * for the gate.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { Client } from 'csuite-sdk/client';
import type { ActivityRow, ListActivityResponse, Objective } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TracePanel } from '../src/components/TracePanel.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetClientForTests();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function stubActivity(body: ListActivityResponse | Record<string, unknown>, status = 200): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;
  // Build the SDK client AFTER the fetch stub is in place — the
  // client captures the current `globalThis.fetch` at construction.
  setClient(new Client({ url: 'http://localhost', useCookies: true }));
}

const objective: Objective = {
  id: 'obj-1',
  title: 'Ship the feature',
  body: '',
  outcome: 'Feature shipped',
  status: 'active',
  assignee: 'engineer-1',
  originator: 'director-1',
  watchers: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  completedAt: null,
  result: null,
  blockReason: null,
  attachments: [],
};

const llmRow: ActivityRow = {
  id: 1,
  memberName: 'engineer-1',
  createdAt: 1_700_000_000_500,
  event: {
    kind: 'llm_exchange',
    ts: 1_700_000_000_000,
    duration: 200,
    entry: {
      kind: 'anthropic_messages',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_000_200,
      request: {
        model: 'claude-sonnet-4-6',
        maxTokens: 2048,
        temperature: null,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }],
        tools: null,
      },
      response: {
        stopReason: 'end_turn',
        stopSequence: null,
        status: 200,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'general kenobi' },
              { type: 'tool_use', id: 'tu_1', name: 'get_time', input: { tz: 'UTC' } },
            ],
          },
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: 5,
        },
      },
    },
  },
};

describe('TracePanel', () => {
  it('renders llm exchanges with model + usage + messages', async () => {
    stubActivity({ activity: [llmRow] });
    render(<TracePanel objective={objective} />);

    await waitFor(() => expect(screen.getByText(/LLM turns \(1\)/)).toBeTruthy());
    // Model id is prettified for display.
    expect(screen.getByText('Sonnet 4.6')).toBeTruthy();
    expect(screen.getByText(/in=10/)).toBeTruthy();
    expect(screen.getByText(/out=4/)).toBeTruthy();
    expect(screen.getByText(/cache_hit=5/)).toBeTruthy();
    expect(screen.getByText('hello there')).toBeTruthy();
    expect(screen.getByText('general kenobi')).toBeTruthy();
    expect(screen.getByText('get_time')).toBeTruthy();
  });

  it('renders the no-exchanges placeholder when the list is empty', async () => {
    stubActivity({ activity: [] });
    render(<TracePanel objective={objective} />);

    await waitFor(() => expect(screen.getByText(/no llm exchanges captured/i)).toBeTruthy());
  });

  it('renders an error banner on fetch failure', async () => {
    stubActivity({ error: 'server on fire' }, 500);
    render(<TracePanel objective={objective} />);

    await waitFor(() => {
      const banner = screen.queryByText(/server on fire|HTTP 500|500/);
      expect(banner).toBeTruthy();
    });
  });
});

// ─── GenAI enrichment: joinTurns + enriched rendering ──────────────

import type { ActivityLlmExchange, GenAiInferenceRecord } from 'csuite-sdk/types';
import { joinTurns } from '../src/components/TracePanel.js';

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

describe('TracePanel — genai enrichment', () => {
  function stubRouted(activity: unknown, genai: unknown): void {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = url.includes('/genai') ? genai : activity;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as typeof fetch;
    setClient(new Client({ url: 'http://localhost', useCookies: true }));
  }

  it('renders system instructions and input context from the joined record', async () => {
    const ex = mkExchange({ ts: 1_700_000_000_000, responseId: 'msg_A' });
    const inf = mkInference({ id: 1, ts: 1_700_000_000_000, responseId: 'msg_A' });
    stubRouted(
      { activity: [{ id: 1, memberName: 'engineer-1', createdAt: ex.ts, event: ex }] },
      { inferences: [inf] },
    );
    render(<TracePanel objective={objective} />);

    await waitFor(() =>
      expect(screen.getByText(/LLM turns \(1 · 1 with full request\)/)).toBeTruthy(),
    );
    expect(screen.getByText(/system instructions \(1 block\)/)).toBeTruthy();
    expect(screen.getByText(/You are Claude Code, full block\./)).toBeTruthy();
    expect(screen.getByText(/input context \(1 message\)/)).toBeTruthy();
    expect(screen.getByText(/the actual prompt/)).toBeTruthy();
    expect(screen.getByText('repl_main_thread')).toBeTruthy();
    expect(screen.queryByText(/marker only/)).toBeNull();
  });

  it('renders unmatched exchanges as marker-only rows', async () => {
    const ex = mkExchange({ ts: 1_700_000_000_000 });
    stubRouted(
      { activity: [{ id: 1, memberName: 'engineer-1', createdAt: ex.ts, event: ex }] },
      { inferences: [] },
    );
    render(<TracePanel objective={objective} />);

    await waitFor(() => expect(screen.getByText(/LLM turns \(1\)/)).toBeTruthy());
    expect(screen.getByText(/marker only/)).toBeTruthy();
    expect(screen.queryByText(/system instructions/)).toBeNull();
  });

  it('renders turnless records as attributed sidecar rows', async () => {
    const ex = mkExchange({ ts: 1_700_000_000_000, responseId: 'msg_A' });
    const main = mkInference({ id: 1, ts: 1_700_000_000_000, responseId: 'msg_A' });
    const sidecar = mkInference({
      id: 2,
      ts: 1_700_000_002_000,
      querySource: 'web_search_tool',
      model: 'claude-haiku-4-5',
    });
    stubRouted(
      { activity: [{ id: 1, memberName: 'engineer-1', createdAt: ex.ts, event: ex }] },
      { inferences: [main, sidecar] },
    );
    render(<TracePanel objective={objective} />);

    await waitFor(() =>
      expect(screen.getByText(/LLM turns \(1 · 1 with full request · 1 sidecar\)/)).toBeTruthy(),
    );
    expect(screen.getByText('web search')).toBeTruthy();
    expect(screen.getByText('Haiku 4.5')).toBeTruthy();
  });

  it('lists every aggregated call of a codex turn', async () => {
    const ex = mkExchange({
      ts: 1_700_000_000_000,
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_030_000,
      model: 'gpt-5-codex',
      querySource: 'codex_main_thread',
    });
    const calls = [1, 2, 3].map((id) =>
      mkInference({
        id,
        ts: 1_700_000_000_000 + id * 1_000,
        model: 'gpt-5-codex',
        querySource: 'codex_main_thread',
      }),
    );
    stubRouted(
      { activity: [{ id: 1, memberName: 'engineer-1', createdAt: ex.ts, event: ex }] },
      { inferences: calls },
    );
    render(<TracePanel objective={objective} />);

    await waitFor(() =>
      expect(screen.getByText(/LLM turns \(1 · 1 with full request\)/)).toBeTruthy(),
    );
    expect(screen.getByText(/api calls \(3\)/)).toBeTruthy();
  });
});
