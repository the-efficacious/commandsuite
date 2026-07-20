/**
 * Regression test for the `reject-new` second-bridge policy (codex).
 *
 * Codex spawns a fresh `csuite mcp-bridge` per thread — every dispatched
 * subagent opens one. Under the default `displace-old` policy the second
 * bridge would tear the root thread's bridge out from under it, and the
 * root agent's csuite tool calls would start failing with "Transport
 * closed" (the bug this policy fixes). Under `reject-new` the runner must:
 *
 *   1. keep the first (root) bridge attached and fully functional, and
 *   2. refuse the second (subagent) bridge — its process tears down.
 *
 * This test boots a runner with `onSecondBridge: 'reject-new'`, attaches a
 * root bridge, then attaches a second bridge and asserts the second one is
 * dropped while the root keeps servicing tool calls.
 *
 * Like `bridge.test.ts`, it spawns the real `dist/index.js mcp-bridge`, so
 * the cli must be built first (turbo's `test.dependsOn: ^build`).
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
const describeIfBuilt = existsSync(CLI_BINARY) ? describe : describe.skip;

/**
 * A spawned `mcp-bridge` subprocess plus the plumbing to drive MCP
 * JSON-RPC over its stdio and observe when it exits.
 */
interface BridgeHarness {
  proc: ChildProcessWithoutNullStreams;
  send(msg: JsonRpcMessage): void;
  waitForMessage(
    predicate: (m: JsonRpcMessage) => boolean,
    timeoutMs?: number,
  ): Promise<JsonRpcMessage>;
  waitForExit(timeoutMs?: number): Promise<number | null>;
}

function spawnBridge(socketPath: string): BridgeHarness {
  const proc = spawn(process.execPath, [CLI_BINARY, 'mcp-bridge'], {
    env: { ...process.env, CSUITE_RUNNER_SOCKET: socketPath },
    stdio: 'pipe',
  });
  const inbound: JsonRpcMessage[] = [];
  let buffer = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          inbound.push(JSON.parse(line) as JsonRpcMessage);
        } catch {
          /* bridge never emits non-JSON to stdout */
        }
      }
      idx = buffer.indexOf('\n');
    }
  });
  proc.stderr.on('data', () => {
    /* structured logs — drop to keep vitest output clean */
  });

  return {
    proc,
    send(msg) {
      proc.stdin.write(`${JSON.stringify(msg)}\n`);
    },
    async waitForMessage(predicate, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (let i = 0; i < inbound.length; i++) {
          const msg = inbound[i];
          if (msg && predicate(msg)) {
            inbound.splice(i, 1);
            return msg;
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('timed out waiting for matching JSON-RPC message');
    },
    waitForExit(timeoutMs = 5_000) {
      if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
      return new Promise<number | null>((res, rej) => {
        const timer = setTimeout(
          () => rej(new Error('timed out waiting for bridge exit')),
          timeoutMs,
        );
        proc.once('exit', (code) => {
          clearTimeout(timer);
          res(code);
        });
      });
    },
  };
}

async function initialize(bridge: BridgeHarness, id: number): Promise<void> {
  bridge.send({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0.0.1' },
    },
  });
  await bridge.waitForMessage((m) => m.id === id);
  bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function callRoster(bridge: BridgeHarness, id: number): Promise<string> {
  bridge.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'roster', arguments: {} },
  });
  const response = await bridge.waitForMessage((m) => m.id === id);
  const result = response.result as { content?: Array<{ text?: string }> };
  return result?.content?.[0]?.text ?? '';
}

describeIfBuilt('runner reject-new second-bridge policy', () => {
  let broker: FakeBroker;
  let runner: RunnerHandle;
  let root: BridgeHarness;
  let subagent: BridgeHarness | null = null;

  beforeAll(async () => {
    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      log: () => {},
      noTrace: true,
      onSecondBridge: 'reject-new',
    });
    root = spawnBridge(runner.socketPath);
    // Handshake + a real tool call so we KNOW the root bridge is attached
    // (activeBridge set) before the subagent bridge connects.
    await initialize(root, 1);
    expect(await callRoster(root, 2)).toContain(FAKE_BROKER_NAME);
  });

  afterAll(async () => {
    for (const b of [root, subagent]) {
      if (b && b.proc.exitCode === null) {
        b.proc.kill('SIGTERM');
        await new Promise<void>((r) => b.proc.once('exit', () => r()));
      }
    }
    await runner.shutdown('test-teardown');
    await runner.waitClosed;
    await broker.close();
  });

  it('refuses a second (subagent) bridge: its process tears down', async () => {
    subagent = spawnBridge(runner.socketPath);
    // The runner writes an `error` frame and ends the socket; the bridge
    // sees its IPC socket close and exits cleanly (code 0).
    const code = await subagent.waitForExit();
    expect(code).toBe(0);
  });

  it('keeps the root bridge fully functional after the rejection', async () => {
    // The whole point: displacing here is what broke codex. The root must
    // still service tool calls after a subagent bridge came and went.
    expect(await callRoster(root, 3)).toContain(FAKE_BROKER_NAME);
  });
});
