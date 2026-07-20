/**
 * Anthropic message-shape parsers.
 *
 * The structured shapes we care about for a Claude turn:
 *
 *   - model, stop_reason
 *   - content blocks (text, tool_use, tool_result, image, thinking)
 *   - usage (input_tokens, output_tokens, cache_creation_input_tokens,
 *     cache_read_input_tokens)
 *
 * These parsers are fed by the transcript reader (see `transcript.ts`),
 * which reuses `parseContent`/`parseUsage`/`asString` to turn a parsed
 * Claude Code session line into an `AnthropicMessage`. The former
 * HTTP-exchange extractor (OTEL export + broker OTLP ingest) is gone —
 * the transcript JSONL is now the source of truth — so this module no
 * longer knows anything about HTTP requests/responses.
 *
 * Everything is defensive about schema: real Anthropic payloads can
 * mutate model names, add fields we don't know about, stream responses
 * in chunks. We treat unknown structures as "raw json" rather than
 * throwing; the worst case is a less-detailed summary in the UI, not
 * a crashed upload.
 *
 * This module is intentionally pure — no `node:` imports, no fs, no
 * http — so it lives in `csuite-core` and both the cli
 * capture adapters and the server can import it.
 */

// The Anthropic message shapes are declared once, in the SDK's pure-types
// module, and re-exported here so both the CLI capture adapters and the
// server keep importing them from `csuite-core` without reaching
// into the SDK. A single declaration is what stops the two copies from
// drifting — they previously diverged only on `AnthropicMessage.role`.
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesEntry,
  AnthropicTool,
  AnthropicUsage,
} from 'csuite-sdk/types';

export type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesEntry,
  AnthropicTool,
  AnthropicUsage,
};

export function parseContent(raw: unknown): AnthropicContentBlock[] {
  // Anthropic allows either a plain string or an array of blocks.
  if (typeof raw === 'string') return [{ type: 'text', text: raw }];
  if (!Array.isArray(raw)) return [];
  const out: AnthropicContentBlock[] = [];
  for (const block of raw) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const t = typeof b.type === 'string' ? b.type : 'unknown';
    if (t === 'text') {
      out.push({ type: 'text', text: asString(b.text) ?? '' });
    } else if (t === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: asString(b.id) ?? '',
        name: asString(b.name) ?? '',
        input: b.input ?? null,
      });
    } else if (t === 'tool_result') {
      out.push({
        type: 'tool_result',
        toolUseId: asString(b.tool_use_id) ?? '',
        content: b.content ?? null,
        isError: b.is_error === true,
      });
    } else if (t === 'image') {
      const source = (b.source ?? null) as Record<string, unknown> | null;
      out.push({
        type: 'image',
        mediaType: source ? (asString(source.media_type) ?? null) : null,
      });
    } else if (t === 'thinking') {
      out.push({ type: 'thinking', text: asString(b.thinking) ?? asString(b.text) ?? '' });
    } else {
      out.push({ type: 'unknown', raw: b });
    }
  }
  return out;
}

export function parseUsage(raw: unknown): AnthropicUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  return {
    inputTokens: asNumber(u.input_tokens),
    outputTokens: asNumber(u.output_tokens),
    cacheCreationInputTokens: asNumber(u.cache_creation_input_tokens),
    cacheReadInputTokens: asNumber(u.cache_read_input_tokens),
  };
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
