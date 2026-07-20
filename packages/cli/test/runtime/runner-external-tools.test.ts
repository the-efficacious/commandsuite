/**
 * Runner external-tools tests — the tool-source consumption path.
 *
 * Proves the three runner-side behaviors end-to-end against the fake
 * broker with a fake bridge (raw UDS socket):
 *
 *   1. Tools resolved on the briefing surface in `tools/list` as
 *      `<source>__<name>` alongside the builtin set.
 *   2. Calling one dispatches POST /tool-sources/:slug/tools/:name/
 *      invoke on the broker and relays the CallToolResult verbatim.
 *   3. A `data.kind='tool_source'` channel event triggers a debounced
 *      briefing refetch and — when the resolved set actually changed —
 *      a genuine `notifications/tools/list_changed` push to the
 *      bridge. This is the capability-change path the doctrine
 *      reserves list_changed for.
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
  fakeBrokerToolInvocations,
  fakeBrokerToolSources,
  startFakeBroker,
} from './fake-broker.js';

interface ReceivedFrame {
  kind: string;
  id?: number;
  method?: string;
  result?: { tools?: Array<{ name: string; description: string }> } & {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  params?: Record<string, unknown>;
}

const JIRA_SOURCE = {
  source: 'jira',
  kind: 'custom',
  tools: [
    {
      name: 'get_issue',
      description: 'Fetch a Jira issue by key.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
    },
  ],
};

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

describe('runner external tools', () => {
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
    fakeBrokerToolSources.length = 0;
    fakeBrokerToolInvocations.length = 0;
  });

  it('lists briefing tools as <source>__<name> and dispatches calls to the broker', async () => {
    fakeBrokerToolSources.push(JIRA_SOURCE);
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
    const list = received.find((f) => f.kind === 'mcp_response' && f.id === 1);
    const names = (list?.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('jira__get_issue');
    expect(names).toContain('roster'); // builtins unaffected

    sendFrame(socket, {
      kind: 'mcp_request',
      id: 2,
      method: 'tools/call',
      params: { name: 'jira__get_issue', arguments: { key: 'PROJ-9' } },
    });
    await waitFor(() => received.some((f) => f.kind === 'mcp_response' && f.id === 2));
    const call = received.find((f) => f.kind === 'mcp_response' && f.id === 2);
    expect(call?.result?.content?.[0]?.text).toContain('fake-invoke jira__get_issue');
    expect(fakeBrokerToolInvocations).toEqual([
      { slug: 'jira', tool: 'get_issue', args: { key: 'PROJ-9' } },
    ]);
  });

  it('still errors cleanly on unknown tools (no external match)', async () => {
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

    sendFrame(socket, {
      kind: 'mcp_request',
      id: 1,
      method: 'tools/call',
      params: { name: 'ghost__tool', arguments: {} },
    });
    await waitFor(() => received.some((f) => f.kind === 'mcp_response' && f.id === 1));
    const call = received.find((f) => f.kind === 'mcp_response' && f.id === 1);
    expect(call?.result?.isError).toBe(true);
    expect(call?.result?.content?.[0]?.text).toContain('unknown tool');
    expect(fakeBrokerToolInvocations).toHaveLength(0);
  });

  it('refreshes on tool_source events and emits a genuine tools/list_changed', async () => {
    fakeBrokerToolSources.length = 0;
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
    const before = received.find((f) => f.kind === 'mcp_response' && f.id === 1);
    expect((before?.result?.tools ?? []).map((t) => t.name)).not.toContain('jira__get_issue');

    // Admin registers the source: the fake broker's briefing changes,
    // and the registry event lands on the live stream.
    fakeBrokerToolSources.push(JIRA_SOURCE);
    const sub = await broker.waitForSubscriber(FAKE_BROKER_NAME);
    sub.write({
      id: 'msg-tool-source',
      ts: 1_700_000_005_000,
      to: FAKE_BROKER_NAME,
      from: 'admin',
      title: null,
      body: "Tool source 'jira' (custom) was registered by admin.",
      level: 'info',
      data: { kind: 'tool_source', event: 'created', source_slug: 'jira', thread: 'tool:jira' },
    });

    await waitFor(() =>
      received.some(
        (f) => f.kind === 'mcp_notification' && f.method === 'notifications/tools/list_changed',
      ),
    );

    // Re-list: the new tool is live without a runner restart.
    sendFrame(socket, { kind: 'mcp_request', id: 2, method: 'tools/list' });
    await waitFor(() => received.some((f) => f.kind === 'mcp_response' && f.id === 2));
    const after = received.find((f) => f.kind === 'mcp_response' && f.id === 2);
    expect((after?.result?.tools ?? []).map((t) => t.name)).toContain('jira__get_issue');
  });

  it('does not emit list_changed when the refetched set is unchanged', async () => {
    fakeBrokerToolSources.push(JIRA_SOURCE);
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

    // Event fires but the briefing's resolved set is identical (e.g.
    // a binding change for a different member leaked through fanout).
    const sub = await broker.waitForSubscriber(FAKE_BROKER_NAME);
    sub.write({
      id: 'msg-noop',
      ts: 1_700_000_006_000,
      to: FAKE_BROKER_NAME,
      from: 'admin',
      title: null,
      body: 'noop registry event',
      level: 'info',
      data: { kind: 'tool_source', event: 'updated', source_slug: 'jira', thread: 'tool:jira' },
    });
    // Give debounce + refetch time to run, then assert silence.
    await new Promise((r) => setTimeout(r, 500));
    expect(
      received.filter(
        (f) => f.kind === 'mcp_notification' && f.method === 'notifications/tools/list_changed',
      ),
    ).toHaveLength(0);
  });
});
