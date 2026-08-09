import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket as WsWebSocket } from 'ws';
import { Client, ClientError } from '../src/client.js';
import { PROTOCOL_HEADER, PROTOCOL_VERSION, RUNNER_VERSION_HEADER } from '../src/protocol.js';
import {
  EditProcessDocumentRequestSchema,
  PROCESS_DOCUMENT_FIELDS,
  ProcessDocumentEditSchema,
} from '../src/schemas.js';
import type { Message, ProcessDocumentField, PushResult } from '../src/types.js';

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
  it('sends runner version only when the instructions caller declares the long-lived runner', async () => {
    const seen: Array<string | null> = [];
    const client = new Client({
      url: 'http://example.test:8717',
      token: 'test-secret',
      fetch: makeFakeFetch((_url, init) => {
        seen.push(new Headers(init.headers).get(RUNNER_VERSION_HEADER));
        return jsonResponse({
          name: 'rune',
          role: { title: 'agent', description: '' },
          permissions: [],
          instructions: '',
          team: { name: 'team', context: '', permissionPresets: {} },
          teammates: [],
          openObjectives: [],
          toolSources: [],
          processDocument: null,
        });
      }),
    });

    await client.instructions();
    await client.instructions({ runnerVersion: '0.3.4' });
    expect(seen).toEqual([null, '0.3.4']);
  });

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

// ─── the edit API and the record cannot name different fields ────────
//
// WHY THIS IS IN THE SDK AND NOT THE STORE. The store's types come
// from types.ts and its tests never cross a parse boundary, so
// decoupling these two zod shapes is INVISIBLE there — verified by
// mutation: pointing `previous` at an empty object left all 14 store
// tests green. The schema layer is where the derivation is load-
// bearing, so this is where it has to be asserted.
//
// The defect being guarded is real and cost a partner's review on the
// predecessor: the request accepted two fields the record had no
// column for, so editing them wrote the new value and recorded no
// prior one — silently, when paired with a field that was tracked.
describe('process document editable fields', () => {
  const META = ['reason', 'disposition'];

  it('has one derived list behind the request, the record and the enum', () => {
    const requestFields = Object.keys(EditProcessDocumentRequestSchema.shape)
      .filter((k) => !META.includes(k))
      .sort();
    const previousFields = Object.keys(
      // No .unwrap(): `previous` is now a required strict object rather
      // than wrapped in a default, which is the point of the change.
      ProcessDocumentEditSchema.shape.previous.shape,
    ).sort();

    // Every field an edit accepts is a field the record can hold.
    expect(previousFields).toEqual(requestFields);
    // And the enum names exactly those, so `fields` cannot record a
    // name that neither of the other two knows about.
    expect([...PROCESS_DOCUMENT_FIELDS].sort()).toEqual(requestFields);
  });

  it('keeps the runtime list and the TS union naming the same set', () => {
    // Fails TYPECHECK, not the test run, if they diverge. `pnpm test`
    // does not typecheck here; `pnpm typecheck` is the gate.
    const runtimeIsInUnion: ProcessDocumentField[] = [...PROCESS_DOCUMENT_FIELDS];
    const unionIsInRuntime: (typeof PROCESS_DOCUMENT_FIELDS)[number][] = runtimeIsInUnion;
    expect(unionIsInRuntime.length).toBeGreaterThan(0);
  });
});

// ─── `previous` is REQUIRED, asserted where omission can happen ──────
//
// The store reconstructs the column from the row every time, so an
// omitted `previous` cannot arise there — it arises at the response
// boundary, where a broker (or a forged payload) sends an edit without
// it. `.default({})` used to materialise `{}` silently, which is a
// record the write path never emits.
describe('process document edit parsing', () => {
  const valid = {
    version: 2,
    ts: 1,
    actor: 'lea',
    reason: 'r',
    disposition: 'correction' as const,
    fields: ['text' as const],
    previous: { text: 'before' },
  };

  it('accepts a well-formed edit, so the negatives below mean something', () => {
    expect(ProcessDocumentEditSchema.safeParse(valid).success).toBe(true);
  });

  /**
   * ISOLATES `required`. A version-2 edit with `previous` omitted is
   * rejected by the refinement anyway — it claims to have changed
   * `text` and retains no prior value — so it would pass this test
   * even with `.default({})` restored, for the wrong reason.
   *
   * Version 1 is the case where an omitted `previous` is otherwise
   * consistent: the creation legitimately has no prior values, so
   * `{}` satisfies every refinement. Only the field being REQUIRED
   * rejects it, and the writer always emits the column.
   */
  it('rejects a version-1 edit with `previous` omitted, which only `required` catches', () => {
    const creation = { ...valid, version: 1, previous: {} };
    expect(ProcessDocumentEditSchema.safeParse(creation).success).toBe(true);

    const { previous: _omitted, ...withoutPrevious } = creation;
    expect(ProcessDocumentEditSchema.safeParse(withoutPrevious).success).toBe(false);
  });

  it('rejects an unknown key in `previous` rather than stripping it', () => {
    const forged = { ...valid, previous: { text: 'before', smuggled: 'x' } };
    expect(ProcessDocumentEditSchema.safeParse(forged).success).toBe(false);
  });
});

/**
 * The spine client, and the schema laws it enforces BEFORE anything
 * reaches the wire.
 *
 * The append path validates its payload before sending, which matters
 * more here than on any other surface in this SDK: the annex is
 * append-only, so a malformed event that reaches it stays there. A
 * client that sent first and validated never would turn a caller's
 * typo into a permanent record.
 */
describe('spine client', () => {
  const SUBJECT = 'repo:acme';
  const OBSERVED = {
    subject: SUBJECT,
    value: 'sha-a',
    how: 'observed' as const,
    source: 'integration:github',
  };

  function eventFixture(overrides: Record<string, unknown> = {}) {
    return {
      seq: 1,
      id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      kind: 'discussion',
      class: 'ambient',
      subject: null,
      revision: null,
      actor: 'rune',
      authoredBy: null,
      at: '2026-08-08T12:00:00.000Z',
      provenance: 'native',
      opId: null,
      cites: [],
      staplesTo: null,
      contract: null,
      stateRev: null,
      body: { body: 'a thought' },
      ...overrides,
    };
  }

  it('sends the append payload and parses the response through the published schema', async () => {
    const sent: unknown[] = [];
    const client = new Client({
      url: 'http://broker.test',
      token: 't',
      fetch: makeFakeFetch((url, init) => {
        expect(url.pathname).toBe('/spine/events');
        expect(init.method).toBe('POST');
        sent.push(JSON.parse(String(init.body)));
        return jsonResponse({ event: eventFixture(), contract: null, replayed: false });
      }),
    });
    const result = await client.appendSpineEvent({
      kind: 'discussion',
      body: { body: 'a thought' },
    });
    expect(result.replayed).toBe(false);
    expect(result.event.id).toBe('evt_01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(sent).toEqual([{ kind: 'discussion', body: { body: 'a thought' } }]);
  });

  it('refuses to send an event the schema rejects', async () => {
    let called = false;
    const client = new Client({
      url: 'http://broker.test',
      token: 't',
      fetch: makeFakeFetch(() => {
        called = true;
        return jsonResponse({});
      }),
    });
    await expect(
      client.appendSpineEvent({
        kind: 'criterion_verdict',
        opId: 'op-1',
        expectedStateRev: 1,
        revision: OBSERVED,
        // `cannot_verify` with no `why` — the one refusal that keeps a
        // dead-end verdict out of a permanent record.
        body: { contract: 'evt_1', criterion: 'c1', decision: 'cannot_verify', evidence: 'e' },
      } as never),
    ).rejects.toThrow(/why/);
    // Nothing reached the wire. Asserting only the throw would pass
    // against a client that sent the event and then complained.
    expect(called, 'an invalid event must not reach the annex').toBe(false);
  });

  it('accepts the nearest valid thing — the same verdict carrying a reason', async () => {
    let called = false;
    const client = new Client({
      url: 'http://broker.test',
      token: 't',
      fetch: makeFakeFetch(() => {
        called = true;
        return jsonResponse({
          event: eventFixture({
            kind: 'criterion_verdict',
            class: 'authoritative',
            opId: 'op-1',
            revision: 'rev_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            contract: 'evt_1',
            stateRev: 2,
            body: {
              contract: 'evt_1',
              criterion: 'c1',
              decision: 'cannot_verify',
              evidence: 'e',
              why: 'no deploy access',
            },
          }),
          contract: null,
          replayed: false,
        });
      }),
    });
    const result = await client.appendSpineEvent({
      kind: 'criterion_verdict',
      opId: 'op-1',
      expectedStateRev: 1,
      revision: OBSERVED,
      body: {
        contract: 'evt_1',
        criterion: 'c1',
        decision: 'cannot_verify',
        evidence: 'e',
        why: 'no deploy access',
      },
    });
    expect(called).toBe(true);
    expect(result.event.kind).toBe('criterion_verdict');
  });

  it('composes every event filter onto the query string', async () => {
    let seen: URL | null = null;
    const client = new Client({
      url: 'http://broker.test',
      token: 't',
      fetch: makeFakeFetch((url) => {
        seen = url;
        return jsonResponse({ events: [], nextCursor: null, headSeq: 0 });
      }),
    });
    await client.spineEvents({
      since_seq: 12,
      limit: 25,
      kind: 'criterion_verdict',
      subject: SUBJECT,
      contract: 'evt_1',
      actor: 'lea',
    });
    // The whole query, sorted, so a dropped filter fails here rather
    // than returning a quietly wider page at runtime.
    const params = [...(seen as unknown as URL).searchParams.entries()].sort();
    expect(params).toEqual([
      ['actor', 'lea'],
      ['contract', 'evt_1'],
      ['kind', 'criterion_verdict'],
      ['limit', '25'],
      ['since_seq', '12'],
      ['subject', SUBJECT],
    ]);
  });

  /**
   * ONE DEFECT PER FIXTURE, and the assertion names it.
   *
   * The first draft of these was a single pack that was malformed in
   * two ways at once, asserted with a bare `rejects.toThrow()`. That
   * passes if either defect is caught, if neither is caught and the
   * client throws for an unrelated reason, and — the case that matters
   * — if the schema stops checking one of them entirely. `toThrow()`
   * with no argument cannot tell a caught contract violation from a
   * typo in the fixture.
   */
  const wellFormedPack = {
    member: 'lea',
    at: '2026-08-08T12:00:00.000Z',
    cursor: 0,
    contracts: [],
    asksForMe: [],
    myOpenAsks: [],
  };

  function orientClient(pack: unknown): Client {
    return new Client({
      url: 'http://broker.test',
      token: 't',
      fetch: makeFakeFetch(() => jsonResponse(pack)),
    });
  }

  it('rejects an orient pack whose instant is not an instant, naming the field', async () => {
    await expect(
      orientClient({ ...wellFormedPack, at: 'not-a-timestamp' }).spineOrient(),
    ).rejects.toThrow(/at/);
  });

  it('rejects an orient pack missing the asks a member is promised, naming the field', async () => {
    const { asksForMe: _dropped, ...withoutAsks } = wellFormedPack;
    // Dropping a promised array is the silent-degradation case: a
    // recovery call that returns no asks and a broker that stopped
    // sending them look identical to a caller that does not parse.
    await expect(orientClient(withoutAsks).spineOrient()).rejects.toThrow(/asksForMe/);
  });

  it('accepts a well-formed empty pack', async () => {
    // The positive control. An empty plate is a real state, and a
    // client that threw on it would satisfy both negatives above.
    const pack = await orientClient(wellFormedPack).spineOrient();
    expect(pack.member).toBe('lea');
    expect(pack.contracts).toEqual([]);
    expect(pack.asksForMe).toEqual([]);
  });
});
