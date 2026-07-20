/**
 * Tests for the codex channel sink — the piece that turns broker SSE
 * channel events into either `turn/start` (idle) or `turn/steer`
 * (active) JSON-RPC dispatches against codex.
 *
 * We mock the JsonRpcClient directly rather than wiring to a fake
 * codex; the routing logic is what matters. End-to-end framing is
 * covered by `json-rpc.test.ts`.
 */

import { MCP_CHANNEL_NOTIFICATION } from 'csuite-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  type CodexChannelSinkOptions,
  createCodexChannelSink,
} from '../../../src/runtime/agents/codex/channel-sink.js';
import type { JsonRpcClient } from '../../../src/runtime/agents/codex/json-rpc.js';
import { METHODS, type ThreadStatus } from '../../../src/runtime/agents/codex/protocol.js';

interface MockState {
  threadId: string | null;
  status: ThreadStatus;
  activeTurnId: string | null;
}

function makeSink(initial: Partial<MockState> = {}, requestImpl?: JsonRpcClient['request']) {
  const state: MockState = {
    threadId: initial.threadId ?? 't_test',
    status: initial.status ?? { type: 'idle' },
    activeTurnId: initial.activeTurnId ?? null,
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  const rpc: JsonRpcClient = {
    request:
      requestImpl ??
      ((async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }) as JsonRpcClient['request']),
    notify: vi.fn(),
    onNotification: vi.fn(() => () => {}),
    onRequest: vi.fn(() => () => {}),
    closed: Promise.resolve(),
    close: vi.fn(),
  };
  const opts: CodexChannelSinkOptions = {
    rpc,
    getThreadId: () => state.threadId,
    getStatus: () => state.status,
    getActiveTurnId: () => state.activeTurnId,
    log: () => {},
    bundleWindowMs: 5,
  };
  const sink = createCodexChannelSink(opts);
  return { sink, state, requests, rpc };
}

const channelMethod = MCP_CHANNEL_NOTIFICATION;

async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('createCodexChannelSink', () => {
  it('dispatches a single turn/start when idle', async () => {
    const { sink, requests } = makeSink({ status: { type: 'idle' } });
    await sink.notification({
      method: channelMethod,
      params: { content: 'hello there', meta: { from: 'director', kind: 'chat' } },
    });
    await tick();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe(METHODS.turnStart);
    const params = requests[0]?.params as {
      threadId: string;
      input: Array<{ type: string; text: string }>;
    };
    expect(params.threadId).toBe('t_test');
    expect(params.input).toHaveLength(1);
    expect(params.input[0]?.type).toBe('text');
    expect(params.input[0]?.text).toContain('hello there');
    expect(params.input[0]?.text).toContain('from="director"');
    expect(params.input[0]?.text).toContain('kind="chat"');
  });

  it('dispatches a turn/steer with expectedTurnId when active', async () => {
    const { sink, requests } = makeSink({
      status: { type: 'active' },
      activeTurnId: 'turn_42',
    });
    await sink.notification({
      method: channelMethod,
      params: { content: 'mid-turn signal', meta: {} },
    });
    await tick();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe(METHODS.turnSteer);
    expect(requests[0]?.params).toMatchObject({
      threadId: 't_test',
      expectedTurnId: 'turn_42',
    });
  });

  it('bundles multiple events arriving inside the window into one dispatch', async () => {
    const { sink, requests } = makeSink({ status: { type: 'idle' } });
    await sink.notification({
      method: channelMethod,
      params: { content: 'first', meta: { from: 'a' } },
    });
    await sink.notification({
      method: channelMethod,
      params: { content: 'second', meta: { from: 'b' } },
    });
    await sink.notification({
      method: channelMethod,
      params: { content: 'third', meta: { from: 'c' } },
    });
    await tick();
    expect(requests).toHaveLength(1);
    const text = (requests[0]?.params as { input: Array<{ text: string }> }).input[0]?.text;
    expect(text).toContain('first');
    expect(text).toContain('second');
    expect(text).toContain('third');
  });

  it('drops non-channel notifications silently', async () => {
    const { sink, requests } = makeSink();
    await sink.notification({
      method: 'notifications/tools/list_changed',
      params: {},
    });
    await tick();
    expect(requests).toHaveLength(0);
  });

  it('re-buffers when threadId is null and flushes after threadId arrives', async () => {
    const { sink, state, requests } = makeSink({
      threadId: null,
      status: { type: 'notLoaded' },
    });
    await sink.notification({
      method: channelMethod,
      params: { content: 'early event', meta: {} },
    });
    await tick();
    expect(requests).toHaveLength(0);

    // Thread/start completes — adapter flips state and calls flushNow.
    state.threadId = 't_later';
    state.status = { type: 'idle' };
    await sink.flushNow();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe(METHODS.turnStart);
    expect((requests[0]?.params as { input: Array<{ text: string }> }).input[0]?.text).toContain(
      'early event',
    );
  });

  it('drops events when status is systemError', async () => {
    const { sink, requests } = makeSink({
      status: { type: 'systemError' },
    });
    await sink.notification({
      method: channelMethod,
      params: { content: 'wasted', meta: {} },
    });
    await tick();
    expect(requests).toHaveLength(0);
  });

  it('retries as turn/start when steer fails with expected-turn-mismatch and status is now idle', async () => {
    // Pattern: the very act of the failed steer (codex returning the
    // mismatch error) tells us codex has moved on. We simulate that by
    // mutating state inside the requestImpl when steer is called — by
    // the time the channel sink re-reads getStatus(), the new state
    // is observable. This avoids racing wallclock timers against the
    // bundle window.
    const calls: Array<{ method: string }> = [];
    let state: MockState | null = null;
    const requestImpl: JsonRpcClient['request'] = (async (method: string, _params: unknown) => {
      calls.push({ method });
      if (method === METHODS.turnSteer) {
        // Codex would have emitted `thread/status/changed` to idle
        // around the time it rejected the steer. The adapter's
        // notification handler flips state; for the test we mutate
        // directly.
        if (state !== null) {
          state.status = { type: 'idle' };
          state.activeTurnId = null;
        }
        throw new Error('expected active turn id `old` but found `new`');
      }
      return {};
    }) as JsonRpcClient['request'];
    const made = makeSink(
      {
        status: { type: 'active' },
        activeTurnId: 'old',
      },
      requestImpl,
    );
    state = made.state;

    await made.sink.notification({
      method: channelMethod,
      params: { content: 'racy', meta: {} },
    });
    await tick(30);
    expect(calls.map((c) => c.method)).toEqual([METHODS.turnSteer, METHODS.turnStart]);
    expect(made.requests).toHaveLength(0);
  });
});
