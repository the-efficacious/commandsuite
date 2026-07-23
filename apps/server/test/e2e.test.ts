// @ts-nocheck — TODO(db-migration): rewrite for the DB-backed team/member model.
// This test still passes the legacy `members: MemberStore` and/or `team: Team` args
// to runServer/createApp. With the new model, runServer opens its own stores from
// `db`/`dbPath`, and createApp takes `teamStore`. Seed via `seedStores()` from
// test/helpers/test-stores.ts and pass `db: seeded.db` to runServer instead.

/**
 * End-to-end test for csuite's team control plane.
 *
 * Brings up the real server (in-process via `runServer`), spawns the
 * real link binary as a subprocess, and drives the full loop:
 *
 *   1. Operator pushes a message via the SDK Client
 *   2. Server fans out to the live SSE subscriber (the link)
 *   3. Link forwards to Claude Code as `notifications/claude/channel`
 *   4. Agent-as-operator: link's `send` tool is invoked via stdio and
 *      hits the broker's /push endpoint through the same client path.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'csuite-sdk/client';
import type { Team } from 'csuite-sdk/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemberStore } from '../src/members.js';
import { type RunningServer, runServer } from '../src/run.js';

interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

const LINK_BINARY = resolve(
  fileURLToPath(new URL('../../../packages/link/dist/index.js', import.meta.url)),
);
// to === slot.name is enforced by the broker. Three
// slots exercise: operator → agent (director-1 → e2e-agent), and
// agent-as-operator (e2e-agent → e2e-peer).
const AGENT_ID = 'e2e-agent';
const PEER_AGENT_ID = 'e2e-peer';
const OP_TOKEN = 'csuite_test_operator';
const AGENT_TOKEN = 'csuite_test_agent';
const PEER_TOKEN = 'csuite_test_peer';

const TEAM: Team = {
  name: 'e2e-team',
  context: '',
  permissionPresets: {},
};

// Skipped during the runner/bridge refactor: this e2e test spawned
// the `csuite-link` binary, which no longer exists. `csuite mcp-bridge` is
// the replacement; this test will be rewritten to spawn that verb
// against an in-process runner.
describe.skip('end-to-end: operator → broker → link → channel event', () => {
  let server: RunningServer;
  let link: ChildProcessWithoutNullStreams;
  let client: Client;

  const inbound: JsonRpcMessage[] = [];
  let stdoutBuf = '';

  beforeAll(async () => {
    const members = createMemberStore([
      {
        name: 'director-1',
        role: { title: 'director', description: '' },
        permissions: ['members.manage'],
        token: OP_TOKEN,
      },
      {
        name: AGENT_ID,
        role: { title: 'engineer', description: '' },
        permissions: [],
        token: AGENT_TOKEN,
      },
      {
        name: PEER_AGENT_ID,
        role: { title: 'engineer', description: '' },
        permissions: [],
        token: PEER_TOKEN,
      },
    ]);
    server = await runServer({
      members,
      teamStore: mockTeamStore(TEAM),
      port: 0,
      host: '127.0.0.1',
      dbPath: ':memory:',
      // Silence server logs during the test to keep output clean.
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    const url = `http://${server.host}:${server.port}`;
    client = new Client({ url, token: OP_TOKEN });

    // Sanity-check the server is up before spawning the link.
    const health = await client.health();
    expect(health.status).toBe('ok');

    link = spawn(process.execPath, [LINK_BINARY], {
      env: {
        ...process.env,
        CSUITE_URL: url,
        CSUITE_TOKEN: AGENT_TOKEN,
      },
      stdio: 'pipe',
    });

    link.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let idx = stdoutBuf.indexOf('\n');
      while (idx !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.length > 0) {
          try {
            inbound.push(JSON.parse(line) as JsonRpcMessage);
          } catch {
            // skip non-JSON lines
          }
        }
        idx = stdoutBuf.indexOf('\n');
      }
    });
    link.stderr.on('data', (chunk: Buffer) => {
      if (process.env.E2E_DEBUG) {
        process.stderr.write(`[link] ${chunk.toString('utf8')}`);
      }
    });

    // Simulate Claude Code's MCP initialize handshake.
    link.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '0.0.1' },
        },
      })}\n`,
    );
    await waitForMessage((m) => m.id === 1, inbound, 5_000);

    link.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );

    // Wait until the link subscribes (connected > 0).
    await waitUntil(async () => {
      const { connected } = await client.roster();
      const us = connected.find((a) => a.name === AGENT_ID);
      return Boolean(us && us.connected > 0);
    }, 5_000);
  }, 20_000);

  afterAll(async () => {
    if (link && link.exitCode === null) {
      link.kill('SIGTERM');
      await new Promise<void>((r) => link.once('exit', () => r()));
    }
    await server.stop();
  });

  it('operator push via SDK surfaces as a channel event on link stdio', async () => {
    await client.push({
      to: AGENT_ID,
      body: 'end-to-end test push',
      title: 'e2e',
      level: 'warning',
      data: { run_id: 'e2e-1', kind: 'ci_alert' },
    });

    const event = await waitForMessage(
      (m) => m.method === 'notifications/claude/channel',
      inbound,
      5_000,
    );
    const params = event.params as {
      content: string;
      meta: Record<string, string>;
    };
    expect(params.content).toBe('end-to-end test push');
    expect(params.meta.title).toBe('e2e');
    expect(params.meta.level).toBe('warning');
    expect(params.meta.run_id).toBe('e2e-1');
    expect(params.meta.kind).toBe('ci_alert');
    expect(params.meta.thread).toBe('dm');
    expect(params.meta.from).toBe('director-1');
  });

  it('agent-as-operator: link send tool reaches the broker and back', async () => {
    link.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: 'send',
          arguments: {
            to: PEER_AGENT_ID,
            body: 'agent-originated message',
            title: 'hello from e2e-agent',
            level: 'info',
          },
        },
      })}\n`,
    );

    const response = await waitForMessage((m) => m.id === 42, inbound, 5_000);
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text ?? '').toContain(`delivered to ${PEER_AGENT_ID}`);
  });
});

async function waitForMessage(
  predicate: (m: JsonRpcMessage) => boolean,
  queue: JsonRpcMessage[],
  timeoutMs = 3_000,
): Promise<JsonRpcMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = 0; i < queue.length; i++) {
      const msg = queue[i];
      if (msg && predicate(msg)) {
        queue.splice(i, 1);
        return msg;
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for message');
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitUntil timed out');
}
