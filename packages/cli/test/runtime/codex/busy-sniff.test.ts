/**
 * Tests for the codex tool-busy sniff layer.
 *
 * Drives the real `attachCodexBusySniff` helper against the real
 * JSON-RPC client over a pair of in-memory streams — same wiring the
 * adapter uses in production, no subprocess required.
 *
 * Pins the contract:
 *   - `item/started` with a TOOL_ITEM_TYPES type bumps tool_inflight
 *   - `item/started` with a non-tool type (agentMessage, reasoning,
 *     userMessage) is a no-op
 *   - matching `item/completed` decrements
 *   - missing `item/completed` is swept by `turn/completed`
 *   - explicit `drain()` finishes anything left over
 */

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { attachCodexBusySniff } from '../../../src/runtime/agents/codex/busy-sniff.js';
import { createJsonRpcClient } from '../../../src/runtime/agents/codex/json-rpc.js';
import { createBusySignal } from '../../../src/runtime/trace/busy.js';

function pair(): {
  client: ReturnType<typeof createJsonRpcClient>;
  send: (notification: unknown) => void;
  cleanup: () => void;
} {
  const serverOut = new PassThrough();
  const serverIn = new PassThrough();
  const client = createJsonRpcClient(serverOut, serverIn);
  // The notification stream is server→client; we WRITE to serverOut
  // and the client reads it. Each message is one JSON line.
  const send = (notification: unknown): void => {
    serverOut.write(`${JSON.stringify(notification)}\n`);
  };
  return {
    client,
    send,
    cleanup: () => {
      client.close('test-end');
      serverOut.destroy();
      serverIn.destroy();
    },
  };
}

// Vitest waits for events to drain between writes; in practice the
// notifications post within microtask order, but a small delay makes
// the test resilient to scheduler quirks.
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('attachCodexBusySniff', () => {
  const teardowns: Array<() => void> = [];

  afterEach(() => {
    while (teardowns.length > 0) teardowns.pop()?.();
  });

  it('bumps tool_inflight on commandExecution start and drains on completion', async () => {
    const { client, send, cleanup } = pair();
    teardowns.push(cleanup);
    const busy = createBusySignal();
    attachCodexBusySniff({ rpc: client, busy });

    send({
      method: 'item/started',
      params: {
        threadId: 't1',
        turnId: 'turn-1',
        item: { type: 'commandExecution', id: 'item-1', command: 'ls' },
      },
    });
    await tick();
    expect(busy.busy).toBe(true);
    expect(busy.getSourceCounts().tool_inflight).toBe(1);

    send({
      method: 'item/completed',
      params: {
        threadId: 't1',
        turnId: 'turn-1',
        item: { type: 'commandExecution', id: 'item-1' },
      },
    });
    await tick();
    expect(busy.busy).toBe(false);
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('bumps for fileChange and mcpToolCall types too', async () => {
    const { client, send, cleanup } = pair();
    teardowns.push(cleanup);
    const busy = createBusySignal();
    attachCodexBusySniff({ rpc: client, busy });

    for (const [type, id] of [
      ['fileChange', 'fc-1'],
      ['mcpToolCall', 'mcp-1'],
    ]) {
      send({
        method: 'item/started',
        params: { threadId: 't1', turnId: 'turn-1', item: { type, id } },
      });
    }
    await tick();
    expect(busy.getSourceCounts().tool_inflight).toBe(2);
  });

  it('does NOT bump for non-tool item types (agentMessage, reasoning, userMessage)', async () => {
    const { client, send, cleanup } = pair();
    teardowns.push(cleanup);
    const busy = createBusySignal();
    attachCodexBusySniff({ rpc: client, busy });

    for (const type of ['agentMessage', 'reasoning', 'userMessage', 'turnPlan']) {
      send({
        method: 'item/started',
        params: { threadId: 't1', turnId: 'turn-1', item: { type, id: `${type}-1` } },
      });
    }
    await tick();
    expect(busy.busy).toBe(false);
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('ignores duplicate item/started for the same id', async () => {
    const { client, send, cleanup } = pair();
    teardowns.push(cleanup);
    const busy = createBusySignal();
    attachCodexBusySniff({ rpc: client, busy });

    for (let i = 0; i < 3; i++) {
      send({
        method: 'item/started',
        params: {
          threadId: 't1',
          turnId: 'turn-1',
          item: { type: 'commandExecution', id: 'dup' },
        },
      });
    }
    await tick();
    expect(busy.getSourceCounts().tool_inflight).toBe(1);

    send({
      method: 'item/completed',
      params: { threadId: 't1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'dup' } },
    });
    await tick();
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('turn/completed sweeps tool handles that never got matching item/completed', async () => {
    const { client, send, cleanup } = pair();
    teardowns.push(cleanup);
    const busy = createBusySignal();
    attachCodexBusySniff({ rpc: client, busy });

    // Two tool starts, no completions.
    send({
      method: 'item/started',
      params: { threadId: 't1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'a' } },
    });
    send({
      method: 'item/started',
      params: { threadId: 't1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'b' } },
    });
    await tick();
    expect(busy.getSourceCounts().tool_inflight).toBe(2);

    send({
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: 'turn-1', status: 'completed' } },
    });
    await tick();
    expect(busy.busy).toBe(false);
    expect(busy.getSourceCounts().tool_inflight).toBe(0);
  });

  it('explicit drain() finishes anything still in flight', async () => {
    const { client, send, cleanup } = pair();
    teardowns.push(cleanup);
    const busy = createBusySignal();
    const sniff = attachCodexBusySniff({ rpc: client, busy });

    send({
      method: 'item/started',
      params: {
        threadId: 't1',
        turnId: 'turn-1',
        item: { type: 'commandExecution', id: 'orphan' },
      },
    });
    await tick();
    expect(sniff.inFlight).toBe(1);

    sniff.drain();
    expect(sniff.inFlight).toBe(0);
    expect(busy.busy).toBe(false);
  });

  it('items lacking an id are skipped (cannot key the handle)', async () => {
    const { client, send, cleanup } = pair();
    teardowns.push(cleanup);
    const busy = createBusySignal();
    attachCodexBusySniff({ rpc: client, busy });

    send({
      method: 'item/started',
      params: { threadId: 't1', turnId: 'turn-1', item: { type: 'commandExecution' } },
    });
    await tick();
    expect(busy.busy).toBe(false);
  });
});
