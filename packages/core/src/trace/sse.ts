/**
 * Anthropic SSE stream reassembler.
 *
 * The `/v1/messages` endpoint can stream responses as Server-Sent
 * Events (`Accept: text/event-stream`, `stream: true` in the request
 * body). On the wire this is a sequence of `event: X / data: {...}`
 * records terminated by blank lines — NOT a single JSON object.
 *
 * The caller hands us the complete SSE body as text — now sourced from
 * Claude Code's OTEL `api_response_body` export (which carries the raw
 * streamed body) rather than a network capture.
 * `buildAnthropicEntry` in `anthropic.ts` expects `response.body` to
 * be the same JSON object shape the non-streaming endpoint returns.
 * This module bridges those two realities: walk the SSE events and
 * produce a synthetic message object that `buildAnthropicEntry` can
 * read without caring how the bytes arrived.
 *
 * Event handling (from the Anthropic streaming spec):
 *   - `message_start`     → seeds the result with id/model/role/usage
 *                           (input_tokens, cache_creation_input_tokens,
 *                           cache_read_input_tokens).
 *   - `content_block_start` / `content_block_delta` / `content_block_stop`
 *                         → reassemble content[index], accumulating
 *                           text_delta / input_json_delta / thinking_delta.
 *   - `message_delta`     → final `stop_reason`, `stop_sequence`,
 *                           `usage.output_tokens`.
 *   - `message_stop`      → end marker (no data of interest).
 *   - `ping` / unknown    → ignored.
 *   - `error`             → surfaced as `usage=null, stop_reason="error"`
 *                           so downstream renderers can flag it.
 *
 * Truncation: a stream that ends before `message_stop` (session
 * closed, connection dropped) still produces a partial message —
 * whatever content blocks were built so far, with no final
 * stop_reason / final output_tokens. Better than returning null and
 * losing everything.
 */

export interface SseEvent {
  readonly event: string | null;
  readonly data: string | null;
  readonly id: string | null;
}

/**
 * Parse a full SSE body into discrete events. Events are separated
 * by blank lines; multi-line `data:` fields are joined with `\n` per
 * the spec. CRLF is normalized to LF first. Lines starting with `:`
 * are comments and skipped.
 */
export function parseSseEvents(text: string): SseEvent[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split('\n\n');
  const events: SseEvent[] = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event: string | null = null;
    let id: string | null = null;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const field = line.slice(0, colon);
      let value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
      else if (field === 'id') id = value;
    }
    const data = dataLines.length > 0 ? dataLines.join('\n') : null;
    events.push({ event, data, id });
  }
  return events;
}

interface BlockBuilder {
  type: string;
  id?: string;
  name?: string;
  text?: string;
  thinking?: string;
  /** Accumulated `partial_json` fragments for tool_use blocks. */
  inputJson?: string;
}

/**
 * Reassemble an Anthropic SSE stream body into a synthetic message
 * object matching the non-streaming response shape.
 *
 * Returns `null` if the text isn't parseable as SSE or contains no
 * `message_start` (nothing to assemble against).
 */
export function reassembleAnthropicSse(text: string): Record<string, unknown> | null {
  const events = parseSseEvents(text);
  if (events.length === 0) return null;

  let message: Record<string, unknown> | null = null;
  const blocks = new Map<number, BlockBuilder>();
  let finalStopReason: string | null = null;
  let finalStopSequence: string | null = null;
  const deltaUsage: Record<string, unknown> = {};
  let sawError = false;

  for (const ev of events) {
    if (ev.data === null) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = typeof payload.type === 'string' ? payload.type : ev.event;

    switch (kind) {
      case 'message_start': {
        const msg = payload.message;
        if (msg && typeof msg === 'object') {
          // Clone so our later mutations don't touch the caller's data.
          message = { ...(msg as Record<string, unknown>) };
        }
        break;
      }
      case 'content_block_start': {
        const index = payload.index;
        const block = payload.content_block;
        if (typeof index === 'number' && block && typeof block === 'object') {
          blocks.set(index, builderFromStart(block as Record<string, unknown>));
        }
        break;
      }
      case 'content_block_delta': {
        const index = payload.index;
        const delta = payload.delta;
        if (typeof index === 'number' && delta && typeof delta === 'object') {
          const b = blocks.get(index);
          if (b) applyDelta(b, delta as Record<string, unknown>);
        }
        break;
      }
      case 'content_block_stop':
        // Finalization is lazy — `builderToBlock` parses accumulated
        // JSON on output. Nothing to do here.
        break;
      case 'message_delta': {
        const delta = payload.delta;
        if (delta && typeof delta === 'object') {
          const d = delta as Record<string, unknown>;
          if (typeof d.stop_reason === 'string') finalStopReason = d.stop_reason;
          if (typeof d.stop_sequence === 'string' || d.stop_sequence === null) {
            finalStopSequence = (d.stop_sequence as string | null) ?? null;
          }
        }
        const usage = payload.usage;
        if (usage && typeof usage === 'object') {
          for (const [k, v] of Object.entries(usage as Record<string, unknown>)) {
            deltaUsage[k] = v;
          }
        }
        break;
      }
      case 'error':
        sawError = true;
        break;
      default:
        // ping, message_stop, unknown — no accumulation.
        break;
    }
  }

  if (!message) {
    // No message_start received. If we saw an error event, surface a
    // minimal envelope so the downstream parser doesn't treat this
    // as a successful-but-empty exchange.
    if (sawError) {
      return {
        type: 'message',
        role: 'assistant',
        content: [],
        stop_reason: 'error',
        stop_sequence: null,
        usage: null,
      };
    }
    return null;
  }

  // Assemble content in index order. Missing indices (e.g. dropped
  // start event) are skipped; we don't fabricate empty blocks.
  const orderedIndices = [...blocks.keys()].sort((a, b) => a - b);
  message.content = orderedIndices.map((i) => builderToBlock(blocks.get(i) as BlockBuilder));

  // Merge usage: message_start.usage is the input-side base;
  // message_delta.usage adds/overrides (notably output_tokens, and
  // sometimes cache_* on newer API versions).
  const startUsage = (message.usage ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...startUsage };
  for (const [k, v] of Object.entries(deltaUsage)) {
    merged[k] = v;
  }
  message.usage = Object.keys(merged).length > 0 ? merged : null;

  if (finalStopReason !== null) message.stop_reason = finalStopReason;
  if (finalStopSequence !== null) message.stop_sequence = finalStopSequence;

  return message;
}

function builderFromStart(block: Record<string, unknown>): BlockBuilder {
  const type = typeof block.type === 'string' ? block.type : 'unknown';
  const b: BlockBuilder = { type };
  if (type === 'text') {
    b.text = typeof block.text === 'string' ? block.text : '';
  } else if (type === 'tool_use') {
    if (typeof block.id === 'string') b.id = block.id;
    if (typeof block.name === 'string') b.name = block.name;
    b.inputJson = '';
  } else if (type === 'thinking') {
    b.thinking = typeof block.thinking === 'string' ? block.thinking : '';
  }
  return b;
}

function applyDelta(b: BlockBuilder, delta: Record<string, unknown>): void {
  const dtype = delta.type;
  if (dtype === 'text_delta' && typeof delta.text === 'string') {
    b.text = (b.text ?? '') + delta.text;
  } else if (dtype === 'input_json_delta' && typeof delta.partial_json === 'string') {
    b.inputJson = (b.inputJson ?? '') + delta.partial_json;
  } else if (dtype === 'thinking_delta' && typeof delta.thinking === 'string') {
    b.thinking = (b.thinking ?? '') + delta.thinking;
  }
  // signature_delta and other auxiliary deltas are ignored — they
  // don't contribute to the final rendered content shape.
}

function builderToBlock(b: BlockBuilder): Record<string, unknown> {
  if (b.type === 'text') {
    return { type: 'text', text: b.text ?? '' };
  }
  if (b.type === 'tool_use') {
    let input: unknown = {};
    if (b.inputJson && b.inputJson.length > 0) {
      try {
        input = JSON.parse(b.inputJson);
      } catch {
        // Tool-use input arrived truncated or mid-object. Keep the
        // raw string so the UI can still show something useful.
        input = { __raw_partial_json: b.inputJson };
      }
    }
    return {
      type: 'tool_use',
      id: b.id ?? '',
      name: b.name ?? '',
      input,
    };
  }
  if (b.type === 'thinking') {
    return { type: 'thinking', thinking: b.thinking ?? '' };
  }
  return { type: b.type };
}

/**
 * Cheap body-sniff: does this look like an SSE stream? Used to
 * decide whether to call `reassembleAnthropicSse` or treat the body
 * as opaque text. Non-SSE bodies always start with `{`, `[`, or
 * whitespace; SSE bodies start with `event:` or `data:`.
 */
export function looksLikeSseStream(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('event:') || trimmed.startsWith('data:');
}
