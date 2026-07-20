/**
 * `anthropicToGenAi` mapper tests.
 *
 * Hand-authored Anthropic Messages request/response bodies (matching the
 * real `/v1/messages` shape) are fed through the pure mapper to assert the
 * exact OpenTelemetry-GenAI record shape the server phase depends on:
 * roles, part types, tool_call id/name/arguments, tool_call_response
 * id/response/is_error, reasoning, system_instructions, usage (incl. the
 * Anthropic cache extensions), and finish_reasons. Also covers redaction
 * and the never-drop `generic` fallback for unknown blocks.
 */

import { describe, expect, it } from 'vitest';
import { anthropicToGenAi } from '../src/trace/genai.js';
import { REDACTED } from '../src/trace/redact.js';

function requestBody() {
  return {
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    system: 'You are a careful assistant.',
    messages: [
      { role: 'user', content: 'Read the file, please.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should read it first.', signature: 'sig...' },
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'no such file',
            is_error: true,
          },
        ],
      },
    ],
  };
}

function responseBody() {
  return {
    id: 'msg_response_123',
    role: 'assistant',
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Done reading.' }],
    usage: {
      input_tokens: 4290,
      output_tokens: 644,
      cache_read_input_tokens: 12,
      cache_creation_input_tokens: 24319,
    },
  };
}

describe('anthropicToGenAi', () => {
  it('maps standard attributes and finish_reasons', () => {
    const rec = anthropicToGenAi({
      requestBody: requestBody(),
      responseBody: responseBody(),
      ts: 1000,
    });
    expect(rec.operationName).toBe('chat');
    expect(rec.provider).toBe('anthropic');
    expect(rec.model).toBe('claude-opus-4-8');
    expect(rec.responseId).toBe('msg_response_123');
    expect(rec.finishReasons).toEqual(['end_turn']);
    expect(rec.ts).toBe(1000);
  });

  it('maps usage incl. Anthropic cache extensions', () => {
    const rec = anthropicToGenAi({ requestBody: requestBody(), responseBody: responseBody() });
    expect(rec.usage).toEqual({
      inputTokens: 4290,
      outputTokens: 644,
      cacheReadInputTokens: 12,
      cacheCreationInputTokens: 24319,
    });
  });

  it('maps the string system prompt to a single text part, separate from history', () => {
    const rec = anthropicToGenAi({ requestBody: requestBody(), responseBody: responseBody() });
    expect(rec.systemInstructions).toEqual([
      { type: 'text', content: 'You are a careful assistant.' },
    ]);
  });

  it('maps an array system prompt to mapped parts', () => {
    const rec = anthropicToGenAi({
      requestBody: {
        ...requestBody(),
        system: [
          { type: 'text', text: 'Line one.' },
          { type: 'text', text: 'Line two.' },
        ],
      },
      responseBody: responseBody(),
    });
    expect(rec.systemInstructions).toEqual([
      { type: 'text', content: 'Line one.' },
      { type: 'text', content: 'Line two.' },
    ]);
  });

  it('maps input messages preserving role and send order with typed parts', () => {
    const rec = anthropicToGenAi({ requestBody: requestBody(), responseBody: responseBody() });
    expect(rec.inputMessages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Read the file, please.' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'I should read it first.' },
          { type: 'text', content: 'On it.' },
          { type: 'tool_call', id: 'toolu_1', name: 'Bash', arguments: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            type: 'tool_call_response',
            id: 'toolu_1',
            response: 'no such file',
            is_error: true,
          },
        ],
      },
    ]);
  });

  it('maps the response to a single assistant output message', () => {
    const rec = anthropicToGenAi({ requestBody: requestBody(), responseBody: responseBody() });
    expect(rec.outputMessages).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'Done reading.' }] },
    ]);
  });

  it('maps a base64 image block to a blob part and a url image to a file ref', () => {
    const rec = anthropicToGenAi({
      requestBody: {
        model: 'claude-opus-4-8',
        system: null,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
              },
              { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
            ],
          },
        ],
      },
      responseBody: responseBody(),
    });
    expect(rec.inputMessages[0]?.parts).toEqual([
      { type: 'blob', mime_type: 'image/png', data: 'AAAA' },
      { type: 'file', mime_type: null, uri: 'https://x/y.png' },
    ]);
  });

  it('never drops an unknown block — emits a generic part', () => {
    const rec = anthropicToGenAi({
      requestBody: {
        model: 'm',
        system: null,
        messages: [
          { role: 'user', content: [{ type: 'server_tool_use', id: 'x', name: 'web_search' }] },
        ],
      },
      responseBody: responseBody(),
    });
    const part = rec.inputMessages[0]?.parts[0];
    expect(part?.type).toBe('generic');
    expect(part).toMatchObject({
      type: 'generic',
      content: { type: 'server_tool_use', id: 'x', name: 'web_search' },
    });
  });

  it('redacts secrets in text and tool arguments/content', () => {
    const rec = anthropicToGenAi({
      requestBody: {
        model: 'm',
        system: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz here',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 't', name: 'run', input: { token: `ghp_${'a'.repeat(30)}` } },
            ],
          },
        ],
      },
      responseBody: responseBody(),
    });
    expect(rec.systemInstructions[0]).toEqual({ type: 'text', content: `key ${REDACTED} here` });
    const call = rec.inputMessages[0]?.parts[0];
    expect(call).toMatchObject({ type: 'tool_call', arguments: { token: REDACTED } });
  });

  it('prefers explicit overrides for model, responseId, usage, and ts', () => {
    const rec = anthropicToGenAi({
      requestBody: requestBody(),
      responseBody: { ...responseBody(), usage: undefined },
      model: 'override-model',
      responseId: 'override-id',
      usage: { input_tokens: 1, output_tokens: 2 },
      ts: 42,
    });
    expect(rec.model).toBe('override-model');
    expect(rec.responseId).toBe('override-id');
    expect(rec.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
    });
    expect(rec.ts).toBe(42);
  });

  it('handles a missing/empty response body defensively', () => {
    const rec = anthropicToGenAi({ requestBody: requestBody(), responseBody: null });
    expect(rec.outputMessages).toEqual([]);
    expect(rec.finishReasons).toEqual([]);
    expect(rec.usage).toBeNull();
    expect(rec.responseId).toBeNull();
  });

  it('passes thread attribution (querySource + agentName) through when provided', () => {
    const rec = anthropicToGenAi({
      requestBody: requestBody(),
      responseBody: responseBody(),
      querySource: 'agent:builtin:general-purpose',
      agentName: 'general-purpose',
    });
    expect(rec.querySource).toBe('agent:builtin:general-purpose');
    expect(rec.agentName).toBe('general-purpose');
  });

  it('defaults thread attribution to null when omitted', () => {
    const rec = anthropicToGenAi({ requestBody: requestBody(), responseBody: responseBody() });
    expect(rec.querySource).toBeNull();
    expect(rec.agentName).toBeNull();
  });

  it('keeps querySource but nulls agentName for a source with no agent (main thread)', () => {
    const rec = anthropicToGenAi({
      requestBody: requestBody(),
      responseBody: responseBody(),
      querySource: 'repl_main_thread',
      agentName: null,
    });
    expect(rec.querySource).toBe('repl_main_thread');
    expect(rec.agentName).toBeNull();
  });
});
