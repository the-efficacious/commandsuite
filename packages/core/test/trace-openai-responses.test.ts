/**
 * `openaiResponsesToGenAi` mapper tests.
 *
 * Hand-authored codex Responses `response.create` request bodies + completed
 * responses (matching the real rollout-trace bundle payload shapes) are fed
 * through the pure mapper to assert the exact GenAiInference record the
 * server persists: provider `openai`, instructions kept separate, one
 * message per Responses `input`/`output` item (message text, function_call
 * → tool_call, function_call_output → tool_call_response, reasoning), usage
 * mapped from the snake_case `token_usage`, derived finish_reasons, and the
 * never-drop `generic` fallback + redaction.
 */

import { describe, expect, it } from 'vitest';
import { openaiResponsesToGenAi } from '../src/trace/openai-responses.js';
import { REDACTED } from '../src/trace/redact.js';

function requestBody() {
  return {
    type: 'response.create',
    model: 'gpt-5.5',
    instructions: 'You are Codex, a coding agent.',
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '<permissions instructions> ...' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Run echo hi.' }],
      },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan the command.' }] },
      {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_1',
        arguments: '{"cmd":"echo hi"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'hi\nexit 0' },
    ],
    tools: [{ type: 'function', name: 'exec_command' }],
    reasoning: { effort: 'medium' },
  };
}

function responseBody() {
  return {
    response_id: 'resp_abc',
    upstream_request_id: 'ur_1',
    token_usage: {
      input_tokens: 1200,
      cached_input_tokens: 800,
      output_tokens: 40,
      reasoning_output_tokens: 10,
      total_tokens: 1240,
    },
    output_items: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ],
  };
}

describe('openaiResponsesToGenAi', () => {
  it('maps a full Responses request+response to a GenAiInference', () => {
    const rec = openaiResponsesToGenAi({
      requestBody: requestBody(),
      responseBody: responseBody(),
      querySource: 'codex_main_thread',
      ts: 1783626009000,
    });

    expect(rec.operationName).toBe('chat');
    expect(rec.provider).toBe('openai');
    expect(rec.model).toBe('gpt-5.5');
    expect(rec.responseId).toBe('resp_abc');
    expect(rec.querySource).toBe('codex_main_thread');
    expect(rec.ts).toBe(1783626009000);

    // instructions kept SEPARATE from the chat history.
    expect(rec.systemInstructions).toEqual([
      { type: 'text', content: 'You are Codex, a coding agent.' },
    ]);

    // usage mapped from snake_case token_usage (no cache-write count).
    expect(rec.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 40,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: null,
    });

    // one message per input item, in order, with the right roles/parts.
    expect(
      rec.inputMessages.map((m) => `${m.role}:${m.parts.map((p) => p.type).join(',')}`),
    ).toEqual([
      'developer:text',
      'user:text',
      'assistant:reasoning',
      'assistant:tool_call',
      'tool:tool_call_response',
    ]);

    // function_call → tool_call with parsed arguments + call id.
    const toolCall = rec.inputMessages[3]?.parts[0];
    expect(toolCall).toEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'exec_command',
      arguments: { cmd: 'echo hi' },
    });
    // function_call_output → tool_call_response paired by call id.
    expect(rec.inputMessages[4]?.parts[0]).toEqual({
      type: 'tool_call_response',
      id: 'call_1',
      response: 'hi\nexit 0',
      is_error: false,
    });
    // reasoning summary text captured.
    expect(rec.inputMessages[2]?.parts[0]).toEqual({
      type: 'reasoning',
      content: 'Plan the command.',
    });

    // output message + a stop finish reason (no tool call in output).
    expect(rec.outputMessages).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'done' }] },
    ]);
    expect(rec.finishReasons).toEqual(['stop']);
  });

  it('derives tool_calls finish reason when the output is a function_call', () => {
    const res = {
      response_id: 'r',
      token_usage: { input_tokens: 1, output_tokens: 1 },
      output_items: [
        { type: 'function_call', name: 'exec_command', call_id: 'c', arguments: '{"cmd":"ls"}' },
      ],
    };
    const rec = openaiResponsesToGenAi({ requestBody: requestBody(), responseBody: res });
    expect(rec.finishReasons).toEqual(['tool_calls']);
    expect(rec.outputMessages[0]?.parts[0]).toMatchObject({
      type: 'tool_call',
      name: 'exec_command',
    });
  });

  it('redacts secrets in text and tool arguments', () => {
    const req = {
      model: 'gpt-5.5',
      instructions: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz here',
      input: [
        {
          type: 'function_call',
          name: 't',
          call_id: 'c',
          arguments: JSON.stringify({ token: 'ghp_0123456789012345678901234567890123' }),
        },
      ],
    };
    const rec = openaiResponsesToGenAi({ requestBody: req, responseBody: {} });
    expect(JSON.stringify(rec.systemInstructions)).toContain(REDACTED);
    expect(JSON.stringify(rec.inputMessages[0]?.parts[0])).toContain(REDACTED);
  });

  it('never drops an unknown item — falls back to generic', () => {
    const req = { model: 'gpt-5.5', input: [{ type: 'some_future_item', mystery: true }] };
    const rec = openaiResponsesToGenAi({ requestBody: req, responseBody: {} });
    expect(rec.inputMessages).toHaveLength(1);
    expect(rec.inputMessages[0]?.parts[0]?.type).toBe('generic');
  });

  it('handles a null/malformed body without throwing (model-only record)', () => {
    const rec = openaiResponsesToGenAi({
      requestBody: null,
      responseBody: null,
      model: 'gpt-5.5',
      responseId: 'resp_x',
    });
    expect(rec.provider).toBe('openai');
    expect(rec.model).toBe('gpt-5.5');
    expect(rec.responseId).toBe('resp_x');
    expect(rec.inputMessages).toEqual([]);
    expect(rec.outputMessages).toEqual([]);
    expect(rec.usage).toBeNull();
  });
});
