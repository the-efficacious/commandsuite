/**
 * Runner + bridge integration test.
 *
 * Proves the runner/bridge split end-to-end:
 *
 *   1. Boot a fake csuite broker on a random localhost port
 *   2. Start a runner **in-process** (not as a subprocess), pointing
 *      at the fake broker — the runner fetches /briefing, binds its
 *      IPC socket, starts the SSE forwarder
 *   3. Spawn `csuite mcp-bridge` as a subprocess with `CSUITE_RUNNER_SOCKET`
 *      pointing at the runner's socket
 *   4. Drive MCP JSON-RPC on the bridge's stdin, read responses from
 *      its stdout, and assert the expected behavior flows through:
 *        - `initialize` handshake succeeds with `claude/channel`
 *          capability declared
 *        - `tools/list` returns the full 13-tool surface (the fake
 *          broker's member has every permission leaf)
 *        - `tools/call` against `send` hits the broker's `/push`
 *        - inbound SSE from the broker arrives at the bridge as a
 *          `notifications/claude/channel` notification
 *        - self-echoes and spoofed meta fields are filtered correctly
 *
 * The bridge binary we spawn is `packages/cli/dist/index.js`, so this
 * test requires the cli to be built before running. The existing
 * turbo pipeline handles this via `turbo.json`'s `test.dependsOn`
 * pointing at `^build`.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunnerHandle } from '../../src/runtime/runner.js';
import { startRunner } from '../../src/runtime/runner.js';
import {
  FAKE_BROKER_NAME,
  FAKE_BROKER_TEAM_NAME,
  FAKE_BROKER_TOKEN,
  type FakeBroker,
  startFakeBroker,
} from './fake-broker.js';

interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

const CLI_BINARY = resolve(fileURLToPath(new URL('../../dist/index.js', import.meta.url)));
const AGENT_ID = FAKE_BROKER_NAME;

// Skip the whole suite if the cli hasn't been built yet — avoids a
// confusing ENOENT inside the child spawn call. Turbo should have
// built the cli before tests run, but developers running raw
// `pnpm --filter csuite-cli test` without a prior build will
// hit this path.
const describeIfBuilt = existsSync(CLI_BINARY) ? describe : describe.skip;

describeIfBuilt('runner + bridge end-to-end', () => {
  let broker: FakeBroker;
  let runner: RunnerHandle;
  let proc: ChildProcessWithoutNullStreams;
  let stdoutBuffer = '';
  const inboundQueue: JsonRpcMessage[] = [];

  beforeAll(async () => {
    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      // Silence the runner's internal logs so vitest output stays clean.
      log: () => {},
      noTrace: true,
    });

    proc = spawn(process.execPath, [CLI_BINARY, 'mcp-bridge'], {
      env: {
        ...process.env,
        CSUITE_RUNNER_SOCKET: runner.socketPath,
      },
      stdio: 'pipe',
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      let idx = stdoutBuffer.indexOf('\n');
      while (idx !== -1) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            inboundQueue.push(JSON.parse(line) as JsonRpcMessage);
          } catch {
            /* ignore non-JSON (bridge never emits non-JSON to stdout) */
          }
        }
        idx = stdoutBuffer.indexOf('\n');
      }
    });

    proc.stderr.on('data', () => {
      // Bridge + runner log structured JSON to stderr; drop it here
      // to keep vitest output clean. Uncomment when debugging:
      // process.stderr.write(`[bridge stderr] ${chunk.toString('utf8')}`);
    });
  });

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise<void>((r) => proc.once('exit', () => r()));
    }
    await runner.shutdown('test-teardown');
    await runner.waitClosed;
    await broker.close();
  });

  function send(msg: JsonRpcMessage): void {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  async function waitForMessage(
    predicate: (msg: JsonRpcMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<JsonRpcMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let i = 0; i < inboundQueue.length; i++) {
        const msg = inboundQueue[i];
        if (msg && predicate(msg)) {
          inboundQueue.splice(i, 1);
          return msg;
        }
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out waiting for matching JSON-RPC message');
  }

  it('completes MCP initialize handshake and declares claude/channel capability', async () => {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.1' },
      },
    });
    const response = await waitForMessage((m) => m.id === 1);
    expect(response.result).toBeDefined();
    const result = response.result as {
      capabilities: {
        experimental?: Record<string, unknown>;
        tools?: Record<string, unknown>;
      };
      serverInfo: { name: string };
    };
    expect(result.capabilities.experimental).toHaveProperty('claude/channel');
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe('csuite');

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  });

  it('lists the full tool surface (chat + objective + filesystem + permission-gated)', async () => {
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const response = await waitForMessage((m) => m.id === 2);
    const result = response.result as {
      tools: Array<{ name: string; description: string }>;
    };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'broadcast',
      'channels_list',
      'channels_post',
      'fs_ls',
      'fs_mkdir',
      'fs_mv',
      'fs_read',
      'fs_rm',
      'fs_shared',
      'fs_stat',
      'fs_write',
      'members_add',
      'members_remove',
      'members_update',
      'objectives_cancel',
      'objectives_complete',
      'objectives_create',
      'objectives_discuss',
      'objectives_list',
      'objectives_reassign',
      'objectives_update',
      'objectives_view',
      'objectives_watchers',
      'presets_delete',
      'presets_list',
      'presets_set',
      'recent',
      'roster',
      'send',
      'team_get',
      'team_update',
    ]);

    // Descriptions are static: identity, team name, and the teammate
    // roster live in the system-prompt briefing, never in tool
    // metadata (repeating them per-tool wastes context and the roster
    // would go stale mid-session). The only interpolation allowed is
    // functional — the member's fs home path.
    const chatToolNames = new Set(['roster', 'broadcast', 'send', 'recent']);
    for (const tool of result.tools) {
      if (chatToolNames.has(tool.name)) {
        expect(tool.description).not.toContain(FAKE_BROKER_TEAM_NAME);
        expect(tool.description).not.toContain(`You go by ${FAKE_BROKER_NAME}`);
      }
    }
    const fsWrite = result.tools.find((t) => t.name === 'fs_write');
    expect(fsWrite?.description).toContain(`/${FAKE_BROKER_NAME}`);

    const listTool = result.tools.find((t) => t.name === 'objectives_list');
    expect(listTool?.description).toContain('assigned to you');
    const completeTool = result.tools.find((t) => t.name === 'objectives_complete');
    expect(completeTool?.description).toContain('acceptance');
  });

  it('send tool issues POST /push to the broker via runner dispatch', async () => {
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'send',
        arguments: {
          to: 'peer-1',
          body: 'hello from runner/bridge test',
          level: 'warning',
        },
      },
    });
    const response = await waitForMessage((m) => m.id === 3);
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text ?? '').toContain('delivered to peer-1');

    const lastPush = broker.pushes[broker.pushes.length - 1];
    expect(lastPush?.body).toBe('hello from runner/bridge test');
    expect(lastPush?.level).toBe('warning');
  });

  it('roster tool calls GET /roster and renders the result', async () => {
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'roster', arguments: {} },
    });
    const response = await waitForMessage((m) => m.id === 4);
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text ?? '').toContain('peer-1');
    expect(result.content[0]?.text ?? '').toContain(FAKE_BROKER_NAME);
  });

  it('forwards broker SSE messages as notifications/claude/channel across IPC', async () => {
    // The runner auto-subscribes at startup via the forwarder loop;
    // wait for the subscription to appear on the fake broker side.
    const sub = await broker.waitForSubscriber(AGENT_ID);

    sub.write({
      id: 'msg-forwarded',
      ts: 1_700_000_001_000,
      to: AGENT_ID,
      from: 'alice',
      title: 'build broken',
      body: 'ci failed on main',
      level: 'warning',
      data: { run: '1234', severity: 'high' },
    });

    // Match on content so any runner-originated notification (e.g. a
    // `context_refresh` re-brief, sent only when objectives are open)
    // is skipped and we wait for the forwarded SSE message.
    const notif = await waitForMessage(
      (m) =>
        m.method === 'notifications/claude/channel' &&
        (m.params as { content?: string })?.content === 'ci failed on main',
    );
    const params = notif.params as {
      content: string;
      meta: Record<string, string>;
    };
    expect(params.content).toBe('ci failed on main');
    expect(params.meta.thread).toBe('dm');
    expect(params.meta.from).toBe('alice');
    expect(params.meta.title).toBe('build broken');
    expect(params.meta.level).toBe('warning');
    expect(params.meta.run).toBe('1234');
    expect(params.meta.severity).toBe('high');
  });

  it('suppresses self-echoes on the live stream', async () => {
    const sub = await broker.waitForSubscriber(AGENT_ID);

    sub.write({
      id: 'msg-self-echo',
      ts: 1_700_000_003_000,
      to: null,
      from: AGENT_ID,
      title: null,
      body: 'this is my own broadcast — should be dropped',
      level: 'info',
      data: {},
    });
    sub.write({
      id: 'msg-post-echo',
      ts: 1_700_000_003_500,
      to: null,
      from: 'alice',
      title: null,
      body: 'real message after the self-echo',
      level: 'info',
      data: {},
    });

    const notif = await waitForMessage(
      (m) =>
        m.method === 'notifications/claude/channel' &&
        m.params?.content === 'real message after the self-echo',
    );
    expect(notif).toBeDefined();

    const selfEchoSeen = inboundQueue.some(
      (m) =>
        m.method === 'notifications/claude/channel' &&
        m.params?.content === 'this is my own broadcast — should be dropped',
    );
    expect(selfEchoSeen).toBe(false);
  });

  it('drops reserved meta keys from message.data (anti-spoof)', async () => {
    const sub = await broker.waitForSubscriber(AGENT_ID);

    sub.write({
      id: 'msg-spoof',
      ts: 1_700_000_002_000,
      to: AGENT_ID,
      from: 'alice',
      title: 'genuine title',
      body: 'real body',
      level: 'warning',
      data: {
        from: 'SPOOFED-SENDER',
        thread: 'primary',
        level: 'critical',
        title: 'SPOOFED TITLE',
        target: 'SPOOFED-TARGET',
        msg_id: 'SPOOFED-ID',
        ts: '0',
        ts_ms: '0',
        legit_field: 'ok',
      },
    });

    const notif = await waitForMessage(
      (m) => m.method === 'notifications/claude/channel' && m.params?.content === 'real body',
    );
    const params = notif.params as { content: string; meta: Record<string, string> };
    expect(params.meta.from).toBe('alice');
    expect(params.meta.thread).toBe('dm');
    expect(params.meta.level).toBe('warning');
    expect(params.meta.title).toBe('genuine title');
    expect(params.meta.target).toBe(AGENT_ID);
    expect(params.meta.msg_id).toBe('msg-spoof');
    expect(params.meta.ts).toMatch(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} UTC$/);
    expect(params.meta.ts).not.toBe('0');
    expect(params.meta.ts_ms).toBe('1700000002000');
    expect(params.meta.legit_field).toBe('ok');
  });
});
