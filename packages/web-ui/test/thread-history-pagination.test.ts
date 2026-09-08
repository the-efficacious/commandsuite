/**
 * The transcript's "load older" pager sends a composite cursor.
 *
 * This surface had no pagination test at all while it used the exact
 * pattern the activity pager next door names in its own comment as the
 * one that loses rows — `before: oldest.ts`. The helper being right is
 * not the deliverable; what a viewer scrolling a busy channel actually
 * gets is, so the assertion here is the request that leaves the browser
 * and the messages that end up rendered.
 */

import { Client } from 'csuite-sdk/client';
import type { Message } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import {
  __resetMessagesForTests,
  appendMessages,
  PRIMARY_THREAD,
  threadMessages,
} from '../src/lib/messages.js';
import {
  __resetThreadHistoryForTests,
  loadOlderThreadMessages,
  threadHistoryState,
} from '../src/lib/thread-history.js';

const originalFetch = globalThis.fetch;
const VIEWER = 'alice';
/** One millisecond shared by several posts — the collision that used to lose rows. */
const TIED_MS = 1_700_000_100_000;

function message(id: string, ts: number): Message {
  return {
    id,
    ts,
    to: null,
    from: 'bob',
    title: null,
    body: id,
    level: 'info',
    data: {},
    attachments: [],
  };
}

function reset(): void {
  __resetClientForTests();
  __resetMessagesForTests();
  __resetThreadHistoryForTests();
}

beforeEach(reset);
afterEach(() => {
  globalThis.fetch = originalFetch;
  reset();
});

describe('thread history pagination', () => {
  it('anchors on the furthest-back message under the server ordering, not the local head', async () => {
    const requests: URL[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      requests.push(url);
      return new Response(JSON.stringify({ messages: [message('m-a', TIED_MS)] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    setClient(new Client({ url: 'http://localhost', useCookies: true }));

    // Two posts in one tick; the older of the two is the page anchor.
    appendMessages(VIEWER, [message('m-c', TIED_MS), message('m-b', TIED_MS)]);
    await loadOlderThreadMessages(VIEWER, PRIMARY_THREAD);

    const sent = requests[0];
    expect(sent).toBeDefined();
    expect(sent?.searchParams.get('before_ts')).toBe(String(TIED_MS));
    // The half that makes the walk complete. Without it the request is
    // "everything strictly older than this millisecond", which silently
    // excludes `m-a`.
    expect(sent?.searchParams.get('before_id')).toBe('m-b');
    // And the retired scalar spelling must not be what goes out.
    expect(sent?.searchParams.has('before')).toBe(false);
  });

  it('renders the message that a timestamp-only anchor would have skipped', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ messages: [message('m-a', TIED_MS)] }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    setClient(new Client({ url: 'http://localhost', useCookies: true }));

    appendMessages(VIEWER, [message('m-c', TIED_MS), message('m-b', TIED_MS)]);
    await loadOlderThreadMessages(VIEWER, PRIMARY_THREAD);

    // Every id exactly once. The local store orders on `ts` alone, so
    // within the tie its order is merge order — what matters is that
    // `m-a`, which the timestamp-only anchor could never have asked
    // for, is present at all.
    expect([...threadMessages(PRIMARY_THREAD)].map((m) => m.id).sort()).toEqual([
      'm-a',
      'm-b',
      'm-c',
    ]);
  });

  it('does not page at all when the thread has no messages yet', async () => {
    // Positive control the other way: a first "load older" with nothing
    // held must send no cursor rather than an anchor built from
    // undefined, which would read as the string "undefined" on the wire.
    const requests: URL[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(
        new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      );
      return new Response(JSON.stringify({ messages: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    setClient(new Client({ url: 'http://localhost', useCookies: true }));

    await loadOlderThreadMessages(VIEWER, PRIMARY_THREAD);

    expect(requests[0]?.searchParams.has('before_ts')).toBe(false);
    expect(requests[0]?.searchParams.has('before_id')).toBe(false);
    expect(threadHistoryState(PRIMARY_THREAD).exhausted).toBe(true);
  });
});
