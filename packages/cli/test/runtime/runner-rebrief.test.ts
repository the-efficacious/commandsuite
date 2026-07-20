/**
 * Runner context re-brief tests.
 *
 * The doctrine: static surfaces (system prompt, tool descriptions) are
 * frozen per session so the model's prompt-prefix cache survives; live
 * state reaches the agent as message traffic. The re-brief is the
 * re-assertion path — a `context_refresh` channel push composed from
 * the live open-objectives snapshot, sent when a fresh MCP session
 * attaches (first `tools/list` on a new bridge connection).
 *
 * These tests connect a FAKE bridge (raw UDS socket speaking the IPC
 * frame protocol) so they exercise the runner side end-to-end without
 * requiring the cli to be built. This is the guardrail the old
 * "refresh via tools/list_changed" design never had — it silently
 * became dead code because nothing asserted a notification actually
 * reached a bridge.
 */

import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerHandle } from '../../src/runtime/runner.js';
import { startRunner } from '../../src/runtime/runner.js';
import {
  FAKE_BROKER_NAME,
  FAKE_BROKER_TOKEN,
  type FakeBroker,
  fakeBrokerObjectives,
  startFakeBroker,
} from './fake-broker.js';

interface ReceivedFrame {
  kind: string;
  id?: number;
  method?: string;
  result?: unknown;
  params?: { content?: string; meta?: Record<string, string> };
}

function makeObjective(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'obj-77',
    title: 'Restore search indexing',
    body: '',
    outcome: 'Search results include documents created in the last hour.',
    status: 'active',
    assignee: FAKE_BROKER_NAME,
    originator: 'director-1',
    watchers: [],
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    result: null,
    blockReason: null,
    attachments: [],
    ...overrides,
  };
}

async function connectFakeBridge(
  socketPath: string,
): Promise<{ socket: Socket; received: ReceivedFrame[] }> {
  const socket = connect({ path: socketPath });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const received: ReceivedFrame[] = [];
  createInterface({ input: socket, crlfDelay: Infinity }).on('line', (line) => {
    try {
      received.push(JSON.parse(line) as ReceivedFrame);
    } catch {
      /* runner only writes JSON frames */
    }
  });
  return { socket, received };
}

function sendFrame(socket: Socket, frame: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
}

const isRebrief = (f: ReceivedFrame): boolean =>
  f.kind === 'mcp_notification' &&
  f.method === 'notifications/claude/channel' &&
  f.params?.meta?.kind === 'context_refresh';

describe('runner context re-brief', () => {
  let broker: FakeBroker | null = null;
  let runner: RunnerHandle | null = null;
  let socket: Socket | null = null;

  afterEach(async () => {
    socket?.destroy();
    socket = null;
    if (runner) {
      await runner.shutdown('test-teardown');
      await runner.waitClosed;
      runner = null;
    }
    await broker?.close();
    broker = null;
    fakeBrokerObjectives.length = 0;
  });

  it('pushes a context_refresh after the first tools/list when objectives are open', async () => {
    fakeBrokerObjectives.length = 0;
    fakeBrokerObjectives.push(makeObjective());

    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      log: () => {},
      noTrace: true,
    });

    const bridge = await connectFakeBridge(runner.socketPath);
    socket = bridge.socket;
    const { received } = bridge;

    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => received.some(isRebrief));

    // The tools/list response must be on the wire BEFORE the re-brief —
    // the notification must never beat the response it piggybacks on.
    const responseIdx = received.findIndex((f) => f.kind === 'mcp_response' && f.id === 1);
    const rebriefIdx = received.findIndex(isRebrief);
    expect(responseIdx).toBeGreaterThanOrEqual(0);
    expect(responseIdx).toBeLessThan(rebriefIdx);

    const rebrief = received[rebriefIdx];
    expect(rebrief?.params?.content).toContain('obj-77');
    expect(rebrief?.params?.content).toContain('Restore search indexing');
    expect(rebrief?.params?.content).toContain(
      'Search results include documents created in the last hour.',
    );
    expect(rebrief?.params?.meta?.from).toBe('csuite');
    expect(rebrief?.params?.meta?.reason).toBe('session-start');
    expect(rebrief?.params?.meta?.ts_ms).toMatch(/^\d+$/);

    // A second tools/list on the SAME connection must not re-brief
    // again — the trigger is session attach, not every list call.
    sendFrame(socket, { kind: 'mcp_request', id: 2, method: 'tools/list' });
    await waitFor(() => received.some((f) => f.kind === 'mcp_response' && f.id === 2));
    await new Promise((r) => setTimeout(r, 100));
    expect(received.filter(isRebrief)).toHaveLength(1);
  });

  it('renders blocked objectives with their block reason', async () => {
    fakeBrokerObjectives.length = 0;
    fakeBrokerObjectives.push(
      makeObjective({
        id: 'obj-88',
        title: 'Rotate signing keys',
        status: 'blocked',
        blockReason: 'waiting on ops approval',
      }),
    );

    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      log: () => {},
      noTrace: true,
    });

    const bridge = await connectFakeBridge(runner.socketPath);
    socket = bridge.socket;
    const { received } = bridge;

    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => received.some(isRebrief));

    const rebrief = received.find(isRebrief);
    expect(rebrief?.params?.content).toContain('[blocked]');
    expect(rebrief?.params?.content).toContain('waiting on ops approval');
  });

  it('stays silent when the plate is empty', async () => {
    fakeBrokerObjectives.length = 0;

    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      log: () => {},
      noTrace: true,
    });

    const bridge = await connectFakeBridge(runner.socketPath);
    socket = bridge.socket;
    const { received } = bridge;

    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => received.some((f) => f.kind === 'mcp_response' && f.id === 1));
    // Give a would-be re-brief time to land, then assert it didn't.
    await new Promise((r) => setTimeout(r, 150));
    expect(received.filter(isRebrief)).toHaveLength(0);
  });
});
