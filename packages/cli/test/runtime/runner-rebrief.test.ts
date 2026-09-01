/**
 * Runner context re-brief tests.
 *
 * The doctrine: static surfaces (system prompt, tool descriptions) are
 * frozen per session so the model's prompt-prefix cache survives; live
 * state reaches the agent as message traffic. The re-brief is the
 * re-assertion path — a `context_refresh` channel event composed from
 * the live open-objectives snapshot, delivered to the runner's channel
 * sink when a fresh MCP session attaches (first `tools/list` on a new
 * bridge connection).
 *
 * These tests connect a FAKE bridge (raw UDS socket speaking the IPC
 * frame protocol) to fire the session-attach trigger, and a recording
 * channel sink to observe delivery — the same seam the claude and
 * codex sinks implement. This is the guardrail the old "refresh via
 * tools/list_changed" design never had — it silently became dead code
 * because nothing asserted the re-brief actually reached a sink.
 */

import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelEvent } from '../../src/runtime/forwarder.js';
import type { RunnerHandle } from '../../src/runtime/runner.js';
import { startRunner } from '../../src/runtime/runner.js';
import { silentLogger } from '../helpers/logger.js';
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
}

interface RecordedRebrief {
  event: ChannelEvent;
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

const isRebrief = (r: RecordedRebrief): boolean => r.event.meta.kind === 'context_refresh';

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

  it('delivers a context_refresh to the channel sink after the first tools/list', async () => {
    fakeBrokerObjectives.length = 0;
    fakeBrokerObjectives.push(makeObjective());

    broker = await startFakeBroker();
    const delivered: RecordedRebrief[] = [];
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      logger: silentLogger(),
      noTrace: true,
      channelSink: {
        deliver: async (event) => {
          delivered.push({ event });
        },
      },
    });

    const bridge = await connectFakeBridge(runner.socketPath);
    socket = bridge.socket;
    const bridgeFrames = bridge.received;

    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    // Both the tools/list response and the re-brief must land. (The
    // runner defers the re-brief with setImmediate so the response
    // flushes first; that ordering is runner-internal and not
    // observable across the in-process sink vs the socket reader.)
    await waitFor(() => bridgeFrames.some((f) => f.kind === 'mcp_response' && f.id === 1));
    await waitFor(() => delivered.some(isRebrief));

    const rebrief = delivered.find(isRebrief);
    expect(rebrief?.event.content).toContain('obj-77');
    expect(rebrief?.event.content).toContain('Restore search indexing');
    expect(rebrief?.event.content).toContain(
      'Search results include documents created in the last hour.',
    );
    expect(rebrief?.event.meta.from).toBe('csuite');
    expect(rebrief?.event.meta.reason).toBe('session-start');
    expect(rebrief?.event.meta.ts_ms).toMatch(/^\d+$/);

    // A second tools/list on the SAME connection must not re-brief
    // again — the trigger is session attach, not every list call.
    sendFrame(socket, { kind: 'mcp_request', id: 2, method: 'tools/list' });
    await waitFor(() => bridgeFrames.some((f) => f.kind === 'mcp_response' && f.id === 2));
    await new Promise((r) => setTimeout(r, 100));
    expect(delivered.filter(isRebrief)).toHaveLength(1);
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
    const delivered: RecordedRebrief[] = [];
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      logger: silentLogger(),
      noTrace: true,
      channelSink: {
        deliver: async (event) => {
          delivered.push({ event });
        },
      },
    });

    const bridge = await connectFakeBridge(runner.socketPath);
    socket = bridge.socket;

    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => delivered.some(isRebrief));

    const rebrief = delivered.find(isRebrief);
    expect(rebrief?.event.content).toContain('[blocked]');
    expect(rebrief?.event.content).toContain('waiting on ops approval');
  });

  it('briefs a SECOND bridge attach inside the cooldown — a fresh session holds nothing', async () => {
    // A cold successor (instruction restart, clear, reload) connects a
    // new bridge seconds after the predecessor was briefed. The
    // cooldown exists to fold an attach and a compaction that land
    // together; it must not withhold the plate from a process that
    // never received one.
    fakeBrokerObjectives.length = 0;
    fakeBrokerObjectives.push(makeObjective());

    broker = await startFakeBroker();
    const delivered: RecordedRebrief[] = [];
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      logger: silentLogger(),
      noTrace: true,
      channelSink: {
        deliver: async (event) => {
          delivered.push({ event });
        },
      },
    });

    const first = await connectFakeBridge(runner.socketPath);
    sendFrame(first.socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => delivered.filter(isRebrief).length === 1);
    first.socket.destroy();

    // The successor's bridge, well inside the 10s cooldown.
    const second = await connectFakeBridge(runner.socketPath);
    socket = second.socket;
    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => delivered.filter(isRebrief).length === 2);
    expect(delivered.filter(isRebrief)[1]?.event.content).toContain('obj-77');
    expect(delivered.filter(isRebrief)[1]?.event.meta.reason).toBe('session-start');
  });

  it('still folds a compaction signal landing inside the cooldown (the case the cooldown is for)', async () => {
    fakeBrokerObjectives.length = 0;
    fakeBrokerObjectives.push(makeObjective());

    broker = await startFakeBroker();
    const delivered: RecordedRebrief[] = [];
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      logger: silentLogger(),
      noTrace: true,
      channelSink: {
        deliver: async (event) => {
          delivered.push({ event });
        },
      },
    });

    const bridge = await connectFakeBridge(runner.socketPath);
    socket = bridge.socket;
    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => delivered.filter(isRebrief).length === 1);

    // The adapter-side compaction observation (codex's contextCompaction
    // item, claude's SessionStart(compact) hook) right after the attach.
    runner.rebrief('context-compaction');
    await new Promise((r) => setTimeout(r, 100));
    expect(delivered.filter(isRebrief)).toHaveLength(1);
  });

  it('stays silent when the plate is empty', async () => {
    fakeBrokerObjectives.length = 0;

    broker = await startFakeBroker();
    const delivered: RecordedRebrief[] = [];
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      logger: silentLogger(),
      noTrace: true,
      channelSink: {
        deliver: async (event) => {
          delivered.push({ event });
        },
      },
    });

    const bridge = await connectFakeBridge(runner.socketPath);
    socket = bridge.socket;
    const { received } = bridge;

    sendFrame(socket, { kind: 'mcp_request', id: 1, method: 'tools/list' });
    await waitFor(() => received.some((f) => f.kind === 'mcp_response' && f.id === 1));
    // Give a would-be re-brief time to land, then assert it didn't.
    await new Promise((r) => setTimeout(r, 150));
    expect(delivered.filter(isRebrief)).toHaveLength(0);
  });
});
