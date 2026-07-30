import { Client } from 'csuite-sdk/client';
import type { ActivityRow } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import {
  __resetMemberActivityForTests,
  loadOlderMemberActivity,
  memberActivityName,
  memberActivityRows,
} from '../src/lib/member-activity.js';

const originalFetch = globalThis.fetch;

function row(id: number): ActivityRow {
  return {
    id,
    memberName: 'engineer-1',
    createdAt: 1_000,
    event: {
      kind: 'tool_action',
      ts: 1_000,
      agent: 'claude',
      source: 'claude_hook',
      toolName: 'Read',
      input: { path: `/tmp/${id}` },
      result: null,
      isError: false,
      durationMs: 1,
    },
  };
}

beforeEach(() => {
  __resetClientForTests();
  __resetMemberActivityForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetClientForTests();
  __resetMemberActivityForTests();
});

describe('member activity pagination', () => {
  it('does not lose rows sharing the page-boundary timestamp', async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      expect(url.searchParams.get('cursor_ts')).toBe('1000');
      expect(url.searchParams.get('cursor_id')).toBe('3');
      expect(url.searchParams.has('to')).toBe(false);
      return new Response(JSON.stringify({ activity: [row(2), row(1)] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    setClient(new Client({ url: 'http://localhost', useCookies: true }));
    memberActivityName.value = 'engineer-1';
    memberActivityRows.value = [row(3), row(4)];

    await loadOlderMemberActivity(2);

    expect(memberActivityRows.value.map((item) => item.id)).toEqual([1, 2, 3, 4]);
  });
});
