/**
 * `POST /members/:name/genai` route tests — the codex gen_ai + raw-body
 * ingest. A bearer-authed self upload of one inference's complete
 * request/response payload bytes must: content-address the raw bytes into
 * the raw-body store, map a parsed copy into a `GenAiInference` (provider
 * `openai`) linked by sha256, and gate on self (403) + auth (401).
 */

import { createHash } from 'node:crypto';
import {
  Broker,
  clearRegisteredSecretValues,
  InMemoryEventLog,
  REDACTED,
  registerSecretValues,
} from 'csuite-core';
import type { Permission, Team } from 'csuite-sdk/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createDiagnosticStore } from '../src/diagnostics.js';
import { createGenAiStore } from '../src/genai-store.js';
import { createMemberStore } from '../src/members.js';
import { createRawBodyStore } from '../src/raw-body-store.js';
import { SessionStore } from '../src/sessions.js';
import { createTelemetryStore } from '../src/telemetry-store.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const TEAM: Team = { name: 'demo-team', context: '', permissionPresets: {} };
const TOKEN = 'csuite_test_genai';

function makeApp(team: Team = TEAM, permissions: Permission[] = []) {
  const broker = new Broker({ eventLog: new InMemoryEventLog() });
  const members = createMemberStore([
    {
      name: 'engineer-1',
      role: { title: 'engineer', description: '' },
      permissions,
      token: TOKEN,
    },
  ]);
  const db = openDatabase(':memory:');
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const genaiStore = createGenAiStore(db, { logger });
  const rawBodyStore = createRawBodyStore(db, { logger });
  const telemetryStore = createTelemetryStore(db, { logger });
  const diagnostics = createDiagnosticStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions: new SessionStore(db),
    genaiStore,
    rawBodyStore,
    telemetryStore,
    diagnostics,
    teamStore: mockTeamStore(team),
    version: '0.0.0',
    logger,
  });
  return { app, broker, diagnostics, genaiStore, rawBodyStore, telemetryStore };
}

afterEach(() => clearRegisteredSecretValues());

describe('instruction write warnings', () => {
  it('warns and stores team context intact when it contains a registered value', async () => {
    const secret = 'registered-team-write';
    registerSecretValues([secret]);
    const { app } = makeApp(TEAM, ['team.manage']);
    const context = `Reference ${secret} by environment variable name.`;
    const res = await app.request('/team', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-CSuite-Warning')).toContain('will appear verbatim');
    const body = (await res.json()) as { team: Team; warning: string };
    expect(body.team.context).toBe(context);
    expect(body.warning).toContain('use a secret reference');
  });
});

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');

function inference() {
  return {
    requestBase64: b64({
      type: 'response.create',
      model: 'gpt-5.5',
      instructions: 'be helpful',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    }),
    responseBase64: b64({
      response_id: 'resp_1',
      token_usage: { input_tokens: 10, output_tokens: 3 },
      output_items: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      ],
    }),
    model: 'gpt-5.5',
    responseId: 'resp_1',
    threadId: 'thread-1',
    querySource: 'codex_main_thread',
    ts: 1_700_000_000_000,
  };
}

function otlpInlineClaudeCall(requestBody: unknown, responseBody: unknown) {
  const attrs = (eventName: string, values: Record<string, string>) => [
    { key: 'event.name', value: { stringValue: `claude_code.${eventName}` } },
    ...Object.entries(values).map(([key, value]) => ({ key, value: { stringValue: value } })),
  ];
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: '1700000000000000000',
                attributes: attrs('api_request_body', {
                  body: JSON.stringify(requestBody),
                  model: 'claude-opus-4-6',
                }),
              },
              {
                timeUnixNano: '1700000001000000000',
                attributes: attrs('api_request', {
                  request_id: 'req_relay_1',
                  model: 'claude-opus-4-6',
                }),
              },
              {
                timeUnixNano: '1700000002000000000',
                attributes: attrs('api_response_body', {
                  body: JSON.stringify(responseBody),
                  request_id: 'req_relay_1',
                }),
              },
            ],
          },
        ],
      },
    ],
  };
}

async function post(
  app: ReturnType<typeof makeApp>['app'],
  name: string,
  body: unknown,
  token = TOKEN,
) {
  return app.request(`/members/${name}/genai`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /members/:name/genai', () => {
  it('does not claim absence or re-send when the Codex system projection is unobservable', async () => {
    const test = makeApp({ ...TEAM, context: 'Durable team rules.' });
    const pushed: unknown[] = [];
    test.broker.subscribe('engineer-1', async (message) => {
      pushed.push(message);
    });
    const item = inference();
    item.requestBase64 = b64({
      type: 'response.create',
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    });

    const res = await post(test.app, 'engineer-1', { inferences: [item] });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushed).toEqual([]);
    const [unobservable] = test.telemetryStore.list({
      name: 'csuite.context_block.presence',
    });
    expect(unobservable?.attributes).toMatchObject({
      'context.block.observable': false,
      'context.block.state': 'unobservable',
      'context.block.resend_fired': false,
    });
    expect(unobservable?.attributes).not.toHaveProperty('context.block.present');
    expect(test.diagnostics.unresolved('engineer-1')).toContainEqual({
      cause: 'context.briefing_check_unavailable',
      since: expect.any(Number),
    });
  });

  it('content-addresses raw bytes and stores a mapped GenAiInference', async () => {
    const { app, genaiStore, rawBodyStore } = makeApp();
    const res = await post(app, 'engineer-1', { inferences: [inference()] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });

    // A payload with nothing to redact remains byte-exact.
    expect(rawBodyStore.count()).toBe(2);
    const reqExchange = rawBodyStore.list({ memberName: 'engineer-1', kind: 'request' })[0];
    expect(reqExchange).toBeDefined();
    expect(rawBodyStore.getBlob(reqExchange?.hash ?? '')?.toString('base64')).toBe(
      inference().requestBase64,
    );

    // Derived record: provider openai, linked to the raw bytes by sha256.
    expect(genaiStore.count()).toBe(1);
    const [rec] = genaiStore.list({ memberName: 'engineer-1' });
    expect(rec?.provider).toBe('openai');
    expect(rec?.model).toBe('gpt-5.5');
    expect(rec?.responseId).toBe('resp_1');
    expect(rec?.querySource).toBe('codex_main_thread');
    expect(rec?.usage).toMatchObject({ inputTokens: 10, outputTokens: 3 });
    expect(rec?.requestSha256).toBe(reqExchange?.hash);
    expect(typeof rec?.responseSha256).toBe('string');
    // The request-side context (system instructions + input) survived.
    expect(rec?.systemInstructions?.[0]).toMatchObject({ type: 'text' });
    expect(rec?.inputMessages?.length).toBeGreaterThan(0);
  });

  it('uses this member packet to preserve its block and redact the same-request tool result', async () => {
    const secret = 'registered-route-value';
    const context = `The exact team context contains ${secret}.`;
    registerSecretValues([secret]);
    const { app, genaiStore, rawBodyStore } = makeApp({ ...TEAM, context });

    const briefingRes = await app.request('/instructions', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const packet = (await briefingRes.json()) as { instructions: string };
    expect(packet.instructions).toContain(context);

    const item = inference();
    item.requestBase64 = b64({
      model: 'gpt-5.5',
      instructions: `adapter prefix\n${packet.instructions}\nadapter suffix`,
      input: [{ type: 'function_call_output', call_id: 'c', output: `stdout: ${secret}` }],
    });
    const res = await post(app, 'engineer-1', { inferences: [item] });
    expect(res.status).toBe(200);

    const [stored] = genaiStore.list({ memberName: 'engineer-1' });
    const systemText = stored?.systemInstructions
      .map((part) => ('content' in part ? String(part.content) : ''))
      .join('');
    expect(systemText).toContain(context);
    expect(JSON.stringify(stored?.inputMessages)).toContain(`stdout: ${REDACTED}`);
    expect(JSON.stringify(stored?.inputMessages)).not.toContain(secret);
    const rawRequest = rawBodyStore.list({ memberName: 'engineer-1', kind: 'request' })[0];
    const rawBody = JSON.parse(
      rawBodyStore.getBlob(rawRequest?.hash ?? '')?.toString('utf8') ?? '{}',
    );
    const rawSystem = String(rawBody.instructions ?? '');
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const capturedBlock = rawSystem.slice(
      rawSystem.indexOf(context),
      rawSystem.indexOf(context) + context.length,
    );
    expect(sha(capturedBlock)).toBe(sha(context));
    expect(JSON.stringify(rawBody.input)).toContain(`stdout: ${REDACTED}`);
    expect(JSON.stringify(rawBody.input)).not.toContain(`stdout: ${secret}`);
  });

  it('redacts a registered literal from both codex raw bodies before content-addressing', async () => {
    const secret = 'registered-codex-raw-value';
    registerSecretValues([secret]);
    const { app, rawBodyStore } = makeApp();
    const item = inference();
    item.requestBase64 = b64({ input: [{ text: `request ${secret}` }] });
    item.responseBase64 = b64({ output_items: [{ text: `response ${secret}` }] });

    const res = await post(app, 'engineer-1', { inferences: [item] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });

    for (const kind of ['request', 'response'] as const) {
      const exchange = rawBodyStore.list({ memberName: 'engineer-1', kind })[0];
      const stored = rawBodyStore.getBlob(exchange?.hash ?? '')?.toString('utf8') ?? '';
      expect(stored, `${kind} raw body`).toContain(REDACTED);
      expect(stored, `${kind} raw body`).not.toContain(secret);
    }
  });

  it('captures raw bytes even when a body is not valid JSON (model-only record)', async () => {
    const secret = 'registered-malformed-body';
    registerSecretValues([secret]);
    const { app, genaiStore, rawBodyStore } = makeApp();
    const bad = {
      requestBase64: Buffer.from(`not json ${secret}`, 'utf8').toString('base64'),
      responseBase64: Buffer.from('also not json', 'utf8').toString('base64'),
      model: 'gpt-5.5',
      responseId: 'resp_x',
    };
    const res = await post(app, 'engineer-1', { inferences: [bad] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });
    // Raw bytes landed; the derived record is model-only (no messages).
    expect(rawBodyStore.count()).toBe(2);
    const request = rawBodyStore.list({ memberName: 'engineer-1', kind: 'request' })[0];
    expect(rawBodyStore.getBlob(request?.hash ?? '')?.toString('utf8')).toBe(
      `not json ${REDACTED}`,
    );
    const [rec] = genaiStore.list({ memberName: 'engineer-1' });
    expect(rec?.model).toBe('gpt-5.5');
    expect(rec?.inputMessages).toEqual([]);
  });

  it('403s an upload for another member', async () => {
    const { app, genaiStore } = makeApp();
    const res = await post(app, 'someone-else', { inferences: [inference()] });
    expect(res.status).toBe(403);
    expect(genaiStore.count()).toBe(0);
  });

  it('401s an unauthenticated upload', async () => {
    const { app } = makeApp();
    const res = await app.request('/members/engineer-1/genai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inferences: [inference()] }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts an empty batch as a no-op', async () => {
    const { app, genaiStore } = makeApp();
    const res = await post(app, 'engineer-1', { inferences: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 0 });
    expect(genaiStore.count()).toBe(0);
  });
});

describe('POST /otlp/v1/logs runner-relay acknowledgement', () => {
  it('classifies an issued prior block as stale after the authored block changes', async () => {
    const issued = 'Rules issued to this session.';
    const current = 'Rules authored after this session started.';
    const test = makeApp({ ...TEAM, context: issued }, ['team.manage']);
    await test.app.request('/instructions', { headers: { Authorization: `Bearer ${TOKEN}` } });
    const update = await test.app.request('/team', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: current }),
    });
    expect(update.status).toBe(200);

    await test.app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        otlpInlineClaudeCall(
          {
            model: 'claude-opus-4-6',
            system: [{ type: 'text', text: issued }],
            messages: [],
          },
          {
            id: 'msg_stale_context',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        ),
      ),
    });

    const [stale] = test.telemetryStore.list({ name: 'csuite.context_block.presence' });
    expect(stale?.attributes).toMatchObject({
      'context.block.state': 'stale',
      'context.block.prior_version_present': true,
      'context.block.matched_prior_sha256': expect.any(String),
    });
  });

  it('re-sends an exact missing block, records its absence, and never fires when present', async () => {
    const context = 'Merge only after an independent approval.';
    const missing = makeApp({ ...TEAM, context });
    const pushed: Array<{ title: string | null; body: string }> = [];
    missing.broker.subscribe('engineer-1', async (message) => {
      pushed.push({ title: message.title, body: message.body });
    });
    const response = {
      id: 'msg_context',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    await missing.app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        otlpInlineClaudeCall(
          {
            model: 'claude-opus-4-6',
            system: [{ type: 'text', text: 'The team has merge rules.' }],
            // A paraphrase is not the block: only the exact composed
            // text counts, wherever it appears.
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: 'merge rules: get an approval first' }],
              },
            ],
          },
          response,
        ),
      ),
    });
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0]?.title).toBe('persistent context restored');
    expect(pushed[0]?.body).toContain(context);
    const [absent] = missing.telemetryStore.list({ name: 'csuite.context_block.presence' });
    expect(absent?.attributes).toMatchObject({
      'context.block.kind': 'team_context',
      'context.block.present': false,
      'context.block.resend_fired': true,
    });

    // The next captured turn still lacks the block everywhere, proving
    // that the first delivery did not land. That bypasses the cooldown,
    // re-sends, and is retained as current health rather than silently
    // suppressing recovery.
    await missing.app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        otlpInlineClaudeCall(
          {
            model: 'claude-opus-4-6',
            system: [{ type: 'text', text: 'The team has merge rules.' }],
            messages: [],
          },
          { ...response, id: 'msg_context_still_missing' },
        ),
      ),
    });
    await vi.waitFor(() => expect(pushed).toHaveLength(2));
    expect(missing.diagnostics.unresolved('engineer-1')).toContainEqual({
      cause: 'context.block_resend_unconfirmed',
      since: expect.any(Number),
    });

    // A delivered resend lands in the CONVERSATION — the runner's system
    // projection is composed once at start and cannot change. The exact
    // payload the watchdog pushed, arriving in a message, is what
    // confirms delivery; requiring it in `system` would make every
    // resend unconfirmable and the bypass above re-fire on each
    // captured request (observed live, 2026-08-01).
    await missing.app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        otlpInlineClaudeCall(
          {
            model: 'claude-opus-4-6',
            system: [{ type: 'text', text: 'The team has merge rules.' }],
            messages: [{ role: 'user', content: [{ type: 'text', text: pushed[1]?.body ?? '' }] }],
          },
          { ...response, id: 'msg_context_confirmed' },
        ),
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushed).toHaveLength(2);
    expect(missing.diagnostics.unresolved('engineer-1')).not.toContainEqual({
      cause: 'context.block_resend_unconfirmed',
      since: expect.any(Number),
    });
    const confirmed = missing.telemetryStore.list({ name: 'csuite.context_block.presence' }).at(-1);
    expect(confirmed?.attributes).toMatchObject({
      'context.block.state': 'current',
      'context.block.present_in': 'input_messages',
    });

    const present = makeApp({ ...TEAM, context });
    const negative: unknown[] = [];
    present.broker.subscribe('engineer-1', async (message) => {
      negative.push(message);
    });
    await present.app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        otlpInlineClaudeCall(
          {
            model: 'claude-opus-4-6',
            system: [{ type: 'text', text: `prefix\n${context}\nsuffix` }],
            messages: [],
          },
          response,
        ),
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(negative).toEqual([]);
    const [seen] = present.telemetryStore.list({ name: 'csuite.context_block.presence' });
    expect(seen?.attributes).toMatchObject({
      'context.block.present': true,
      'context.block.resend_fired': false,
    });
  });

  it('rebuilds Claude packet exemptions after a cold broker start and still redacts a tool result', async () => {
    const secret = 'registered-claude-route';
    const context = secret;
    registerSecretValues([secret]);
    const { app, genaiStore, rawBodyStore } = makeApp({ ...TEAM, context });
    const request = {
      model: 'claude-opus-4-6',
      // Deliberately do not call /packet first: this is the broker-restarted
      // while the runner session remained live shape.
      system: [{ type: 'text', text: `harness prefix\n${context}` }],
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't', content: `stdout: ${secret}` }],
        },
      ],
    };
    const response = {
      id: 'msg_exempt',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const res = await app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(otlpInlineClaudeCall(request, response)),
    });
    expect(res.status).toBe(200);
    const [stored] = genaiStore.list({ memberName: 'engineer-1' });
    const systemText = stored?.systemInstructions
      .map((part) => ('content' in part ? String(part.content) : ''))
      .join('');
    expect(systemText).toContain(context);
    expect(JSON.stringify(stored?.inputMessages)).toContain(`stdout: ${REDACTED}`);
    expect(JSON.stringify(stored?.inputMessages)).not.toContain(secret);
    const rawRequest = rawBodyStore.list({ memberName: 'engineer-1', kind: 'request' })[0];
    const rawBody = JSON.parse(
      rawBodyStore.getBlob(rawRequest?.hash ?? '')?.toString('utf8') ?? '{}',
    );
    expect(JSON.stringify(rawBody.messages)).toContain(`stdout: ${REDACTED}`);
    expect(JSON.stringify(rawBody.messages)).not.toContain(secret);
    const rawSystem = rawBody.system.map((part: { text?: string }) => part.text ?? '').join('');
    const capturedBlock = rawSystem.slice(
      rawSystem.indexOf(context),
      rawSystem.indexOf(context) + context.length,
    );
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(sha(capturedBlock)).toBe(sha(context));
  });

  it('acknowledges both byte-exact Claude bodies and preserves the derived record', async () => {
    const { app, genaiStore, rawBodyStore } = makeApp();
    const request = {
      model: 'claude-opus-4-6',
      system: [{ type: 'text', text: 'Be exact.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    };
    const response = {
      id: 'msg_relay_1',
      model: 'claude-opus-4-6',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 2 },
    };
    const res = await app.request('/otlp/v1/logs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-CSuite-Raw-Bodies': '2',
      },
      body: JSON.stringify(otlpInlineClaudeCall(request, response)),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      partialSuccess: {},
      csuite: { rawBodiesCaptured: 2 },
    });
    expect(rawBodyStore.count()).toBe(2);
    const requestRow = rawBodyStore.list({ memberName: 'engineer-1', kind: 'request' })[0];
    const responseRow = rawBodyStore.list({ memberName: 'engineer-1', kind: 'response' })[0];
    expect(rawBodyStore.getBlob(requestRow?.hash ?? '')?.toString('utf8')).toBe(
      JSON.stringify(request),
    );
    expect(rawBodyStore.getBlob(responseRow?.hash ?? '')?.toString('utf8')).toBe(
      JSON.stringify(response),
    );
    const [derived] = genaiStore.list({ memberName: 'engineer-1' });
    expect(derived).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      responseId: 'msg_relay_1',
      usage: { inputTokens: 7, outputTokens: 2 },
      requestSha256: requestRow?.hash,
      responseSha256: responseRow?.hash,
    });
  });
});

// ─── GET /members/:name/genai — the trace-enrichment read path ──────

const READER_TOKEN = 'csuite_test_genai_reader';
const OUTSIDER_TOKEN = 'csuite_test_genai_outsider';

function makeReadApp() {
  const broker = new Broker({ eventLog: new InMemoryEventLog() });
  const members = createMemberStore([
    {
      name: 'engineer-1',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: TOKEN,
    },
    {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['activity.read'],
      token: READER_TOKEN,
    },
    {
      name: 'outsider',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: OUTSIDER_TOKEN,
    },
  ]);
  const db = openDatabase(':memory:');
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const genaiStore = createGenAiStore(db, { logger });
  const tokens = createTokenStoreFromMembers(db, members);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions: new SessionStore(db),
    genaiStore,
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    logger,
  });
  return { app, genaiStore };
}

function seedInference(overrides: Record<string, unknown> = {}) {
  return {
    operationName: 'chat' as const,
    provider: 'anthropic' as const,
    model: 'claude-fable-5',
    responseId: 'msg_seed_1',
    finishReasons: ['end_turn'],
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
    },
    systemInstructions: [{ type: 'text' as const, content: 'You are Claude Code.' }],
    inputMessages: [{ role: 'user', parts: [{ type: 'text' as const, content: 'do the thing' }] }],
    outputMessages: [{ role: 'assistant', parts: [{ type: 'text' as const, content: 'done' }] }],
    querySource: 'repl_main_thread',
    agentName: null,
    ts: 1_700_000_100_000,
    requestBodyRef: '/tmp/should-not-leak.json',
    requestSha256: 'a'.repeat(64),
    responseSha256: 'b'.repeat(64),
    ...overrides,
  };
}

function authGet(token: string, path: string): Promise<Response> {
  return Promise.resolve(
    makeReadAppSingleton.app.request(path, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

// One shared app across the GET tests — rows are additive per test.
const makeReadAppSingleton = makeReadApp();

describe('GET /members/:name/genai', () => {
  it('403s a member without activity.read reading another member', async () => {
    const resp = await authGet(OUTSIDER_TOKEN, '/members/engineer-1/genai');
    expect(resp.status).toBe(403);
  });

  it('returns rows for self and for activity.read holders, without body refs', async () => {
    makeReadAppSingleton.genaiStore.append('engineer-1', seedInference());
    const self = await authGet(TOKEN, '/members/engineer-1/genai');
    expect(self.status).toBe(200);
    const selfBody = (await self.json()) as { inferences: Array<Record<string, unknown>> };
    expect(selfBody.inferences).toHaveLength(1);
    const row = selfBody.inferences[0] as Record<string, unknown>;
    expect(row.responseId).toBe('msg_seed_1');
    expect(row.memberName).toBe('engineer-1');
    expect((row.systemInstructions as Array<{ content?: string }>)[0]?.content).toBe(
      'You are Claude Code.',
    );
    // Server-internal raw-body pointers must not cross the wire.
    expect('requestBodyRef' in row).toBe(false);
    expect('requestSha256' in row).toBe(false);
    expect('responseSha256' in row).toBe(false);

    const reader = await authGet(READER_TOKEN, '/members/engineer-1/genai');
    expect(reader.status).toBe(200);
  });

  it('bounds by from/to on ts and enforces numeric params', async () => {
    makeReadAppSingleton.genaiStore.append(
      'engineer-1',
      seedInference({ responseId: 'msg_seed_2', ts: 1_700_000_200_000 }),
    );
    const bounded = await authGet(
      TOKEN,
      '/members/engineer-1/genai?from=1700000150000&to=1700000250000',
    );
    const body = (await bounded.json()) as { inferences: Array<{ responseId: string }> };
    expect(body.inferences.map((r) => r.responseId)).toEqual(['msg_seed_2']);

    const bad = await authGet(TOKEN, '/members/engineer-1/genai?from=abc');
    expect(bad.status).toBe(400);
  });

  it('serves the light call-ledger projection under view=summary', async () => {
    const resp = await authGet(TOKEN, '/members/engineer-1/genai?view=summary');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { inferences: Array<Record<string, unknown>> };
    expect(body.inferences.length).toBeGreaterThan(0);
    const row = body.inferences[0] as Record<string, unknown>;
    // Identity + attribution + cost survive…
    expect(row.responseId).toBe('msg_seed_1');
    expect(row.querySource).toBe('repl_main_thread');
    expect(row.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(typeof row.id).toBe('number');
    // …the heavy content arrays do not.
    expect('systemInstructions' in row).toBe(false);
    expect('inputMessages' in row).toBe(false);
    expect('outputMessages' in row).toBe(false);
    // Server-internal pointers still don't cross the wire.
    expect('requestBodyRef' in row).toBe(false);
  });

  it('accepts a composite cursor without skipping equal-ts rows', async () => {
    const ts = 1_700_000_300_000;
    for (let i = 0; i < 3; i++) {
      makeReadAppSingleton.genaiStore.append(
        'engineer-1',
        seedInference({ responseId: `msg_cursor_${i}`, ts }),
      );
    }
    const first = await authGet(TOKEN, `/members/engineer-1/genai?from=${ts}&to=${ts}&limit=2`);
    const firstBody = (await first.json()) as {
      inferences: Array<{ id: number; ts: number; responseId: string }>;
    };
    const boundary = firstBody.inferences[1];
    expect(boundary).toBeDefined();

    const next = await authGet(
      TOKEN,
      `/members/engineer-1/genai?from=${ts}&to=${ts}&limit=2&cursor_ts=${boundary?.ts}&cursor_id=${boundary?.id}`,
    );
    const nextBody = (await next.json()) as {
      inferences: Array<{ responseId: string }>;
    };
    expect(nextBody.inferences.map((row) => row.responseId)).toEqual(['msg_cursor_2']);
  });

  it('rejects a partial composite cursor', async () => {
    const resp = await authGet(TOKEN, '/members/engineer-1/genai?cursor_id=1');
    expect(resp.status).toBe(400);
  });
});

describe('GET /members/:name/genai/:id', () => {
  it('serves one full record by id, with the same read gate as the list', async () => {
    const list = await authGet(TOKEN, '/members/engineer-1/genai?view=summary');
    const { inferences } = (await list.json()) as { inferences: Array<{ id: number }> };
    const first = inferences[0];
    expect(first).toBeDefined();
    const id = (first as { id: number }).id;

    const self = await authGet(TOKEN, `/members/engineer-1/genai/${id}`);
    expect(self.status).toBe(200);
    const body = (await self.json()) as { inference: Record<string, unknown> };
    expect(body.inference.id).toBe(id);
    expect(Array.isArray(body.inference.systemInstructions)).toBe(true);
    expect(Array.isArray(body.inference.inputMessages)).toBe(true);
    expect('requestBodyRef' in body.inference).toBe(false);

    const reader = await authGet(READER_TOKEN, `/members/engineer-1/genai/${id}`);
    expect(reader.status).toBe(200);
    const outsider = await authGet(OUTSIDER_TOKEN, `/members/engineer-1/genai/${id}`);
    expect(outsider.status).toBe(403);
  });

  it('404s a cross-member id (indistinguishable from absent) and absent ids', async () => {
    makeReadAppSingleton.genaiStore.append('director-1', seedInference({ responseId: 'msg_d1' }));
    const rows = makeReadAppSingleton.genaiStore.list({ memberName: 'director-1' });
    const directorRow = rows[rows.length - 1];
    expect(directorRow).toBeDefined();
    // engineer-1 asking for a director-1 record under their own name.
    const cross = await authGet(
      TOKEN,
      `/members/engineer-1/genai/${(directorRow as { id: number }).id}`,
    );
    expect(cross.status).toBe(404);
    const absent = await authGet(TOKEN, '/members/engineer-1/genai/999999');
    expect(absent.status).toBe(404);
    const invalid = await authGet(TOKEN, '/members/engineer-1/genai/abc');
    expect(invalid.status).toBe(400);
  });
});
