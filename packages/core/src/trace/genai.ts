/**
 * Anthropic Messages → OpenTelemetry GenAI mapper.
 *
 * A PURE function that turns one Claude `/v1/messages` REQUEST + RESPONSE
 * pair into a single `GenAiInference` record shaped after the OpenTelemetry
 * GenAI semantic conventions (Development). It is the authoritative
 * full-fidelity layer: one record per API call carrying the COMPLETE input
 * context actually sent on the wire (mutations/compaction included), the
 * system prompt kept SEPARATE from the chat history, and the assistant's
 * response.
 *
 * The broker feeds this the parsed Anthropic bodies (resolved from the
 * OTEL `body_ref` files) plus the correlated accounting. This module is
 * intentionally pure — no `node:` imports, no fs, no http — so it lives in
 * `csuite-core` and both the runner capture adapters and the
 * server can import it.
 *
 * Defensive by construction: a content block we don't recognize (or one
 * that throws while mapping) becomes a `generic` part carrying the raw
 * value — we NEVER drop a block. Text, tool arguments, and tool/response
 * content are redacted through `redactJson` before they leave the mapper.
 */

import type { GenAiInference, GenAiMessage, GenAiPart, GenAiUsage } from 'csuite-sdk';
import { asString, parseUsage } from './anthropic.js';
import { redactJson } from './redact.js';

export interface AnthropicToGenAiInput {
  /** Parsed Anthropic Messages REQUEST body (has `system`, `messages`, `model`). */
  requestBody: unknown;
  /** Parsed Anthropic Messages RESPONSE body (has `content`, `stop_reason`, `usage`, `id`). */
  responseBody: unknown;
  /** Override for `gen_ai.request.model`; defaults to `requestBody.model`. */
  model?: string | null;
  /** Override for `gen_ai.response.id`; defaults to `responseBody.id`. */
  responseId?: string | null;
  /**
   * Correlated accounting as a RAW Anthropic usage object (snake_case
   * `input_tokens` / `output_tokens` / `cache_read_input_tokens` /
   * `cache_creation_input_tokens`). Overrides `responseBody.usage`.
   */
  usage?: unknown;
  /**
   * Thread attribution: the Claude Code `query_source` of the call
   * (which interleaved thread of a member's work made it). Sourced from
   * the correlated `api_request` OTEL event, not the request body.
   * Defaults to `null` when absent.
   */
  querySource?: string | null;
  /**
   * The named agent that made the call (for named agents only, e.g.
   * `general-purpose`). Sourced from the `agent.name` attribute on the
   * `api_request` OTEL event. Defaults to `null` when absent.
   */
  agentName?: string | null;
  /** Capture timestamp (epoch ms); defaults to `Date.now()`. */
  ts?: number;
}

/**
 * Map an Anthropic request+response pair to a single `GenAiInference`.
 * Pure and total — never throws on malformed input.
 */
export function anthropicToGenAi(input: AnthropicToGenAiInput): GenAiInference {
  const req = asRecord(input.requestBody);
  const res = asRecord(input.responseBody);

  const model = input.model !== undefined ? input.model : (asString(req?.model) ?? null);
  const responseId =
    input.responseId !== undefined ? input.responseId : (asString(res?.id) ?? null);

  const rawUsage = input.usage !== undefined ? input.usage : res?.usage;
  const usage = toGenAiUsage(rawUsage);

  const stopReason = asString(res?.stop_reason);
  const finishReasons = stopReason ? [stopReason] : [];

  const systemInstructions = mapContent(req?.system);
  const inputMessages = mapMessages(req?.messages);
  const outputMessages = mapOutput(res);

  return {
    operationName: 'chat',
    provider: 'anthropic',
    model,
    responseId,
    finishReasons,
    usage,
    systemInstructions,
    inputMessages,
    outputMessages,
    querySource: input.querySource ?? null,
    agentName: input.agentName ?? null,
    ts: typeof input.ts === 'number' ? input.ts : Date.now(),
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toGenAiUsage(raw: unknown): GenAiUsage | null {
  const parsed = parseUsage(raw);
  if (!parsed) return null;
  return {
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheReadInputTokens: parsed.cacheReadInputTokens,
    cacheCreationInputTokens: parsed.cacheCreationInputTokens,
  };
}

function mapMessages(raw: unknown): GenAiMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(mapMessage);
}

function mapMessage(raw: unknown): GenAiMessage {
  const m = asRecord(raw);
  if (!m) return { role: 'user', parts: [{ type: 'generic', content: redactJson(raw) }] };
  return { role: asString(m.role) ?? 'user', parts: mapContent(m.content) };
}

/**
 * The assistant response → a single `{role:'assistant', parts}` message.
 * Emits nothing when the response body isn't a usable object.
 */
function mapOutput(res: Record<string, unknown> | null): GenAiMessage[] {
  if (!res) return [];
  return [{ role: asString(res.role) ?? 'assistant', parts: mapContent(res.content) }];
}

/**
 * Anthropic `content` is either a plain string, an array of blocks, or
 * absent. Used for both message content and the request `system` prompt.
 */
function mapContent(content: unknown): GenAiPart[] {
  if (typeof content === 'string') return [{ type: 'text', content: redactJson(content) }];
  if (content == null) return [];
  if (!Array.isArray(content)) return [{ type: 'generic', content: redactJson(content) }];
  return content.map(mapBlock);
}

/** Map one Anthropic content block to a typed `GenAiPart`. Never throws. */
function mapBlock(block: unknown): GenAiPart {
  const b = asRecord(block);
  if (!b) return { type: 'generic', content: redactJson(block) };
  try {
    switch (asString(b.type)) {
      case 'text':
        return { type: 'text', content: redactJson(asString(b.text) ?? '') };
      case 'tool_use':
        return {
          type: 'tool_call',
          id: asString(b.id),
          name: asString(b.name),
          arguments: redactJson(b.input ?? null),
        };
      case 'tool_result':
        return {
          type: 'tool_call_response',
          id: asString(b.tool_use_id),
          response: redactJson(b.content ?? null),
          is_error: b.is_error === true,
        };
      case 'thinking':
        return {
          type: 'reasoning',
          content: redactJson(asString(b.thinking) ?? asString(b.text) ?? ''),
        };
      case 'image':
        return mapImage(b);
      default:
        // redacted_thinking and any unknown/future block: keep raw, never drop.
        return { type: 'generic', content: redactJson(b) };
    }
  } catch {
    return { type: 'generic', content: redactJson(b) };
  }
}

/**
 * Anthropic image blocks carry a `source`:
 *   { type:'base64', media_type, data } → blob
 *   { type:'url', url }                 → file (reference)
 *   { type:'file', file_id }            → file (reference)
 */
function mapImage(b: Record<string, unknown>): GenAiPart {
  const s = asRecord(b.source);
  if (!s) return { type: 'generic', content: redactJson(b) };
  const mime = asString(s.media_type);
  switch (asString(s.type)) {
    case 'url':
      return { type: 'file', mime_type: mime, uri: asString(s.url) };
    case 'file':
      return { type: 'file', mime_type: mime, uri: asString(s.file_id) };
    default:
      return { type: 'blob', mime_type: mime, data: asString(s.data) };
  }
}
