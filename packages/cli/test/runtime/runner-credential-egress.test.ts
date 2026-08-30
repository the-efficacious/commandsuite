import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { generateBearerToken } from 'csuite-core';
import { containsBearerToken } from 'csuite-sdk/credential-safety';
import { afterEach, describe, expect, it } from 'vitest';
import {
  guardCredentialFreeToolResult,
  type RunnerHandle,
  startRunner,
} from '../../src/runtime/runner.js';
import { silentLogger } from '../helpers/logger.js';
import { FAKE_BROKER_TOKEN, type FakeBroker, startFakeBroker } from './fake-broker.js';

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

describe('runner credential egress guard', () => {
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
  });

  it.each(['members_add', 'rotate', 'connect approve'])(
    'keeps a %s-shaped result out of IPC and agent context',
    (surface) => {
      const token = generateBearerToken();
      const guarded = guardCredentialFreeToolResult(
        textResult(JSON.stringify({ surface, nested: JSON.stringify({ token }) })),
      );
      const serialized = JSON.stringify(guarded);
      expect(guarded.isError).toBe(true);
      expect(serialized).toContain('credential-shaped content');
      expect(serialized).not.toContain(token);
    },
  );

  it('returns an ordinary credential-free result unchanged', () => {
    const result = textResult('member created pending device enrolment');
    expect(guardCredentialFreeToolResult(result)).toBe(result);
  });

  it('provisions a member through the runner while the whole MCP result stream stays credential-free', async () => {
    broker = await startFakeBroker({ additionalPermissions: ['secrets.manage'] });
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      logger: silentLogger(),
      noTrace: true,
    });
    const connectedSocket = connect({ path: runner.socketPath });
    socket = connectedSocket;
    await new Promise<void>((resolve, reject) => {
      connectedSocket.once('connect', resolve);
      connectedSocket.once('error', reject);
    });

    const responses: Array<{ kind: string; id?: number; result?: CallToolResult }> = [];
    createInterface({ input: socket, crlfDelay: Infinity }).on('line', (line) => {
      responses.push(JSON.parse(line) as (typeof responses)[number]);
    });
    const calls = [
      ['members_add', { name: 'newbie', title: 'engineer' }],
      ['secrets_bindings', { slug: 'accept-secret', add: ['newbie'] }],
      ['variables_bindings', { slug: 'accept-variable', add: ['newbie'] }],
      ['connect_pending', {}],
      ['connect_approve', { code: 'AB12-CD34', member: 'newbie', label: 'new-seat' }],
    ] as const;
    for (const [index, [name, args]] of calls.entries()) {
      const id = index + 1;
      socket.write(
        `${JSON.stringify({ kind: 'mcp_request', id, method: 'tools/call', params: { name, arguments: args } })}\n`,
      );
      const deadline = Date.now() + 5_000;
      while (!responses.some((frame) => frame.kind === 'mcp_response' && frame.id === id)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for tool result ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const stream = responses.filter((frame) => frame.kind === 'mcp_response');
    expect(stream).toHaveLength(calls.length);
    for (const frame of stream) expect(frame.result?.isError).not.toBe(true);
    expect(JSON.stringify(stream)).toContain("member 'newbie' created");
    expect(JSON.stringify(stream)).toContain("bound device to 'newbie'");
    expect(containsBearerToken(JSON.stringify(stream))).toBe(false);
  });
});
