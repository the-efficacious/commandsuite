/**
 * `POST /members/:name/genai` route tests — the codex gen_ai + raw-body
 * ingest. A bearer-authed self upload of one inference's verbatim
 * request/response payload bytes must: content-address the raw bytes into
 * the raw-body store, map a parsed copy into a `GenAiInference` (provider
 * `openai`) linked by sha256, and gate on self (403) + auth (401).
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Team } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createGenAiStore } from '../src/genai-store.js';
import { createMemberStore } from '../src/members.js';
import { createRawBodyStore } from '../src/raw-body-store.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const TEAM: Team = { name: 'demo-team', context: '', permissionPresets: {} };
const TOKEN = 'csuite_test_genai';

function makeApp() {
  const broker = new Broker({ eventLog: new InMemoryEventLog() });
  const members = createMemberStore([
    {
      name: 'engineer-1',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: TOKEN,
    },
  ]);
  const db = openDatabase(':memory:');
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const genaiStore = createGenAiStore(db, { logger });
  const rawBodyStore = createRawBodyStore(db, { logger });
  const tokens = createTokenStoreFromMembers(db, members);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions: new SessionStore(db),
    genaiStore,
    rawBodyStore,
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    logger,
  });
  return { app, genaiStore, rawBodyStore };
}

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
  it('content-addresses raw bytes and stores a mapped GenAiInference', async () => {
    const { app, genaiStore, rawBodyStore } = makeApp();
    const res = await post(app, 'engineer-1', { inferences: [inference()] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });

    // Raw bytes captured verbatim: one request + one response exchange.
    expect(rawBodyStore.count()).toBe(2);
    const reqExchange = rawBodyStore.list({ memberName: 'engineer-1', kind: 'request' })[0];
    expect(reqExchange).toBeDefined();

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

  it('captures raw bytes even when a body is not valid JSON (model-only record)', async () => {
    const { app, genaiStore, rawBodyStore } = makeApp();
    const bad = {
      requestBase64: Buffer.from('not json', 'utf8').toString('base64'),
      responseBase64: Buffer.from('also not json', 'utf8').toString('base64'),
      model: 'gpt-5.5',
      responseId: 'resp_x',
    };
    const res = await post(app, 'engineer-1', { inferences: [bad] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });
    // Raw bytes landed; the derived record is model-only (no messages).
    expect(rawBodyStore.count()).toBe(2);
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
