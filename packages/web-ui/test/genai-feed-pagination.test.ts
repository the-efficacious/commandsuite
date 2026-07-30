import { Client } from 'csuite-sdk/client';
import type { GenAiInferenceSummary } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import {
  __resetGenAiCallFeedForTests,
  hydrateGenAiCalls,
  memberGenAiCalls,
  startGenAiCallFeed,
} from '../src/lib/genai-feed.js';

const originalFetch = globalThis.fetch;

function summary(id: number): GenAiInferenceSummary {
  return {
    id,
    memberName: 'engineer-1',
    operationName: 'chat',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    responseId: `msg_${id}`,
    finishReasons: ['end_turn'],
    usage: null,
    querySource: 'repl_main_thread',
    agentName: null,
    ts: 1_000,
    receivedAt: 1_001,
  };
}

beforeEach(() => {
  __resetClientForTests();
  __resetGenAiCallFeedForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetClientForTests();
  __resetGenAiCallFeedForTests();
});

describe('GenAI feed pagination', () => {
  it('hydrates every summary without silently capping the ledger at 2000 calls', async () => {
    const rows = Array.from({ length: 2_001 }, (_, index) => summary(index + 1));
    globalThis.fetch = (async (input) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const cursorTs = url.searchParams.get('cursor_ts');
      const cursorId = url.searchParams.get('cursor_id');
      const offset = cursorId === null ? 0 : Number(cursorId);
      expect(cursorTs).toBe(cursorId === null ? null : '1000');
      expect([0, 1_000, 2_000]).toContain(offset);
      return new Response(JSON.stringify({ inferences: rows.slice(offset, offset + 1_000) }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    setClient(new Client({ url: 'http://localhost', useCookies: true }));
    startGenAiCallFeed('engineer-1');

    await hydrateGenAiCalls(1_000);

    expect(memberGenAiCalls.value.map((item) => item.id)).toEqual(
      Array.from({ length: 2_001 }, (_, index) => index + 1),
    );
  });
});
