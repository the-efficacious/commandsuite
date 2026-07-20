/**
 * Tests for the codex rollout-primary content parser.
 *
 * Feeds synthetic rollout JSONL lines — modeled line-for-line on a real
 * `codex exec` rollout (codex 0.130.0) — into `createRolloutParser` and
 * asserts the normalized `ActivityEvent`s. The fixture deliberately
 * includes the injected `developer` preamble and `<environment_context>`
 * user message that precede the real prompt, to pin that they are NOT
 * mistaken for the user opener.
 */

import type { ActivityEvent } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { createRolloutParser } from '../../../src/runtime/agents/codex/rollout-parser.js';

function run(lines: unknown[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const parser = createRolloutParser({ enqueue: (e) => events.push(e) });
  for (const l of lines) parser.handleLine(typeof l === 'string' ? l : JSON.stringify(l));
  return events;
}

/** A realistic full-turn rollout: shell command then a one-line answer. */
function fullTurnLines(): unknown[] {
  return [
    {
      timestamp: '2026-07-09T12:40:08.000Z',
      type: 'session_meta',
      payload: {
        id: 'sess-1',
        cwd: '/work',
        model_provider: 'openai',
        base_instructions: { text: 'SYSTEM PROMPT' },
      },
    },
    {
      timestamp: '2026-07-09T12:40:09.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'turn-1',
        started_at: 1783626009,
        model_context_window: 258400,
      },
    },
    // Injected developer preamble — must be ignored.
    {
      timestamp: '2026-07-09T12:40:09.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '<permissions instructions> ...' }],
      },
    },
    // Injected environment context (role user) — must be ignored.
    {
      timestamp: '2026-07-09T12:40:09.200Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context> ... </environment_context>' }],
      },
    },
    {
      timestamp: '2026-07-09T12:40:09.300Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1', model: 'gpt-5.5' },
    },
    // The real user prompt as a response_item (ignored) ...
    {
      timestamp: '2026-07-09T12:40:09.400Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Run echo hello and report it.' }],
      },
    },
    // ... and its clean event_msg form (the source of truth).
    {
      timestamp: '2026-07-09T12:40:09.500Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Run echo hello and report it.' },
    },
    {
      timestamp: '2026-07-09T12:40:10.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_abc',
        arguments: '{"cmd":"echo hello"}',
      },
    },
    {
      timestamp: '2026-07-09T12:40:11.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_abc',
        output: 'Output:\nhello\nProcess exited with code 0\n',
      },
    },
    {
      timestamp: '2026-07-09T12:40:12.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 800,
            output_tokens: 40,
            reasoning_output_tokens: 10,
            total_tokens: 1240,
          },
          total_token_usage: { input_tokens: 5000, cached_input_tokens: 3200, output_tokens: 400 },
        },
      },
    },
    {
      timestamp: '2026-07-09T12:40:13.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'hello', phase: 'final_answer' },
    },
    // Assistant text also appears as a response_item — must NOT double.
    {
      timestamp: '2026-07-09T12:40:13.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    },
    {
      timestamp: '2026-07-09T12:40:14.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        duration_ms: 5000,
        completed_at: 1783626014,
      },
    },
  ];
}

describe('createRolloutParser', () => {
  it('maps a full turn to user_prompt + tool_action + one llm_exchange', () => {
    const events = run(fullTurnLines());

    const prompts = events.filter((e) => e.kind === 'user_prompt');
    const tools = events.filter((e) => e.kind === 'tool_action');
    const exchanges = events.filter((e) => e.kind === 'llm_exchange');
    expect(prompts).toHaveLength(1);
    expect(tools).toHaveLength(1);
    expect(exchanges).toHaveLength(1);

    const prompt = prompts[0];
    if (prompt?.kind !== 'user_prompt') throw new Error('expected user_prompt');
    // The clean prompt — NOT the developer preamble or environment_context.
    expect(prompt.text).toBe('Run echo hello and report it.');
    expect(prompt.agent).toBe('codex');

    const tool = tools[0];
    if (tool?.kind !== 'tool_action') throw new Error('expected tool_action');
    expect(tool.toolName).toBe('exec_command');
    expect(tool.source).toBe('codex_rollout');
    expect(tool.toolUseId).toBe('call_abc');
    expect(tool.input).toEqual({ cmd: 'echo hello' });
    expect(tool.result).toContain('hello');
    expect(tool.isError).toBe(false);

    const ex = exchanges[0];
    if (ex?.kind !== 'llm_exchange') throw new Error('expected llm_exchange');
    expect(ex.agent).toBe('codex');
    expect(ex.entry.request.model).toBe('gpt-5.5');
    // Assistant text captured exactly once (from agent_message, not the
    // duplicate response_item).
    const content = ex.entry.response?.messages[0]?.content ?? [];
    expect(content).toEqual([{ type: 'text', text: 'hello' }]);
    // Usage mapped from last_token_usage (snake_case → Anthropic shape).
    expect(ex.entry.response?.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 40,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 800,
    });
    // Bounds from codex clocks: started_at (unix s) and duration_ms.
    expect(ex.ts).toBe(1783626009000);
    expect(ex.duration).toBe(5000);
    expect(ex.entry.startedAt).toBe(1783626009000);
    expect(ex.entry.endedAt).toBe(1783626014000);
    expect(ex.entry.response?.stopReason).toBe('end_turn');
  });

  it('detects exec error from a nonzero exit code', () => {
    const lines = [
      {
        timestamp: '2026-07-09T12:40:09Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 't', started_at: 1 },
      },
      {
        timestamp: '2026-07-09T12:40:10Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'c1',
          arguments: '{"cmd":"false"}',
        },
      },
      {
        timestamp: '2026-07-09T12:40:11Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: 'Process exited with code 1\n',
        },
      },
    ];
    const tool = run(lines).find((e) => e.kind === 'tool_action');
    if (tool?.kind !== 'tool_action') throw new Error('expected tool_action');
    expect(tool.isError).toBe(true);
  });

  it('leaves isError undefined when the output has no exit signal', () => {
    const lines = [
      {
        timestamp: '2026-07-09T12:40:10Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'mcp__x__y', call_id: 'c2', arguments: '{"a":1}' },
      },
      {
        timestamp: '2026-07-09T12:40:11Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c2', output: 'some tool result text' },
      },
    ];
    const tool = run(lines).find((e) => e.kind === 'tool_action');
    if (tool?.kind !== 'tool_action') throw new Error('expected tool_action');
    expect(tool.isError).toBeUndefined();
    expect(tool.toolName).toBe('mcp__x__y');
  });

  it('captures reasoning summaries as thinking blocks', () => {
    const lines = [
      {
        timestamp: '2026-07-09T12:40:09Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 't', started_at: 1 },
      },
      {
        timestamp: '2026-07-09T12:40:10Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: ['Consider the layout.'],
          encrypted_content: 'gAAAAB...',
        },
      },
      {
        timestamp: '2026-07-09T12:40:11Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Done.', phase: 'final_answer' },
      },
      {
        timestamp: '2026-07-09T12:40:12Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 't', duration_ms: 3000, completed_at: 4 },
      },
    ];
    const ex = run(lines).find((e) => e.kind === 'llm_exchange');
    if (ex?.kind !== 'llm_exchange') throw new Error('expected llm_exchange');
    const content = ex.entry.response?.messages[0]?.content ?? [];
    // Thinking precedes the visible answer.
    expect(content[0]).toEqual({ type: 'thinking', text: 'Consider the layout.' });
    expect(content[1]).toEqual({ type: 'text', text: 'Done.' });
  });

  it('does not emit an llm_exchange for a pure tool turn', () => {
    const lines = [
      {
        timestamp: '2026-07-09T12:40:09Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 't', started_at: 1 },
      },
      {
        timestamp: '2026-07-09T12:40:10Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'c',
          arguments: '{"cmd":"ls"}',
        },
      },
      {
        timestamp: '2026-07-09T12:40:11Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c',
          output: 'Process exited with code 0',
        },
      },
      {
        timestamp: '2026-07-09T12:40:12Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 't', duration_ms: 100, completed_at: 2 },
      },
    ];
    const events = run(lines);
    expect(events.filter((e) => e.kind === 'tool_action')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'llm_exchange')).toHaveLength(0);
  });

  it('tolerates a null token_count info', () => {
    const lines = [
      {
        timestamp: '2026-07-09T12:40:09Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 't', started_at: 1 },
      },
      {
        timestamp: '2026-07-09T12:40:10Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: null, rate_limits: { primary: {} } },
      },
      {
        timestamp: '2026-07-09T12:40:11Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'hi', phase: 'final_answer' },
      },
      {
        timestamp: '2026-07-09T12:40:12Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 't', duration_ms: 1, completed_at: 2 },
      },
    ];
    const ex = run(lines).find((e) => e.kind === 'llm_exchange');
    if (ex?.kind !== 'llm_exchange') throw new Error('expected llm_exchange');
    // No usable usage → null rather than an all-null husk.
    expect(ex.entry.response?.usage).toBeNull();
  });

  it('flush() emits a turn whose task_complete never arrived', () => {
    const parser = (() => {
      const events: ActivityEvent[] = [];
      const p = createRolloutParser({ enqueue: (e) => events.push(e) });
      return { events, p };
    })();
    for (const l of [
      {
        timestamp: '2026-07-09T12:40:09Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 't', started_at: 1 },
      },
      {
        timestamp: '2026-07-09T12:40:10Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'partial', phase: 'final_answer' },
      },
    ]) {
      parser.p.handleLine(JSON.stringify(l));
    }
    expect(parser.events.filter((e) => e.kind === 'llm_exchange')).toHaveLength(0);
    parser.p.flush();
    const ex = parser.events.find((e) => e.kind === 'llm_exchange');
    if (ex?.kind !== 'llm_exchange') throw new Error('expected llm_exchange after flush');
    // A drained (never-completed) turn has no stop reason.
    expect(ex.entry.response?.stopReason).toBeNull();
    // Second flush is a no-op.
    parser.p.flush();
    expect(parser.events.filter((e) => e.kind === 'llm_exchange')).toHaveLength(1);
  });

  it('never throws on an unparseable line', () => {
    expect(() => run(['{not json', '', '  ', '{"type":"event_msg"}'])).not.toThrow();
    expect(run(['{not json'])).toHaveLength(0);
  });
});
