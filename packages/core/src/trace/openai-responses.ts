/**
 * OpenAI Responses API → OpenTelemetry GenAI mapper (codex).
 *
 * A PURE function that turns one codex inference — the `response.create`
 * REQUEST body plus the completed RESPONSE — into a single `GenAiInference`
 * record, the SAME shape `anthropicToGenAi` produces for Claude. codex
 * talks to OpenAI models via the Responses API; the two bodies come from a
 * codex rollout-TRACE bundle (`inference_started.request_payload` +
 * `inference_completed.response_payload`, resolved from `payloads/*.json`),
 * which pre-pairs request and response per call — so, unlike the Claude
 * OTEL path, there is no correlation to do here.
 *
 * The record is the codex full-fidelity layer: the COMPLETE input context
 * as actually sent (instructions kept SEPARATE from the chat history, the
 * whole `input` array including tool calls/outputs and reasoning), plus the
 * assistant's output items and usage.
 *
 * Pure — no `node:` imports, no fs/http — so it lives in `csuite-core`
 * alongside `anthropicToGenAi` and both the runner and the server import it.
 *
 * Defensive by construction: an item/content shape we don't recognize (or
 * one that throws) becomes a `generic` part carrying the raw value — we
 * NEVER drop an item. Text, tool arguments, and tool/response content are
 * redacted through `redactJson` before they leave the mapper.
 *
 * Shapes (codex 0.130.0):
 *   REQUEST  { type:'response.create', model, instructions, input:[…],
 *              tools, reasoning, … }
 *     input item: { type:'message', role, content:[{type:'input_text'|
 *       'output_text', text}] } | { type:'function_call', name, call_id,
 *       arguments:<json string> } | { type:'function_call_output', call_id,
 *       output } | { type:'reasoning', summary:[…], encrypted_content }
 *   RESPONSE { response_id, upstream_request_id,
 *              token_usage:{input_tokens, cached_input_tokens,
 *              output_tokens, reasoning_output_tokens, total_tokens},
 *              output_items:[…same item shapes…] }
 */

import type { GenAiInference, GenAiMessage, GenAiPart, GenAiUsage } from 'csuite-sdk';
import { asString } from './anthropic.js';
import { redactJson } from './redact.js';

export interface OpenAiResponsesToGenAiInput {
  /** Parsed Responses API `response.create` REQUEST body. */
  requestBody: unknown;
  /** Parsed codex RESPONSE payload (`response_id`, `token_usage`, `output_items`). */
  responseBody: unknown;
  /** Override for `gen_ai.request.model`; defaults to `requestBody.model`. */
  model?: string | null;
  /** Override for `gen_ai.response.id`; defaults to `responseBody.response_id`. */
  responseId?: string | null;
  /** Override for usage; defaults to `responseBody.token_usage`. */
  usage?: unknown;
  /**
   * Thread attribution — which thread of the codex session made the call
   * (e.g. the root thread vs. a spawned subagent thread). Defaults to null.
   */
  querySource?: string | null;
  /** Named subagent that made the call, when known. Defaults to null. */
  agentName?: string | null;
  /** Capture timestamp (epoch ms); defaults to `Date.now()`. */
  ts?: number;
}

/**
 * Map a codex Responses request+response pair to a single `GenAiInference`.
 * Pure and total — never throws on malformed input.
 */
export function openaiResponsesToGenAi(input: OpenAiResponsesToGenAiInput): GenAiInference {
  const req = asRecord(input.requestBody);
  const res = asRecord(input.responseBody);

  const model = input.model !== undefined ? input.model : (asString(req?.model) ?? null);
  const responseId =
    input.responseId !== undefined ? input.responseId : (asString(res?.response_id) ?? null);

  const rawUsage = input.usage !== undefined ? input.usage : res?.token_usage;
  const usage = toGenAiUsage(rawUsage);

  const outputItems = Array.isArray(res?.output_items) ? res.output_items : [];
  const finishReasons = deriveFinishReasons(outputItems);

  const systemInstructions = mapInstructions(req?.instructions);
  const inputMessages = mapItems(req?.input);
  const outputMessages = mapItems(outputItems);

  return {
    operationName: 'chat',
    provider: 'openai',
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

/**
 * OpenAI usage → the Anthropic-shaped `GenAiUsage` the record carries
 * (snake_case source):
 *   inputTokens              <- input_tokens
 *   cacheReadInputTokens     <- cached_input_tokens
 *   outputTokens             <- output_tokens  (includes reasoning per OpenAI)
 *   cacheCreationInputTokens <- null           (no cache-write count)
 */
function toGenAiUsage(raw: unknown): GenAiUsage | null {
  const u = asRecord(raw);
  if (!u) return null;
  const input = numOrNull(u.input_tokens);
  const cached = numOrNull(u.cached_input_tokens);
  const output = numOrNull(u.output_tokens);
  if (input === null && cached === null && output === null) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: null,
  };
}

/**
 * OpenAI Responses has no single stop-reason field on the completed
 * payload; derive one from the output items so the record still carries a
 * finish signal: a tool call → `tool_calls`, otherwise a message → `stop`.
 */
function deriveFinishReasons(outputItems: unknown[]): string[] {
  let sawMessage = false;
  for (const it of outputItems) {
    const t = asString(asRecord(it)?.type);
    if (t === 'function_call') return ['tool_calls'];
    if (t === 'message') sawMessage = true;
  }
  return sawMessage ? ['stop'] : [];
}

/** The `instructions` string → the system-instructions parts. */
function mapInstructions(instructions: unknown): GenAiPart[] {
  if (typeof instructions === 'string') {
    return instructions.length > 0 ? [{ type: 'text', content: redactJson(instructions) }] : [];
  }
  if (instructions == null) return [];
  return [{ type: 'generic', content: redactJson(instructions) }];
}

/** Map a Responses `input` / `output_items` array to one message per item. */
function mapItems(raw: unknown): GenAiMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(mapItem);
}

/**
 * Map one Responses item to a `GenAiMessage`. Unlike Anthropic (blocks
 * inside a message), Responses items are top-level, so each becomes its own
 * single-role message. Never throws.
 */
function mapItem(raw: unknown): GenAiMessage {
  const it = asRecord(raw);
  if (!it) return { role: 'user', parts: [{ type: 'generic', content: redactJson(raw) }] };
  try {
    switch (asString(it.type)) {
      case 'message':
        return { role: asString(it.role) ?? 'user', parts: mapContent(it.content) };
      case 'function_call':
        return {
          role: 'assistant',
          parts: [
            {
              type: 'tool_call',
              id: asString(it.call_id) ?? asString(it.id),
              name: asString(it.name),
              arguments: redactJson(parseMaybeJson(it.arguments)),
            },
          ],
        };
      case 'function_call_output':
        return {
          role: 'tool',
          parts: [
            {
              type: 'tool_call_response',
              id: asString(it.call_id) ?? asString(it.id),
              response: redactJson(it.output ?? null),
              is_error: false,
            },
          ],
        };
      case 'reasoning':
        return { role: 'assistant', parts: [mapReasoning(it)] };
      default:
        // custom_tool_call, web_search_call, a future item type — keep raw.
        return {
          role: asString(it.role) ?? 'assistant',
          parts: [{ type: 'generic', content: redactJson(it) }],
        };
    }
  } catch {
    return { role: 'user', parts: [{ type: 'generic', content: redactJson(it) }] };
  }
}

/**
 * Responses message `content` is an array of typed parts
 * (`input_text` / `output_text` / `input_image` / …). Map each; unknown
 * shapes become `generic`, never dropped.
 */
function mapContent(content: unknown): GenAiPart[] {
  if (typeof content === 'string') return [{ type: 'text', content: redactJson(content) }];
  if (content == null) return [];
  if (!Array.isArray(content)) return [{ type: 'generic', content: redactJson(content) }];
  return content.map(mapContentPart);
}

function mapContentPart(part: unknown): GenAiPart {
  const p = asRecord(part);
  if (!p) return { type: 'generic', content: redactJson(part) };
  switch (asString(p.type)) {
    case 'input_text':
    case 'output_text':
    case 'text':
      return { type: 'text', content: redactJson(asString(p.text) ?? '') };
    case 'input_image':
    case 'output_image':
    case 'image':
      // Reference form (image_url) vs inline; keep the reference as a file.
      return { type: 'file', mime_type: null, uri: asString(p.image_url) ?? asString(p.file_id) };
    default:
      return { type: 'generic', content: redactJson(p) };
  }
}

/**
 * A `reasoning` item → a reasoning part. codex carries `summary` (an array
 * of `{type:'summary_text', text}` or plain strings) as the visible
 * reasoning; the raw chain-of-thought is in `encrypted_content` (opaque,
 * not decoded). Prefer the summary text.
 */
function mapReasoning(it: Record<string, unknown>): GenAiPart {
  const summary = it.summary;
  const parts: string[] = [];
  if (Array.isArray(summary)) {
    for (const s of summary) {
      if (typeof s === 'string') {
        if (s.length > 0) parts.push(s);
      } else {
        const t = asString(asRecord(s)?.text);
        if (t !== null && t.length > 0) parts.push(t);
      }
    }
  } else if (typeof summary === 'string' && summary.length > 0) {
    parts.push(summary);
  }
  return { type: 'reasoning', content: redactJson(parts.join('\n')) };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parse a function_call `arguments` JSON string, tolerating a non-string. */
function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
