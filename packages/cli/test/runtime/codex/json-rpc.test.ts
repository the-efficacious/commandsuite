/**
 * Tests for the codex JSON-RPC client. Drives the client against a
 * pair of in-memory streams so we never need an actual codex
 * subprocess to verify framing + correlation behavior.
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createJsonRpcClient, JsonRpcError } from '../../../src/runtime/agents/codex/json-rpc.js';

interface Wire {
  serverIn: PassThrough; // we read what the client wrote
  serverOut: PassThrough; // we write what we want the client to receive
}

function pair(): {
  client: ReturnType<typeof createJsonRpcClient>;
  wire: Wire;
} {
  // The client reads from `stdout` (data flowing FROM codex) and writes
  // to `stdin` (data flowing TO codex). In our test we play codex:
  // - serverOut → client's `stdout` input
  // - client's `stdin` output → serverIn
  const serverOut = new PassThrough();
  const serverIn = new PassThrough();
  const client = createJsonRpcClient(serverOut, serverIn);
  return { client, wire: { serverIn, serverOut } };
}

async function readNextLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const newlineIdx = buf.indexOf('\n');
      if (newlineIdx >= 0) {
        stream.off('data', onData);
        resolve(buf.slice(0, newlineIdx));
      }
    };
    stream.on('data', onData);
    stream.on('error', reject);
  });
}

describe('createJsonRpcClient', () => {
  it('correlates requests to responses by id', async () => {
    const { client, wire } = pair();
    const promise = client.request<{ ok: boolean }>('thread/start', { cwd: '/tmp' });
    const line = await readNextLine(wire.serverIn);
    const sent = JSON.parse(line);
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('thread/start');
    expect(sent.params).toEqual({ cwd: '/tmp' });
    expect(typeof sent.id).toBe('number');

    wire.serverOut.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { ok: true } })}\n`,
    );
    const result = await promise;
    expect(result).toEqual({ ok: true });

    client.close('test');
  });

  it('rejects with JsonRpcError when the server returns an error', async () => {
    const { client, wire } = pair();
    const promise = client.request('turn/start', { threadId: 'x', input: [] });
    const line = await readNextLine(wire.serverIn);
    const sent = JSON.parse(line);

    wire.serverOut.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: sent.id,
        error: { code: -32600, message: 'invalid request' },
      })}\n`,
    );

    await expect(promise).rejects.toBeInstanceOf(JsonRpcError);
    await expect(promise).rejects.toMatchObject({
      code: -32600,
      message: 'invalid request',
    });

    client.close('test');
  });

  it('dispatches notifications to subscribed handlers', async () => {
    const { client, wire } = pair();
    const events: unknown[] = [];
    const unsub = client.onNotification('thread/started', (params) => {
      events.push(params);
    });

    wire.serverOut.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: { thread: { id: 't_123' } },
      })}\n`,
    );
    // Give the line listener a tick to fire.
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([{ thread: { id: 't_123' } }]);

    unsub();
    wire.serverOut.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: { thread: { id: 't_456' } },
      })}\n`,
    );
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1); // unsub stuck

    client.close('test');
  });

  it('routes server-initiated requests to onRequest handlers and writes the response', async () => {
    const { client, wire } = pair();
    client.onRequest('item/commandExecution/requestApproval', async () => {
      return { decision: 'deny' };
    });

    wire.serverOut.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'rm -rf /' },
      })}\n`,
    );

    const reply = await readNextLine(wire.serverIn);
    expect(JSON.parse(reply)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { decision: 'deny' },
    });

    client.close('test');
  });

  it('replies with method-not-found for unhandled server requests', async () => {
    const { client, wire } = pair();

    wire.serverOut.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'something/we/dont/handle',
        params: {},
      })}\n`,
    );

    const reply = await readNextLine(wire.serverIn);
    const parsed = JSON.parse(reply);
    expect(parsed.id).toBe(9);
    expect(parsed.error.code).toBe(-32601);

    client.close('test');
  });

  it('ignores malformed lines without crashing', async () => {
    const { client, wire } = pair();
    const events: unknown[] = [];
    client.onNotification('hello', (p) => events.push(p));

    wire.serverOut.write('not-json\n');
    wire.serverOut.write('\n'); // empty
    wire.serverOut.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'hello', params: { ok: true } })}\n`,
    );
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([{ ok: true }]);

    client.close('test');
  });

  it('accepts messages without a jsonrpc field (codex omits it)', async () => {
    // codex-rs/app-server-protocol/src/jsonrpc_lite.rs defines the wire
    // types WITHOUT a `jsonrpc` field. Every message codex emits would
    // fail a strict version check, so we route by shape.
    const { client, wire } = pair();
    const promise = client.request<{ ok: boolean }>('thread/start');
    const line = await readNextLine(wire.serverIn);
    const sent = JSON.parse(line);

    // Reply WITHOUT jsonrpc field — exactly what codex sends.
    wire.serverOut.write(`${JSON.stringify({ id: sent.id, result: { ok: true } })}\n`);
    expect(await promise).toEqual({ ok: true });

    // Notifications without jsonrpc field too.
    const events: unknown[] = [];
    client.onNotification('thread/started', (p) => events.push(p));
    wire.serverOut.write(
      `${JSON.stringify({ method: 'thread/started', params: { thread: { id: 't_1' } } })}\n`,
    );
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([{ thread: { id: 't_1' } }]);

    client.close('test');
  });

  it('rejects pending requests on close()', async () => {
    const { client } = pair();
    const promise = client.request('thread/start');
    client.close('test-shutdown');
    await expect(promise).rejects.toThrow(/closed/);
  });

  it('resolves the closed promise when stdout ends', async () => {
    const { client, wire } = pair();
    wire.serverOut.end();
    await client.closed;
  });
});
