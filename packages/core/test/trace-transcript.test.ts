/**
 * Claude Code transcript-parser tests.
 *
 * Hand-authored line objects matching the real JSONL shape (validated
 * against a live `~/.claude/projects/<slug>/<session>.jsonl`) are fed
 * through `parseAnthropicMessage` / `parseTranscriptLine` to assert the
 * structured output the runner's TranscriptReader depends on — content
 * blocks (incl. thinking->text), token-usage mapping, redaction, and
 * defensive envelope handling.
 */

import { describe, expect, it } from 'vitest';
import { REDACTED } from '../src/trace/redact.js';
import { parseAnthropicMessage, parseTranscriptLine } from '../src/trace/transcript.js';

// A realistic assistant `message` envelope: thinking + text + tool_use.
function assistantMessage() {
  return {
    role: 'assistant',
    type: 'message',
    id: 'msg_abc',
    model: 'claude-opus-4-8',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [
      { type: 'thinking', thinking: 'let me check the file', signature: 'sig...' },
      { type: 'text', text: 'Reading now.' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: 'ls', description: 'list' },
        caller: { type: 'direct' },
      },
    ],
    usage: {
      input_tokens: 4290,
      output_tokens: 644,
      cache_read_input_tokens: 12,
      cache_creation_input_tokens: 24319,
    },
  };
}

describe('parseAnthropicMessage', () => {
  it('maps thinking->text, tool_use, and response metadata', () => {
    const parsed = parseAnthropicMessage(assistantMessage());
    expect(parsed.role).toBe('assistant');
    expect(parsed.model).toBe('claude-opus-4-8');
    expect(parsed.stopReason).toBe('tool_use');
    // The API message id — the llm_exchange ↔ gen_ai join key.
    expect(parsed.id).toBe('msg_abc');

    expect(parsed.content).toEqual([
      { type: 'thinking', text: 'let me check the file' },
      { type: 'text', text: 'Reading now.' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: 'ls', description: 'list' },
      },
    ]);
  });

  it('maps usage token counts (input/output/cache)', () => {
    const parsed = parseAnthropicMessage(assistantMessage());
    expect(parsed.usage).toEqual({
      inputTokens: 4290,
      outputTokens: 644,
      cacheReadInputTokens: 12,
      cacheCreationInputTokens: 24319,
    });
  });

  it('maps tool_result blocks {tool_use_id,content,is_error}', () => {
    const parsed = parseAnthropicMessage({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true },
      ],
    });
    expect(parsed.model).toBeNull();
    expect(parsed.usage).toBeNull();
    expect(parsed.stopReason).toBeNull();
    expect(parsed.content).toEqual([
      { type: 'tool_result', toolUseId: 'toolu_1', content: 'ok', isError: false },
      { type: 'tool_result', toolUseId: 'toolu_2', content: 'boom', isError: true },
    ]);
  });

  it('redacts secrets in text, tool inputs, and tool results', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345';
    const parsed = parseAnthropicMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: `key is ${secret}` },
        { type: 'tool_use', id: 't', name: 'Bash', input: { command: `echo ${secret}` } },
        { type: 'tool_result', tool_use_id: 't', content: `out ${secret}`, is_error: false },
      ],
    });
    const text = parsed.content.find((b) => b.type === 'text');
    const use = parsed.content.find((b) => b.type === 'tool_use');
    const result = parsed.content.find((b) => b.type === 'tool_result');
    expect(text?.type === 'text' ? text.text : undefined).toBe(`key is ${REDACTED}`);
    expect(use?.type === 'tool_use' ? (use.input as { command: string }).command : undefined).toBe(
      `echo ${REDACTED}`,
    );
    expect(result?.type === 'tool_result' ? result.content : undefined).toBe(`out ${REDACTED}`);
  });

  it('never throws on a non-object message', () => {
    const parsed = parseAnthropicMessage(null);
    expect(parsed).toEqual({
      role: 'unknown',
      content: [],
      model: null,
      usage: null,
      stopReason: null,
      id: null,
    });
  });
});

describe('parseTranscriptLine', () => {
  it('parses an assistant line (uuid/ts/type + folded message)', () => {
    const entry = parseTranscriptLine({
      type: 'assistant',
      uuid: 'u-1',
      parentUuid: 'u-0',
      timestamp: '2026-07-03T12:00:00.000Z',
      isSidechain: false,
      requestId: 'req_1',
      message: assistantMessage(),
      version: '1.2.3',
    });
    expect(entry).not.toBeNull();
    expect(entry?.uuid).toBe('u-1');
    expect(entry?.type).toBe('assistant');
    expect(entry?.ts).toBe(Date.parse('2026-07-03T12:00:00.000Z'));
    expect(entry?.isSidechain).toBe(false);
    expect(entry?.isMeta).toBe(false);
    expect(entry?.message?.model).toBe('claude-opus-4-8');
    expect(entry?.message?.content).toHaveLength(3);
  });

  it('parses a user-text line and surfaces promptId', () => {
    const entry = parseTranscriptLine({
      type: 'user',
      uuid: 'u-2',
      timestamp: '2026-07-03T12:00:01.000Z',
      promptId: 'p-9',
      message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
    });
    expect(entry?.promptId).toBe('p-9');
    expect(entry?.message?.content).toEqual([{ type: 'text', text: 'do the thing' }]);
  });

  it('parses a user tool_result line with MCP attribution', () => {
    const entry = parseTranscriptLine({
      type: 'user',
      uuid: 'u-3',
      timestamp: '2026-07-03T12:00:02.000Z',
      attributionMcpServer: 'chrome-devtools',
      attributionMcpTool: 'take_snapshot',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_9', content: 'snap', is_error: false },
        ],
      },
    });
    expect(entry?.attributionMcpServer).toBe('chrome-devtools');
    expect(entry?.attributionMcpTool).toBe('take_snapshot');
    expect(entry?.message?.content).toEqual([
      { type: 'tool_result', toolUseId: 'toolu_9', content: 'snap', isError: false },
    ]);
  });

  it('flags isMeta and isSidechain lines (kept, not dropped)', () => {
    const meta = parseTranscriptLine({
      type: 'user',
      uuid: 'u-meta',
      timestamp: '2026-07-03T12:00:03.000Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>' }] },
    });
    expect(meta?.isMeta).toBe(true);

    const side = parseTranscriptLine({
      type: 'assistant',
      uuid: 'u-side',
      timestamp: '2026-07-03T12:00:04.000Z',
      isSidechain: true,
      message: assistantMessage(),
    });
    expect(side?.isSidechain).toBe(true);
  });

  it('returns null on a missing uuid', () => {
    expect(
      parseTranscriptLine({ type: 'assistant', timestamp: '2026-07-03T12:00:00.000Z' }),
    ).toBeNull();
  });

  it('returns null on a missing type', () => {
    expect(parseTranscriptLine({ uuid: 'u-x' })).toBeNull();
  });

  it('returns null on a non-object line', () => {
    expect(parseTranscriptLine(null)).toBeNull();
    expect(parseTranscriptLine('not-json')).toBeNull();
    expect(parseTranscriptLine(42)).toBeNull();
  });

  it('omits message for a non-message line (system/mode/snapshot)', () => {
    const entry = parseTranscriptLine({
      type: 'file-history-snapshot',
      uuid: 'u-snap',
      timestamp: '2026-07-03T12:00:05.000Z',
    });
    expect(entry?.message).toBeUndefined();
    expect(entry?.type).toBe('file-history-snapshot');
  });

  it('defaults ts to 0 on a garbage timestamp', () => {
    const entry = parseTranscriptLine({ type: 'user', uuid: 'u-z', timestamp: 'not-a-date' });
    expect(entry?.ts).toBe(0);
  });
});
