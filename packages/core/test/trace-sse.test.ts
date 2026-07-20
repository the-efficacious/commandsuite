/**
 * Anthropic SSE reassembler tests.
 *
 * Covers the common streaming patterns we see on the wire:
 *   - text-only assistant response (reassemble content, stop_reason,
 *     and the merged usage from message_start + message_delta)
 *   - tool_use response (input_json_delta fragments → parsed input)
 *   - thinking + text response (two content blocks, correct order)
 *   - truncated stream (no message_delta / message_stop) still
 *     produces a partial message instead of dropping everything
 *   - error event (no message_start) surfaces a minimal envelope
 *   - CRLF-normalized input parses identically to LF input
 *   - `looksLikeSseStream` body-sniff is conservative enough to
 *     not misclassify a plain JSON body.
 */

import { describe, expect, it } from 'vitest';
import { looksLikeSseStream, parseSseEvents, reassembleAnthropicSse } from '../src/trace/sse.js';

function stream(...events: Array<{ event: string; data: unknown }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n`).join('\n');
}

describe('parseSseEvents', () => {
  it('parses event/data pairs separated by blank lines', () => {
    const text = 'event: foo\ndata: {"x":1}\n\nevent: bar\ndata: {"y":2}\n\n';
    const evs = parseSseEvents(text);
    expect(evs.length).toBe(2);
    expect(evs[0]).toEqual({ event: 'foo', data: '{"x":1}', id: null });
    expect(evs[1]).toEqual({ event: 'bar', data: '{"y":2}', id: null });
  });

  it('ignores comment lines starting with colon', () => {
    const text = ': heartbeat\nevent: ping\ndata: {}\n\n';
    const evs = parseSseEvents(text);
    expect(evs.length).toBe(1);
    expect(evs[0]?.event).toBe('ping');
  });

  it('joins multi-line data fields with newlines', () => {
    const text = 'event: foo\ndata: line1\ndata: line2\n\n';
    const evs = parseSseEvents(text);
    expect(evs[0]?.data).toBe('line1\nline2');
  });

  it('normalizes CRLF to LF', () => {
    const text = 'event: foo\r\ndata: {"x":1}\r\n\r\n';
    const evs = parseSseEvents(text);
    expect(evs.length).toBe(1);
    expect(evs[0]?.data).toBe('{"x":1}');
  });

  it('strips one space after the field colon', () => {
    const text = 'event:  double-space\ndata: {"x":1}\n\n';
    const evs = parseSseEvents(text);
    // First space is stripped, leaving the extra space in the value.
    expect(evs[0]?.event).toBe(' double-space');
  });
});

describe('reassembleAnthropicSse', () => {
  it('reassembles a text-only assistant response', () => {
    const body = stream(
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_01',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-4-7',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 5,
              output_tokens: 1,
            },
          },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ' world' },
        },
      },
      {
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: 0 },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 42 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    );

    const result = reassembleAnthropicSse(body);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('msg_01');
    expect(result?.model).toBe('claude-opus-4-7');
    expect(result?.stop_reason).toBe('end_turn');
    expect(result?.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    // Usage must merge input side from message_start with output side
    // from message_delta.
    expect(result?.usage).toEqual({
      input_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 5,
      output_tokens: 42,
    });
  });

  it('reassembles a tool_use response with streamed input JSON', () => {
    const body = stream(
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_02',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-4-7',
            content: [],
            usage: { input_tokens: 20, output_tokens: 1 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_01', name: 'bash', input: {} },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"ls -la"}' },
        },
      },
      {
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: 0 },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 18 },
        },
      },
    );

    const result = reassembleAnthropicSse(body);
    expect(result?.stop_reason).toBe('tool_use');
    expect(result?.content).toEqual([
      { type: 'tool_use', id: 'toolu_01', name: 'bash', input: { command: 'ls -la' } },
    ]);
  });

  it('preserves partial JSON when tool_use input is truncated', () => {
    const body = stream(
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_03',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-4-7',
            content: [],
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_02', name: 'run', input: {} },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"cmd":"echo' },
        },
      },
    );

    const result = reassembleAnthropicSse(body);
    const content = result?.content as Array<Record<string, unknown>>;
    expect(content[0]?.type).toBe('tool_use');
    expect(content[0]?.input).toEqual({ __raw_partial_json: '{"cmd":"echo' });
  });

  it('orders content blocks by index', () => {
    const body = stream(
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_04',
            role: 'assistant',
            model: 'claude-opus-4-7',
            content: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      },
      // Intentionally send block 1 before block 0 in the wire order.
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'second' },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'first' },
        },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 3 },
        },
      },
    );

    const result = reassembleAnthropicSse(body);
    expect(result?.content).toEqual([
      { type: 'thinking', thinking: 'first' },
      { type: 'text', text: 'second' },
    ]);
  });

  it('returns a partial message when the stream is truncated', () => {
    // No message_delta, no message_stop — connection dropped mid-stream.
    const body = stream(
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_05',
            role: 'assistant',
            model: 'claude-opus-4-7',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 7, output_tokens: 1 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial reply' },
        },
      },
    );

    const result = reassembleAnthropicSse(body);
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ type: 'text', text: 'partial reply' }]);
    // No final stop_reason — initial null from message_start is preserved.
    expect(result?.stop_reason).toBeNull();
    // Usage keeps the input side even if output side never finalized.
    expect(result?.usage).toEqual({ input_tokens: 7, output_tokens: 1 });
  });

  it('surfaces an error envelope when only an error event is seen', () => {
    const body = stream({
      event: 'error',
      data: {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      },
    });

    const result = reassembleAnthropicSse(body);
    expect(result).not.toBeNull();
    expect(result?.stop_reason).toBe('error');
    expect(result?.content).toEqual([]);
    expect(result?.usage).toBeNull();
  });

  it('returns null for an empty or non-SSE body', () => {
    expect(reassembleAnthropicSse('')).toBeNull();
    expect(reassembleAnthropicSse('not an sse stream')).toBeNull();
  });
});

describe('looksLikeSseStream', () => {
  it('identifies event:-prefixed streams', () => {
    expect(looksLikeSseStream('event: message_start\ndata: {}\n\n')).toBe(true);
  });

  it('identifies data:-only streams', () => {
    expect(looksLikeSseStream('data: {"type":"ping"}\n\n')).toBe(true);
  });

  it('rejects JSON objects and arrays', () => {
    expect(looksLikeSseStream('{"type":"message"}')).toBe(false);
    expect(looksLikeSseStream('[1,2,3]')).toBe(false);
    expect(looksLikeSseStream('plain text body')).toBe(false);
  });

  it('tolerates leading whitespace', () => {
    expect(looksLikeSseStream('   \nevent: foo\ndata: {}\n\n')).toBe(true);
  });
});
