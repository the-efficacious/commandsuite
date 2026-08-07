/**
 * Codex compaction — request/ack correlation.
 *
 * The property that carries this file: `thread/compact/start` resolves
 * with an EMPTY OBJECT. It acknowledges the ask and says nothing about
 * the effect, so a compactor that resolved on the response would
 * report a success it never observed — the exact failure the broker's
 * context-control acknowledgement exists to prevent.
 *
 * So the tests are built around a mock JSON-RPC client that answers
 * the request but is made to emit (or withhold) the
 * `contextCompaction` item independently. A correlation that cheated
 * and resolved early passes none of them.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  attachCodexCompactor,
  type CodexCompactOutcome,
} from '../../../src/runtime/agents/codex/compaction.js';
import type { JsonRpcClient } from '../../../src/runtime/agents/codex/json-rpc.js';
import { METHODS, NOTIFICATIONS } from '../../../src/runtime/agents/codex/protocol.js';

function harness(opts: { threadId?: string | null; requestImpl?: () => Promise<unknown> } = {}) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const logs: string[] = [];
  let itemCompleted: ((params: unknown) => void) | null = null;
  let unsubscribed = 0;

  const rpc: JsonRpcClient = {
    request: (async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (opts.requestImpl) return opts.requestImpl();
      return {};
    }) as JsonRpcClient['request'],
    notify: vi.fn(),
    onNotification: ((method: string, handler: (p: unknown) => void) => {
      if (method === NOTIFICATIONS.itemCompleted) itemCompleted = handler;
      return () => {
        unsubscribed += 1;
      };
    }) as JsonRpcClient['onNotification'],
    onRequest: vi.fn(() => () => {}),
    close: vi.fn(),
  } as unknown as JsonRpcClient;

  const compactor = attachCodexCompactor({
    rpc,
    getThreadId: () => (opts.threadId === undefined ? 't_test' : opts.threadId),
    log: (msg) => logs.push(msg),
  });

  return {
    compactor,
    requests,
    logs,
    unsubscribedCount: () => unsubscribed,
    /** Emit an `item/completed` for the given item type. */
    complete(type: string) {
      itemCompleted?.({ item: { id: 'i_1', type }, turnId: 'turn_1' });
    },
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('request and acknowledgement', () => {
  it('sends thread/compact/start with the thread id', async () => {
    const h = harness();
    const pending = h.compactor.request(1000);
    await tick();

    expect(h.requests).toEqual([
      { method: METHODS.threadCompactStart, params: { threadId: 't_test' } },
    ]);

    h.complete('contextCompaction');
    await expect(pending).resolves.toEqual({ applied: true });
  });

  it('does NOT resolve on the empty response alone', async () => {
    const h = harness();
    let settled: CodexCompactOutcome | null = null;
    const pending = h.compactor.request(1000).then((o) => {
      settled = o;
      return o;
    });

    // The RPC has answered by now — an implementation that resolved on
    // the response would already be done, and would be wrong.
    await tick();
    await tick();
    expect(settled).toBeNull();

    h.complete('contextCompaction');
    await pending;
    expect(settled).toEqual({ applied: true });
  });

  it('ignores unrelated item types', async () => {
    const h = harness();
    let settled = false;
    const pending = h.compactor.request(1000).then((o) => {
      settled = true;
      return o;
    });
    await tick();

    h.complete('agentMessage');
    h.complete('commandExecution');
    await tick();
    expect(settled).toBe(false);

    // Positive control: the right item still lands.
    h.complete('contextCompaction');
    await expect(pending).resolves.toEqual({ applied: true });
  });

  it('reports applied WITHOUT token counts — codex measures none', async () => {
    const h = harness();
    const pending = h.compactor.request(1000);
    await tick();
    h.complete('contextCompaction');

    // Absent numbers stay absent. An invented zero would render as
    // "compacted to nothing" on the member's timeline.
    const outcome = await pending;
    expect(outcome).toEqual({ applied: true });
    expect(outcome).not.toHaveProperty('tokensBefore');
  });
});

describe('the paths that must still answer', () => {
  it('answers rather than throwing when the RPC rejects', async () => {
    const h = harness({
      requestImpl: async () => {
        throw new Error('thread is not loaded');
      },
    });

    // Every path owes the broker an outcome, so a transport failure is
    // a result and not an exception.
    await expect(h.compactor.request(1000)).resolves.toEqual({
      applied: false,
      detail: 'codex refused the compaction request: thread is not loaded',
    });
  });

  it('answers when no thread is open yet', async () => {
    const h = harness({ threadId: null });
    await expect(h.compactor.request(1000)).resolves.toEqual({
      applied: false,
      detail: 'no codex thread is open yet',
    });
    expect(h.requests).toEqual([]);
  });

  it('refuses a second concurrent request instead of losing the first', async () => {
    const h = harness();
    const first = h.compactor.request(1000);
    await tick();

    await expect(h.compactor.request(1000)).resolves.toEqual({
      applied: false,
      detail: 'a compaction request is already in flight',
    });

    // The first is still live and still correlates.
    h.complete('contextCompaction');
    await expect(first).resolves.toEqual({ applied: true });
  });

  it('times out rather than hanging the broker request forever', async () => {
    const h = harness();
    // Real timeout is 3 minutes; 1ms here exercises the same path.
    const outcome = await h.compactor.request(1);
    expect(outcome.applied).toBe(false);
    expect((outcome as { detail: string }).detail).toContain('did not report');
  });

  it('settles an in-flight request when the session ends', async () => {
    const h = harness();
    const pending = h.compactor.request(60_000);
    await tick();

    h.compactor.close();

    // Without this the control would sit outstanding for the full
    // timeout against a codex that is already gone.
    await expect(pending).resolves.toEqual({
      applied: false,
      detail: 'the codex session ended before compaction completed',
    });
    expect(h.unsubscribedCount()).toBe(1);
  });
});

describe('compactions we did not ask for', () => {
  it('notes an unrequested compaction without attributing it', async () => {
    const h = harness();

    // Codex auto-compacts on its own. Acking that against whatever
    // request id came next would close out the wrong thing.
    h.complete('contextCompaction');
    await tick();
    expect(h.logs).toContain('codex: observed a compaction we did not request');

    // And a subsequent real request is unaffected by it.
    const pending = h.compactor.request(1000);
    await tick();
    h.complete('contextCompaction');
    await expect(pending).resolves.toEqual({ applied: true });
  });
});
