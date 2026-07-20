import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket as WsWebSocket } from 'ws';
import { Client, ClientError } from '../src/client.js';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../src/protocol.js';
import type { Message, PushResult } from '../src/types.js';

/**
 * Minimal stand-in for `ws.WebSocket`. Exposes `.on('message'|'close'|'error')`
 * and `.close()`. Tests drive it by `emit`ing events directly.
 * Constructed instances land on `FakeWebSocket.instances` so tests
 * can grab the live socket and push frames through it.
 */
class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly opts: { headers?: Record<string, string> } | undefined;
  closed = false;
  constructor(url: string, opts?: { headers?: Record<string, string> }) {
    super();
    this.url = url;
    this.opts = opts;
    FakeWebSocket.instances.push(this);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code ?? 1000, reason ?? '');
  }
}

function asWs(): typeof WsWebSocket {
  return FakeWebSocket as unknown as typeof WsWebSocket;
}

function makeFakeFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('Client', () => {
  it('sends protocol header and bearer token on authenticated calls', async () => {
    let captured: { url: URL; headers: Headers } | null = null;
    const client = new Client({
      url: 'http://example.test:8717',
      token: 'test-secret',
      fetch: makeFakeFetch((url, init) => {
        captured = { url, headers: new Headers(init.headers) };
        return jsonResponse({ teammates: [], connected: [] });
      }),
    });

    await client.roster();

    expect(captured).not.toBeNull();
    const { url, headers } = captured as unknown as { url: URL; headers: Headers };
    expect(url.pathname).toBe('/roster');
    expect(headers.get(PROTOCOL_HEADER)).toBe(String(PROTOCOL_VERSION));
    expect(headers.get('Authorization')).toBe('Bearer test-secret');
  });

  it('omits auth header on /healthz', async () => {
    let captured: Headers | null = null;
    const client = new Client({
      url: 'http://example.test:8717',
      token: 'test-secret',
      fetch: makeFakeFetch((_url, init) => {
        captured = new Headers(init.headers);
        return jsonResponse({ status: 'ok', version: '0.0.0' });
      }),
    });
    await client.health();
    expect(captured).not.toBeNull();
    expect((captured as unknown as Headers).get('Authorization')).toBeNull();
  });

  it('parses and validates a push result', async () => {
    const fakeMessage: Message = {
      id: 'msg-1',
      ts: 1_700_000_000_000,
      to: 'agent-1',
      from: 'member',
      title: 'hi',
      body: 'hello world',
      level: 'info',
      data: {},
      attachments: [],
    };
    const payload: PushResult = {
      delivery: { live: 1, targets: 1 },
      message: fakeMessage,
    };
    const client = new Client({
      url: 'http://example.test:8717',
      token: 'x',
      fetch: makeFakeFetch(() => jsonResponse(payload)),
    });
    const result = await client.push({ to: 'agent-1', body: 'hello world' });
    expect(result.message.body).toBe('hello world');
    expect(result.delivery.live).toBe(1);
  });

  it('throws ClientError on non-2xx with the response body', async () => {
    const client = new Client({
      url: 'http://example.test:8717',
      token: 'x',
      fetch: makeFakeFetch(
        () =>
          new Response('unauthorized', {
            status: 401,
            statusText: 'Unauthorized',
          }),
      ),
    });
    await expect(client.roster()).rejects.toBeInstanceOf(ClientError);
    try {
      await client.roster();
    } catch (err) {
      expect(err).toBeInstanceOf(ClientError);
      const e = err as ClientError;
      expect(e.status).toBe(401);
      expect(e.body).toContain('unauthorized');
    }
  });

  it('subscribe yields parsed messages from WebSocket frames', async () => {
    const fakeMessage: Message = {
      id: 'msg-1',
      ts: 1_700_000_000_000,
      to: 'agent-1',
      from: null,
      title: null,
      body: 'hi',
      level: 'info',
      data: {},
      attachments: [],
    };
    const fakeMessage2: Message = { ...fakeMessage, id: 'msg-2', body: 'second' };

    FakeWebSocket.instances = [];
    const client = new Client({
      url: 'http://example.test:8717',
      token: 'x',
      fetch: makeFakeFetch(() => jsonResponse({})),
      WebSocket: asWs(),
    });

    const received: Message[] = [];
    const iteration = (async () => {
      for await (const msg of client.subscribe('agent-1')) {
        received.push(msg);
      }
    })();

    // Give subscribe() a tick to construct the WS and wire listeners.
    await new Promise((r) => setTimeout(r, 0));
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (!ws) return;
    // Upgrade URL should be ws:// (not http://) and carry `name` query.
    expect(ws.url.startsWith('ws://example.test:8717/subscribe')).toBe(true);
    expect(ws.url).toContain('name=agent-1');
    expect(ws.opts?.headers?.Authorization).toBe('Bearer x');
    expect(ws.opts?.headers?.[PROTOCOL_HEADER]).toBe(String(PROTOCOL_VERSION));

    ws.emit('message', JSON.stringify(fakeMessage));
    ws.emit('message', JSON.stringify(fakeMessage2));
    ws.close();
    await iteration;

    expect(received).toHaveLength(2);
    expect(received[0]?.id).toBe('msg-1');
    expect(received[1]?.body).toBe('second');
  });

  it('subscribe exits cleanly when the caller aborts', async () => {
    FakeWebSocket.instances = [];
    const client = new Client({
      url: 'http://example.test:8717',
      token: 'x',
      fetch: makeFakeFetch(() => jsonResponse({})),
      WebSocket: asWs(),
    });

    const ac = new AbortController();
    const received: Message[] = [];
    const iteration = (async () => {
      for await (const msg of client.subscribe('agent-1', ac.signal)) {
        received.push(msg);
      }
    })();

    await new Promise((r) => setTimeout(r, 0));
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (!ws) return;
    ac.abort();
    // Abort handler calls ws.close which emits 'close'; iteration returns.
    await iteration;
    expect(ws.closed).toBe(true);
    expect(received).toHaveLength(0);
  });
});
