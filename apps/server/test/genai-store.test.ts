/**
 * GenAI inference store tests.
 *
 * Covers append/count/list round-trip, verbatim preservation of the full
 * `input_messages` / `output_messages` / `system_instructions` JSON
 * (losslessness is the point), the `requestBodyRef` / `requestSha256` /
 * `responseSha256` provenance columns (incl. the legacy-table column
 * migration), and the `model` / `from`-`to` filters.
 */

import type { GenAiInference } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createGenAiStore, type GenAiInferenceInput } from '../src/genai-store.js';

function inference(extra?: Partial<GenAiInferenceInput>): GenAiInferenceInput {
  const base: GenAiInference = {
    operationName: 'chat',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    responseId: 'msg_01ABC',
    finishReasons: ['end_turn'],
    usage: {
      inputTokens: 120,
      outputTokens: 45,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 2000,
    },
    systemInstructions: [{ type: 'text', content: 'You are helpful.' }],
    inputMessages: [
      { role: 'user', parts: [{ type: 'text', content: 'hello' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'thinking...' },
          { type: 'tool_call', id: 'toolu_1', name: 'Read', arguments: { path: '/a' } },
        ],
      },
      {
        role: 'user',
        parts: [
          { type: 'tool_call_response', id: 'toolu_1', response: 'file body', is_error: false },
        ],
      },
    ],
    outputMessages: [{ role: 'assistant', parts: [{ type: 'text', content: 'the answer' }] }],
    querySource: 'repl_main_thread',
    agentName: null,
    ts: 1_700_000_000_000,
  };
  return {
    ...base,
    requestBodyRef: '/tmp/req-abc.json',
    requestSha256: 'a'.repeat(64),
    responseSha256: 'b'.repeat(64),
    ...extra,
  };
}

describe('genai store', () => {
  it('appends, counts, and round-trips full message JSON', () => {
    const db = openDatabase(':memory:');
    const store = createGenAiStore(db);
    store.append('alice', inference());

    expect(store.count()).toBe(1);

    const [row] = store.list({ memberName: 'alice' });
    expect(row).toBeDefined();
    expect(row?.model).toBe('claude-opus-4-6');
    expect(row?.responseId).toBe('msg_01ABC');
    expect(row?.finishReasons).toEqual(['end_turn']);
    expect(row?.usage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 2000,
    });
    expect(row?.systemInstructions).toEqual([{ type: 'text', content: 'You are helpful.' }]);
    // Full input context preserved verbatim — nested typed parts intact.
    expect(row?.inputMessages).toHaveLength(3);
    expect(row?.inputMessages[1]?.parts[1]).toEqual({
      type: 'tool_call',
      id: 'toolu_1',
      name: 'Read',
      arguments: { path: '/a' },
    });
    expect(row?.inputMessages[2]?.parts[0]).toEqual({
      type: 'tool_call_response',
      id: 'toolu_1',
      response: 'file body',
      is_error: false,
    });
    expect(row?.outputMessages).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'the answer' }] },
    ]);
    expect(row?.requestBodyRef).toBe('/tmp/req-abc.json');
    // Content addresses of the raw source bytes round-trip.
    expect(row?.requestSha256).toBe('a'.repeat(64));
    expect(row?.responseSha256).toBe('b'.repeat(64));
    expect(row?.ts).toBe(1_700_000_000_000);
    expect(row?.operationName).toBe('chat');
    expect(row?.provider).toBe('anthropic');
    // Main-thread attribution round-trips: source set, no agent.
    expect(row?.querySource).toBe('repl_main_thread');
    expect(row?.agentName).toBeNull();
  });

  it('round-trips subagent thread attribution (querySource + agentName)', () => {
    const db = openDatabase(':memory:');
    const store = createGenAiStore(db);
    store.append(
      'alice',
      inference({ querySource: 'agent:builtin:general-purpose', agentName: 'general-purpose' }),
    );
    const [row] = store.list({ memberName: 'alice' });
    expect(row?.querySource).toBe('agent:builtin:general-purpose');
    expect(row?.agentName).toBe('general-purpose');
  });

  it('stores null thread attribution when absent', () => {
    const db = openDatabase(':memory:');
    const store = createGenAiStore(db);
    store.append('carol', inference({ querySource: null, agentName: null }));
    const [row] = store.list({ memberName: 'carol' });
    expect(row?.querySource).toBeNull();
    expect(row?.agentName).toBeNull();
  });

  it('stores a null usage, requestBodyRef, and sha256 provenance', () => {
    const db = openDatabase(':memory:');
    const store = createGenAiStore(db);
    store.append(
      'bob',
      inference({
        usage: null,
        requestBodyRef: null,
        responseId: null,
        requestSha256: null,
        responseSha256: null,
      }),
    );
    const [row] = store.list({ memberName: 'bob' });
    expect(row?.usage).toBeNull();
    expect(row?.requestBodyRef).toBeNull();
    expect(row?.responseId).toBeNull();
    expect(row?.requestSha256).toBeNull();
    expect(row?.responseSha256).toBeNull();
  });

  it('migrates a legacy table missing the sha256 columns', () => {
    const db = openDatabase(':memory:');
    // The pre-sha256 schema, as older deployments created it.
    db.exec(`
      CREATE TABLE gen_ai_inference (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_name TEXT NOT NULL,
        ts INTEGER NOT NULL,
        operation_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        response_id TEXT,
        finish_reasons TEXT NOT NULL,
        usage TEXT,
        system_instructions TEXT NOT NULL,
        input_messages TEXT NOT NULL,
        output_messages TEXT NOT NULL,
        query_source TEXT,
        agent_name TEXT,
        request_body_ref TEXT,
        received_at INTEGER NOT NULL
      );
    `);
    const store = createGenAiStore(db);
    store.append('alice', inference());
    const [row] = store.list({ memberName: 'alice' });
    expect(row?.requestSha256).toBe('a'.repeat(64));
    expect(row?.responseSha256).toBe('b'.repeat(64));
  });

  it('filters by model and by time range', () => {
    const db = openDatabase(':memory:');
    const store = createGenAiStore(db);
    store.append('alice', inference({ model: 'claude-opus-4-6', ts: 1000 }));
    store.append('alice', inference({ model: 'claude-haiku-4-5', ts: 2000 }));
    store.append('alice', inference({ model: 'claude-opus-4-6', ts: 3000 }));

    expect(store.list({ model: 'claude-opus-4-6' })).toHaveLength(2);
    expect(store.list({ model: 'claude-haiku-4-5' })).toHaveLength(1);
    expect(store.list({ from: 1500, to: 2500 })).toHaveLength(1);
    // Oldest-first ordering.
    const all = store.list({ memberName: 'alice' });
    expect(all.map((r) => r.ts)).toEqual([1000, 2000, 3000]);
  });

  it('is durable across separate store handles on the same DB', () => {
    const db = openDatabase(':memory:');
    createGenAiStore(db).append('alice', inference());
    // A fresh store over the same connection sees the row (CREATE TABLE
    // IF NOT EXISTS is idempotent).
    expect(createGenAiStore(db).count()).toBe(1);
  });
});
