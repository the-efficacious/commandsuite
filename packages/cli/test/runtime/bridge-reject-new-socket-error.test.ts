/**
 * Regression: refusing a second bridge must not throw on its socket.
 *
 * Under `reject-new` (codex, where every dispatched subagent spawns its
 * own bridge) the runner writes an error frame to the newcomer and ends
 * the connection — and returns BEFORE `createBridgeConnection`, which is
 * the only place the accepted socket otherwise gets an 'error' listener.
 *
 * A socket with no 'error' listener does not report, it THROWS: Node
 * turns the unhandled event into an uncaught exception. The refused peer
 * is a subagent bridge that tears itself down the moment it is refused,
 * so the write races a peer that is already gone — ECONNRESET/EPIPE on
 * the ordinary path, not an exotic one, taking the runner with it.
 *
 * Asserted through the consequence that matters: the ROOT bridge is
 * still served after a refused peer resets. A runner killed by the
 * uncaught exception cannot answer.
 */

import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerHandle } from '../../src/runtime/runner.js';
import { startRunner } from '../../src/runtime/runner.js';
import { silentLogger } from '../helpers/logger.js';
import { FAKE_BROKER_TOKEN, type FakeBroker, startFakeBroker } from './fake-broker.js';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
}

async function openBridge(path: string): Promise<{ socket: Socket; lines: string[] }> {
  const socket = connect({ path });
  socket.on('error', () => {
    /* the test's own peer; the runner is the subject here */
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const lines: string[] = [];
  createInterface({ input: socket, crlfDelay: Infinity }).on('line', (l) => lines.push(l));
  return { socket, lines };
}

describe('a refused second bridge that resets does not kill the runner', () => {
  let broker: FakeBroker | null = null;
  let runner: RunnerHandle | null = null;

  afterEach(async () => {
    if (runner) {
      await runner.shutdown('test-teardown');
      await runner.waitClosed;
      runner = null;
    }
    await broker?.close();
    broker = null;
  });

  it('keeps serving the root bridge after the refused peer vanishes mid-refusal', async () => {
    broker = await startFakeBroker();
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      logger: silentLogger(),
      noTrace: true,
      onSecondBridge: 'reject-new',
    });

    const root = await openBridge(runner.socketPath);
    root.socket.write(`${JSON.stringify({ kind: 'mcp_request', id: 1, method: 'tools/list' })}\n`);
    await waitFor(() => root.lines.some((l) => l.includes('mcp_response')));

    // A subagent bridge that is refused and goes away at once. Destroy,
    // not end: an orderly FIN would never produce the error this guards.
    const refused = connect({ path: runner.socketPath });
    refused.on('error', () => {});
    await new Promise<void>((resolve) => refused.once('connect', () => resolve()));
    refused.destroy();
    await new Promise((r) => setTimeout(r, 200));

    // The root bridge is still attached and still answered.
    root.socket.write(`${JSON.stringify({ kind: 'mcp_request', id: 2, method: 'tools/list' })}\n`);
    await waitFor(() => root.lines.filter((l) => l.includes('mcp_response')).length >= 2);
    expect(root.lines.filter((l) => l.includes('mcp_response')).length).toBeGreaterThanOrEqual(2);
    root.socket.destroy();
  });
});
