/**
 * Runner + bridge integration test.
 *
 * Proves the runner/bridge split end-to-end:
 *
 *   1. Boot a fake csuite broker on a random localhost port
 *   2. Start a runner **in-process** (not as a subprocess), pointing
 *      at the fake broker — the runner fetches /instructions, binds its
 *      IPC socket, starts the SSE forwarder
 *   3. Spawn `csuite mcp-bridge` as a subprocess with `CSUITE_RUNNER_SOCKET`
 *      pointing at the runner's socket
 *   4. Drive MCP JSON-RPC on the bridge's stdin, read responses from
 *      its stdout, and assert the expected behavior flows through:
 *        - `initialize` handshake succeeds with `tools.listChanged`
 *          declared
 *        - `tools/list` returns the full 13-tool surface (the fake
 *          broker's member has every permission leaf)
 *        - `tools/call` against `send` hits the broker's `/push`
 *
 * Broker SSE events never cross the bridge — they reach the agent
 * through the runner's channel sink, covered by
 * `runner-channel-delivery.test.ts` and the per-runner sink tests.
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
import { silentLogger } from '../helpers/logger.js';
import {
  FAKE_BROKER_NAME,
  FAKE_BROKER_TEAM_NAME,
  FAKE_BROKER_TOKEN,
  type FakeBroker,
  fakeBrokerObjectiveQueries,
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
      logger: silentLogger(),
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

  it('completes MCP initialize handshake and declares tools.listChanged', async () => {
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
        tools?: Record<string, unknown>;
      };
      serverInfo: { name: string };
    };
    expect(result.capabilities.tools).toMatchObject({ listChanged: true });
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
      'connect_approve',
      'connect_pending',
      'context_control',
      'fs_download',
      'fs_ls',
      'fs_mkdir',
      'fs_mv',
      'fs_read',
      'fs_rm',
      'fs_shared',
      'fs_stat',
      'fs_upload',
      'fs_write',
      'members_add',
      'members_remove',
      'members_update',
      'objectives_cancel',
      'objectives_complete',
      'objectives_create',
      'objectives_discuss',
      'objectives_list',
      'objectives_update',
      'objectives_view',
      'process_document_get',
      'process_document_history',
      'recent',
      'roster',
      'send',
      'team_get',
      'team_update',
    ]);

    // Descriptions are static: identity, team name, and the teammate
    // roster live in the system-prompt instructions, never in tool
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

  it('no fs tool description tells an agent the objective namespace is broken', async () => {
    // A tool description is a SPECIFICATION. It sits in every agent's
    // context and is the only spec an agent has for a tool whose source it
    // cannot read, so a description that is wrong is not a documentation
    // nit — it is the tool being wrong for every caller at once.
    //
    // This exact class shipped. `fs_ls`/`fs_stat`/`fs_read`/`fs_write`/
    // `fs_mkdir`/`fs_mv` all carried "KNOWN DEFECT" notices telling agents
    // the objective namespace failed and to write to their home instead.
    // Those defects were fixed in 0.3.1 (#54) — and the notices shipped in
    // the SAME artifact as the fix, so the published package documented its
    // own working feature as broken.
    //
    // The measured cost, on 2026-07-31: a teammate routed his evidence
    // around the namespace on the doc's instruction, and then — when he hit
    // a genuine, unrelated defect — read it as the documented one, because
    // the text had pre-loaded a wrong explanation. A stale "known defect"
    // notice does not only waste the work it deflects; it consumes the
    // signal from the next real failure.
    //
    // WHAT THIS TEST IS. A guard against re-introducing the specific
    // language, not a proof that the descriptions are accurate — no test
    // can check prose against behaviour. The BEHAVIOUR these descriptions
    // now claim is established separately, in
    // `apps/server/test/files/objective-namespace.test.ts`. If that file
    // ever goes red, this test will still pass and will then be asserting
    // something false. They belong to each other.
    send({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} });
    const response = await waitForMessage((m) => m.id === 99);
    const result = response.result as {
      tools: Array<{ name: string; description: string; inputSchema?: unknown }>;
    };

    const fsTools = result.tools.filter((t) => t.name.startsWith('fs_'));
    expect(fsTools.length, 'fixture must actually expose fs tools').toBeGreaterThan(0);

    // The vocabulary that shipped. Matched over the whole tool JSON because
    // `fs_write` carried its notice on a nested property description, not
    // on the tool's own `description` — checking only the top level would
    // have missed the worst instance of the six.
    for (const tool of fsTools) {
      const blob = JSON.stringify(tool);
      for (const phrase of ['KNOWN DEFECT', 'MISREPORTS', 'Do not retry', 'until this is fixed']) {
        expect(blob, `${tool.name} still warns agents off a working surface`).not.toContain(phrase);
      }
    }

    // The positive half. Absence alone would also pass if someone deleted
    // every mention of objective namespaces, which would leave an agent
    // with no idea the surface exists.
    const fsWrite = fsTools.find((t) => t.name === 'fs_write');
    expect(JSON.stringify(fsWrite)).toContain('/objectives/<id>/');

    // The one namespace-adjacent gotcha that IS live: `fs_ls` renders
    // directories with a trailing slash that the path schema rejects, so
    // the listing's own output is not valid input. Documented until that is
    // fixed; delete this assertion when it is, not before.
    const fsLs = fsTools.find((t) => t.name === 'fs_ls');
    expect(fsLs?.description).toContain('MUST NOT END IN "/"');
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
    // A role is an object ({ title, description }) — render the title,
    // never the object. Asserting only on names let `[object Object]`
    // ship to every agent that called `roster`.
    expect(result.content[0]?.text ?? '').toContain('[reviewer]');
    expect(result.content[0]?.text ?? '').toContain('[engineer]');
    expect(result.content[0]?.text ?? '').not.toContain('[object Object]');
  });

  // The tool's choice of filter IS the agent-facing contract. `assignee`
  // collapses to assignee-only for any caller holding `objectives.create`
  // — which is every coordinating member — hiding everything they
  // originated or watch. Every server-side test stays green through that
  // regression, so it has to be asserted on the wire.
  it('objectives_list queries by relationship, not assignee', async () => {
    fakeBrokerObjectiveQueries.length = 0;
    send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'objectives_list', arguments: {} },
    });
    const response = await waitForMessage((m) => m.id === 5);
    const result = response.result as { content: Array<{ type: string; text: string }> };

    expect(fakeBrokerObjectiveQueries).toHaveLength(1);
    const params = new URLSearchParams(fakeBrokerObjectiveQueries[0] ?? '');
    expect(params.get('related')).toBe(FAKE_BROKER_NAME);
    expect(params.has('assignee')).toBe(false);

    // The empty-state text said "assigned to", which stayed misleading
    // even once the query was right.
    expect(result.content[0]?.text ?? '').toContain(`no objectives for ${FAKE_BROKER_NAME}`);
    expect(result.content[0]?.text ?? '').not.toContain('assigned to');
  });

  it('objectives_list forwards a status filter alongside the relationship', async () => {
    fakeBrokerObjectiveQueries.length = 0;
    send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'objectives_list', arguments: { status: 'active' } },
    });
    await waitForMessage((m) => m.id === 6);

    expect(fakeBrokerObjectiveQueries).toHaveLength(1);
    const params = new URLSearchParams(fakeBrokerObjectiveQueries[0] ?? '');
    expect(params.get('related')).toBe(FAKE_BROKER_NAME);
    expect(params.get('status')).toBe('active');
    expect(params.has('assignee')).toBe(false);
  });
});
