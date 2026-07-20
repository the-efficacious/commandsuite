/**
 * GenAI correlator tests.
 *
 * Drives the real correlation path: TelemetryRecords for the three
 * api-body OTEL events, whose `body_ref` attributes point at temp files
 * holding real Anthropic request/response JSON. Asserts exactly ONE
 * `GenAiInference` per completed call with the full input context, output,
 * system instructions, usage (incl. cache tokens), and finish reasons —
 * plus cross-batch correlation and defensive body_ref handling.
 *
 * The second describe block drives the capture-before-parse raw path:
 * with a `rawStore` wired, every body's VERBATIM bytes must land in the
 * content-addressed store before any JSON.parse (malformed bodies
 * included), the consumed spill files must be unlinked, the request
 * exchange must gain its request_id on the api_request claim, and the
 * emitted inference must carry both body hashes — with raw-store
 * failures isolated from the gen_ai path.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createGenAiCorrelator, isGenAiLogRecord } from '../src/genai-correlator.js';
import { createRawBodyStore, type RawBodyStore } from '../src/raw-body-store.js';
import type { TelemetryRecord } from '../src/telemetry-store.js';

const dir = mkdtempSync(join(tmpdir(), 'genai-corr-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const REQUEST_BODY = {
  model: 'claude-opus-4-6',
  system: [{ type: 'text', text: 'You are a helpful assistant.' }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'compute', signature: 'sig' },
        { type: 'text', text: 'Let me calculate.' },
        { type: 'tool_use', id: 'toolu_1', name: 'calc', input: { a: 2, b: 2 } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '4', is_error: false }],
    },
  ],
};

const RESPONSE_BODY = {
  id: 'msg_resp_1',
  role: 'assistant',
  model: 'claude-opus-4-6',
  content: [{ type: 'text', text: 'The answer is 4.' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 50,
    output_tokens: 10,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 300,
  },
};

let fileSeq = 0;
function writeBody(obj: unknown): string {
  const path = join(dir, `body-${fileSeq++}.json`);
  writeFileSync(path, JSON.stringify(obj), 'utf8');
  return path;
}

function logRecord(
  eventName: string,
  seq: number,
  attributes: Record<string, unknown>,
): TelemetryRecord {
  return {
    signal: 'log',
    name: `claude_code.${eventName}`,
    tsUnixNano: (1_700_000_000_000 + seq) * 1_000_000,
    attributes: { 'event.name': `claude_code.${eventName}`, 'event.sequence': seq, ...attributes },
    resource: {},
    scope: null,
    payload: {},
  };
}

describe('genai correlator', () => {
  it('isGenAiLogRecord matches short and fully-qualified names', () => {
    expect(isGenAiLogRecord('api_request_body')).toBe(true);
    expect(isGenAiLogRecord('claude_code.api_response_body')).toBe(true);
    expect(isGenAiLogRecord('claude_code.api_request')).toBe(true);
    expect(isGenAiLogRecord('claude_code.api_error')).toBe(true);
    expect(isGenAiLogRecord('claude_code.tool_decision')).toBe(false);
    expect(isGenAiLogRecord('claude_code.user_prompt')).toBe(false);
  });

  it('emits ONE full-context inference from a 3-record sequence', () => {
    const corr = createGenAiCorrelator();
    const reqRef = writeBody(REQUEST_BODY);
    const resRef = writeBody(RESPONSE_BODY);

    const out = corr.ingest([
      logRecord('api_request_body', 1, { body_ref: reqRef, model: 'claude-opus-4-6' }),
      logRecord('api_request', 2, {
        request_id: 'req_1',
        model: 'claude-opus-4-6',
        input_tokens: 50,
        output_tokens: 10,
        cache_read_tokens: 500,
        cache_creation_tokens: 300,
      }),
      logRecord('api_response_body', 3, { body_ref: resRef, request_id: 'req_1' }),
    ]);

    expect(out).toHaveLength(1);
    const rec = out[0];
    if (!rec) throw new Error('no record');

    expect(rec.operationName).toBe('chat');
    expect(rec.provider).toBe('anthropic');
    expect(rec.model).toBe('claude-opus-4-6');
    expect(rec.responseId).toBe('msg_resp_1');
    expect(rec.finishReasons).toEqual(['end_turn']);
    expect(rec.requestBodyRef).toBe(reqRef);

    // Usage lifts through the response body, cache tokens included.
    expect(rec.usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 300,
    });

    // System kept SEPARATE from chat history.
    expect(rec.systemInstructions).toEqual([
      { type: 'text', content: 'You are a helpful assistant.' },
    ]);

    // Full input context, in send order, with every block type mapped.
    expect(rec.inputMessages).toHaveLength(3);
    expect(rec.inputMessages[0]).toEqual({
      role: 'user',
      parts: [{ type: 'text', content: 'What is 2+2?' }],
    });
    expect(rec.inputMessages[1]?.parts).toEqual([
      { type: 'reasoning', content: 'compute' },
      { type: 'text', content: 'Let me calculate.' },
      { type: 'tool_call', id: 'toolu_1', name: 'calc', arguments: { a: 2, b: 2 } },
    ]);
    expect(rec.inputMessages[2]?.parts).toEqual([
      { type: 'tool_call_response', id: 'toolu_1', response: '4', is_error: false },
    ]);

    // Assistant output.
    expect(rec.outputMessages).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'The answer is 4.' }] },
    ]);

    // No attribution attrs on the api_request → both null, never undefined.
    expect(rec.querySource).toBeNull();
    expect(rec.agentName).toBeNull();

    // Timestamp is the request start.
    expect(rec.ts).toBe(1_700_000_000_001);
  });

  it('attributes a subagent call from the api_request query_source + agent.name', () => {
    const corr = createGenAiCorrelator();
    const reqRef = writeBody(REQUEST_BODY);
    const resRef = writeBody(RESPONSE_BODY);

    const out = corr.ingest([
      logRecord('api_request_body', 1, { body_ref: reqRef, model: 'claude-opus-4-6' }),
      logRecord('api_request', 2, {
        request_id: 'req_sub',
        model: 'claude-opus-4-6',
        query_source: 'agent:builtin:general-purpose',
        // Flattened attrs → the agent name lives under the DOTTED key.
        'agent.name': 'general-purpose',
      }),
      logRecord('api_response_body', 3, { body_ref: resRef, request_id: 'req_sub' }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]?.querySource).toBe('agent:builtin:general-purpose');
    expect(out[0]?.agentName).toBe('general-purpose');
  });

  it('attributes a main-thread call with a query_source but null agentName', () => {
    const corr = createGenAiCorrelator();
    const reqRef = writeBody(REQUEST_BODY);
    const resRef = writeBody(RESPONSE_BODY);

    const out = corr.ingest([
      logRecord('api_request_body', 1, { body_ref: reqRef, model: 'claude-opus-4-6' }),
      logRecord('api_request', 2, {
        request_id: 'req_main',
        model: 'claude-opus-4-6',
        query_source: 'repl_main_thread',
      }),
      logRecord('api_response_body', 3, { body_ref: resRef, request_id: 'req_main' }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]?.querySource).toBe('repl_main_thread');
    expect(out[0]?.agentName).toBeNull();
  });

  it('correlates across separate ingest batches', () => {
    const corr = createGenAiCorrelator();
    const reqRef = writeBody(REQUEST_BODY);
    const resRef = writeBody(RESPONSE_BODY);

    // Batch 1: only the request body (no request_id yet).
    const first = corr.ingest([
      logRecord('api_request_body', 1, { body_ref: reqRef, model: 'claude-opus-4-6' }),
    ]);
    expect(first).toHaveLength(0);
    expect(corr.pendingCount()).toBe(1);

    // Batch 2: accounting + response body pair it by request_id.
    const second = corr.ingest([
      logRecord('api_request', 2, { request_id: 'req_1', model: 'claude-opus-4-6' }),
      logRecord('api_response_body', 3, { body_ref: resRef, request_id: 'req_1' }),
    ]);
    expect(second).toHaveLength(1);
    expect(second[0]?.responseId).toBe('msg_resp_1');
    expect(corr.pendingCount()).toBe(0);
  });

  it('keeps interleaved calls of different models on separate wires', () => {
    const corr = createGenAiCorrelator();
    const opusReq = writeBody({ ...REQUEST_BODY, model: 'claude-opus-4-6' });
    const haikuReq = writeBody({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'title this' }] }],
    });
    const opusRes = writeBody(RESPONSE_BODY);
    const haikuRes = writeBody({
      id: 'msg_haiku',
      role: 'assistant',
      content: [{ type: 'text', text: 'A Title' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const out = corr.ingest([
      logRecord('api_request_body', 1, { body_ref: opusReq, model: 'claude-opus-4-6' }),
      logRecord('api_request_body', 2, { body_ref: haikuReq, model: 'claude-haiku-4-5' }),
      logRecord('api_request', 3, { request_id: 'r_haiku', model: 'claude-haiku-4-5' }),
      logRecord('api_response_body', 4, { body_ref: haikuRes, request_id: 'r_haiku' }),
      logRecord('api_request', 5, { request_id: 'r_opus', model: 'claude-opus-4-6' }),
      logRecord('api_response_body', 6, { body_ref: opusRes, request_id: 'r_opus' }),
    ]);

    expect(out).toHaveLength(2);
    const byId = new Map(out.map((r) => [r.responseId, r]));
    // The haiku response paired with the haiku request body, not opus.
    expect(byId.get('msg_haiku')?.model).toBe('claude-haiku-4-5');
    expect(byId.get('msg_resp_1')?.model).toBe('claude-opus-4-6');
  });

  it('skips an unreadable body_ref without throwing or emitting', () => {
    const corr = createGenAiCorrelator();
    const resRef = writeBody(RESPONSE_BODY);
    const missing = join(dir, 'does-not-exist.json');

    let out: ReturnType<typeof corr.ingest> = [];
    expect(() => {
      out = corr.ingest([
        logRecord('api_request_body', 1, { body_ref: missing, model: 'claude-opus-4-6' }),
        logRecord('api_request', 2, { request_id: 'req_x', model: 'claude-opus-4-6' }),
        logRecord('api_response_body', 3, { body_ref: resRef, request_id: 'req_x' }),
      ]);
    }).not.toThrow();
    // Request body couldn't be resolved → the call is dropped, not emitted.
    expect(out).toHaveLength(0);
  });

  it('tolerates an inline body when no body_ref is present', () => {
    const corr = createGenAiCorrelator();
    const out = corr.ingest([
      logRecord('api_request_body', 1, {
        body: JSON.stringify(REQUEST_BODY),
        model: 'claude-opus-4-6',
      }),
      logRecord('api_request', 2, { request_id: 'req_inline', model: 'claude-opus-4-6' }),
      logRecord('api_response_body', 3, {
        body: JSON.stringify(RESPONSE_BODY),
        request_id: 'req_inline',
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.responseId).toBe('msg_resp_1');
    expect(out[0]?.requestBodyRef).toBeNull();
  });

  it('discards the request body on api_error so it does not linger', () => {
    const corr = createGenAiCorrelator();
    const reqRef = writeBody(REQUEST_BODY);
    const out = corr.ingest([
      logRecord('api_request_body', 1, { body_ref: reqRef, model: 'claude-opus-4-6' }),
      logRecord('api_error', 2, { request_id: 'req_err', model: 'claude-opus-4-6' }),
    ]);
    expect(out).toHaveLength(0);
    expect(corr.pendingCount()).toBe(0);
  });
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('genai correlator raw capture', () => {
  it('captures both bodies verbatim, bridges the request_id, links by hash, unlinks files', () => {
    const rawStore = createRawBodyStore(openDatabase(':memory:'));
    const corr = createGenAiCorrelator({ rawStore, memberName: 'alice' });
    const reqRef = writeBody(REQUEST_BODY);
    const resRef = writeBody(RESPONSE_BODY);
    // Snapshot the bytes up front — capture consumes (unlinks) the files.
    const reqBytes = readFileSync(reqRef);
    const resBytes = readFileSync(resRef);

    const out = corr.ingest([
      logRecord('api_request_body', 1, {
        body_ref: reqRef,
        model: 'claude-opus-4-6',
        // body_length arrives as a STRING attr on the wire.
        body_length: String(reqBytes.length),
        'prompt.id': 'prompt-1',
        'session.id': 'session-1',
        query_source: 'repl_main_thread',
      }),
      logRecord('api_request', 2, {
        request_id: 'req_raw',
        model: 'claude-opus-4-6',
        query_source: 'agent:builtin:general-purpose',
        'agent.name': 'general-purpose',
      }),
      logRecord('api_response_body', 3, {
        body_ref: resRef,
        request_id: 'req_raw',
        model: 'claude-opus-4-6',
        body_length: String(resBytes.length),
        'session.id': 'session-1',
        query_source: 'agent:builtin:general-purpose',
      }),
    ]);

    // The derived view points at its source bytes by hash.
    expect(out).toHaveLength(1);
    expect(out[0]?.requestSha256).toBe(sha256(reqBytes));
    expect(out[0]?.responseSha256).toBe(sha256(resBytes));

    // Two blobs + two exchange rows carrying the telemetry envelope.
    expect(rawStore.stats()).toMatchObject({ blobs: 2, exchanges: 2 });
    const [reqRow] = rawStore.list({ kind: 'request' });
    expect(reqRow).toMatchObject({
      memberName: 'alice',
      kind: 'request',
      hash: sha256(reqBytes),
      bodyLength: reqBytes.length,
      promptId: 'prompt-1',
      sessionId: 'session-1',
      querySource: 'repl_main_thread',
      model: 'claude-opus-4-6',
      eventTs: 1_700_000_000_001,
      // Bridged in by the api_request claim (the body record itself
      // carries NO request_id, and no agent name until the claim).
      requestId: 'req_raw',
      agentName: 'general-purpose',
    });
    const [resRow] = rawStore.list({ kind: 'response' });
    expect(resRow).toMatchObject({
      memberName: 'alice',
      kind: 'response',
      hash: sha256(resBytes),
      requestId: 'req_raw',
      sessionId: 'session-1',
      eventTs: 1_700_000_000_003,
    });

    // The stored bytes are the exact wire bytes.
    expect(rawStore.getBlob(sha256(reqBytes))?.equals(reqBytes)).toBe(true);
    expect(rawStore.getBlob(sha256(resBytes))?.equals(resBytes)).toBe(true);

    // Spill files consumed — the broker deleting them IS the lifecycle.
    expect(existsSync(reqRef)).toBe(false);
    expect(existsSync(resRef)).toBe(false);
  });

  it('bridges the request_id onto the raw exchange across ingest batches', () => {
    const rawStore = createRawBodyStore(openDatabase(':memory:'));
    const corr = createGenAiCorrelator({ rawStore, memberName: 'alice' });
    const reqRef = writeBody(REQUEST_BODY);
    const resRef = writeBody(RESPONSE_BODY);

    corr.ingest([logRecord('api_request_body', 1, { body_ref: reqRef, model: 'claude-opus-4-6' })]);
    // Captured immediately (before the claim), request_id still NULL.
    expect(rawStore.count()).toBe(1);
    expect(rawStore.list()[0]?.requestId).toBeNull();

    const out = corr.ingest([
      logRecord('api_request', 2, { request_id: 'req_later', model: 'claude-opus-4-6' }),
      logRecord('api_response_body', 3, { body_ref: resRef, request_id: 'req_later' }),
    ]);
    expect(out).toHaveLength(1);
    expect(rawStore.list({ kind: 'request' })[0]?.requestId).toBe('req_later');
  });

  it('keeps the spill files when unlinkAfterCapture is false', () => {
    const rawStore = createRawBodyStore(openDatabase(':memory:'));
    const corr = createGenAiCorrelator({
      rawStore,
      memberName: 'alice',
      unlinkAfterCapture: false,
    });
    const reqRef = writeBody(REQUEST_BODY);
    const resRef = writeBody(RESPONSE_BODY);

    const out = corr.ingest([
      logRecord('api_request_body', 1, { body_ref: reqRef, model: 'claude-opus-4-6' }),
      logRecord('api_request', 2, { request_id: 'req_keep', model: 'claude-opus-4-6' }),
      logRecord('api_response_body', 3, { body_ref: resRef, request_id: 'req_keep' }),
    ]);
    expect(out).toHaveLength(1);
    expect(rawStore.stats().blobs).toBe(2);
    expect(existsSync(reqRef)).toBe(true);
    expect(existsSync(resRef)).toBe(true);
  });

  it('stores a malformed-JSON request body raw while the genai path skips', () => {
    const rawStore = createRawBodyStore(openDatabase(':memory:'));
    const corr = createGenAiCorrelator({ rawStore, memberName: 'alice' });
    const badBytes = Buffer.from('not json {{{', 'utf8');
    const badRef = join(dir, `bad-${fileSeq++}.json`);
    writeFileSync(badRef, badBytes);
    const resRef = writeBody(RESPONSE_BODY);

    const out = corr.ingest([
      logRecord('api_request_body', 1, { body_ref: badRef, model: 'claude-opus-4-6' }),
      logRecord('api_request', 2, { request_id: 'req_bad', model: 'claude-opus-4-6' }),
      logRecord('api_response_body', 3, { body_ref: resRef, request_id: 'req_bad' }),
    ]);

    // The gen_ai (parse) path drops the call…
    expect(out).toHaveLength(0);
    // …but the raw bytes were captured BEFORE the parse, verbatim,
    // and the consumed file was still unlinked.
    expect(rawStore.count()).toBe(2);
    expect(rawStore.getBlob(sha256(badBytes))?.equals(badBytes)).toBe(true);
    expect(existsSync(badRef)).toBe(false);
  });

  it('still emits the inference when the raw store throws (failure isolation)', () => {
    const throwing: RawBodyStore = {
      appendBody: () => {
        throw new Error('disk full');
      },
      assignRequestId: () => {
        throw new Error('disk full');
      },
      getBlob: () => null,
      list: () => [],
      count: () => 0,
      stats: () => ({ blobs: 0, exchanges: 0, rawBytes: 0, storedBytes: 0 }),
    };
    const corr = createGenAiCorrelator({ rawStore: throwing, memberName: 'alice' });
    const reqRef = writeBody(REQUEST_BODY);
    const resRef = writeBody(RESPONSE_BODY);

    const out = corr.ingest([
      logRecord('api_request_body', 1, { body_ref: reqRef, model: 'claude-opus-4-6' }),
      logRecord('api_request', 2, { request_id: 'req_iso', model: 'claude-opus-4-6' }),
      logRecord('api_response_body', 3, { body_ref: resRef, request_id: 'req_iso' }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]?.responseId).toBe('msg_resp_1');
    // No successful capture → no hashes, and the files are NOT unlinked.
    expect(out[0]?.requestSha256).toBeNull();
    expect(out[0]?.responseSha256).toBeNull();
    expect(existsSync(reqRef)).toBe(true);
    expect(existsSync(resRef)).toBe(true);
  });

  it('warns on a body_length mismatch but still captures and emits', () => {
    const rawStore = createRawBodyStore(openDatabase(':memory:'));
    const logs: string[] = [];
    const corr = createGenAiCorrelator({
      rawStore,
      memberName: 'alice',
      log: (msg) => logs.push(msg),
    });
    const reqRef = writeBody(REQUEST_BODY);
    const resRef = writeBody(RESPONSE_BODY);

    const out = corr.ingest([
      logRecord('api_request_body', 1, {
        body_ref: reqRef,
        model: 'claude-opus-4-6',
        body_length: '999999',
      }),
      logRecord('api_request', 2, { request_id: 'req_len', model: 'claude-opus-4-6' }),
      logRecord('api_response_body', 3, { body_ref: resRef, request_id: 'req_len' }),
    ]);

    expect(logs.some((m) => m.includes('body length mismatch'))).toBe(true);
    expect(out).toHaveLength(1);
    expect(rawStore.stats().blobs).toBe(2);
  });

  it('captures an inline body (no body_ref) the same way', () => {
    const rawStore = createRawBodyStore(openDatabase(':memory:'));
    const corr = createGenAiCorrelator({ rawStore, memberName: 'alice' });
    const reqText = JSON.stringify(REQUEST_BODY);
    const resText = JSON.stringify(RESPONSE_BODY);

    const out = corr.ingest([
      logRecord('api_request_body', 1, { body: reqText, model: 'claude-opus-4-6' }),
      logRecord('api_request', 2, { request_id: 'req_inl', model: 'claude-opus-4-6' }),
      logRecord('api_response_body', 3, { body: resText, request_id: 'req_inl' }),
    ]);

    expect(out).toHaveLength(1);
    const reqHash = sha256(Buffer.from(reqText, 'utf8'));
    expect(out[0]?.requestSha256).toBe(reqHash);
    expect(rawStore.getBlob(reqHash)?.toString('utf8')).toBe(reqText);
    expect(rawStore.stats()).toMatchObject({ blobs: 2, exchanges: 2 });
  });
});
