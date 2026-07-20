/**
 * Pure structuring of a codex rollout JSONL stream into `ActivityEvent`s.
 *
 * The rollout (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`) is
 * codex's own durable, untruncated transcript of a thread — the codex
 * analogue of the Claude Code session JSONL. This parser is the
 * ROLLOUT-PRIMARY content source: it replaces the app-server item stream
 * as the origin of `llm_exchange` / `tool_action` / `user_prompt`, the
 * same way the Claude runner went transcript-primary and left its hooks
 * presence-only. The app-server stream keeps driving presence/busy and
 * the operator's stderr view; content comes from here.
 *
 * Why the rollout over the live item stream: it carries the COMPLETE turn
 * — full tool input AND output (paired by `call_id`, so tool results fold
 * into their call), the real per-turn token breakdown, the clean user
 * opener (without the injected `<environment_context>` / developer
 * preamble that pollutes the raw response items), and reasoning summaries
 * — and it's durable, so a dropped notification can't lose content.
 *
 * Shape of the stream (confirmed against codex 0.130.0). Each line is
 * `{ timestamp, type, payload }`:
 *   - `session_meta`   — header: id, cwd, model_provider, base_instructions.
 *   - `event_msg`      — a typed event; the ones we consume:
 *       · `task_started`  { turn_id, started_at (unix SECONDS), ... } — turn open
 *       · `user_message`  { message } — the clean turn opener → user_prompt
 *       · `agent_message` { message, phase } — assistant prose → llm_exchange
 *       · `token_count`   { info: { last_token_usage, total_token_usage } | null }
 *       · `task_complete` { turn_id, duration_ms, completed_at } — turn close
 *   - `turn_context`   — { turn_id, model, ... } — the turn's model.
 *   - `response_item`  — a raw Responses-API item:
 *       · `function_call`        { name, call_id, arguments (JSON string) } — tool call
 *       · `function_call_output` { call_id, output (string) } — tool result
 *       · `reasoning`            { summary: string[], encrypted_content } — thinking
 *       (assistant/user `message` response_items are IGNORED — their clean
 *        `event_msg` forms are used instead, to avoid double-capture.)
 *
 * Turn model: codex runs one turn at a time. `task_started` opens the
 * current turn, everything until `task_complete` belongs to it, and the
 * close flushes one `llm_exchange`. `flush()` emits an unfinished turn
 * (rollout truncated at teardown) so its content isn't lost.
 *
 * Everything text-bearing is redacted with the core `redactJson` before
 * it leaves the runner, matching the Claude transcript reader.
 *
 * Never throws: an unparseable line or an unexpected shape produces
 * nothing rather than propagating.
 */

import type { AnthropicContentBlock, AnthropicMessagesEntry, AnthropicUsage } from 'csuite-core';
import { redactJson } from 'csuite-core';
import type { ActivityEvent } from 'csuite-sdk/types';

export interface RolloutParserOptions {
  /** Push a normalized activity event into the capture sink. */
  enqueue: (event: ActivityEvent) => void;
  /**
   * Thread attribution stamped onto every emitted event —
   * `codex_main_thread` or `codex_subagent:<id8>`. One parser instance
   * tails one rollout file (one thread), so this is fixed per parser.
   * Optional: when omitted (standalone parsing/tests) events carry no
   * `querySource` and it's simply absent from the JSON.
   */
  querySource?: string;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface RolloutParser {
  /** Structure one rollout JSONL line and emit any resulting events. */
  handleLine(line: string): void;
  /**
   * Flush a turn whose `task_complete` never arrived (rollout truncated
   * at teardown) so its assistant text + reasoning still produce an
   * exchange. Idempotent.
   */
  flush(): void;
}

interface TurnAccum {
  turnId: string | null;
  /** Unix ms the turn started — from `task_started.started_at`, else receipt time. */
  startedAtMs: number;
  /** Unix ms of the last record seen in the turn — the fallback end bound. */
  lastTsMs: number;
  /** Unix ms the turn completed — from `task_complete.completed_at`. */
  endedAtMs: number | null;
  /** Turn wall-clock ms — from `task_complete.duration_ms`. */
  durationMs: number | null;
  /** Model for the turn — from `turn_context.model`. */
  model: string | null;
  assistantTexts: string[];
  reasoningBlocks: string[];
  /** Latest per-turn usage — from `token_count.info.last_token_usage`. */
  usage: RolloutUsage | null;
}

interface RolloutUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

export function createRolloutParser(options: RolloutParserOptions): RolloutParser {
  const { enqueue, querySource } = options;
  const log = options.log ?? (() => {});

  // The turn currently open (task_started → task_complete). Codex is
  // strictly sequential, so a single pointer suffices — there is never
  // more than one turn in flight.
  let current: TurnAccum | null = null;
  // Pending tool calls awaiting their function_call_output, keyed by
  // call_id. A call and its output are separate rollout lines.
  const pendingToolCalls = new Map<string, { name: string; input: unknown }>();

  function openTurn(turnId: string | null, startedAtMs: number): void {
    // A new task_started while a turn is open means the prior turn never
    // got its task_complete — flush it before opening the next.
    if (current) flushTurn(current);
    current = {
      turnId,
      startedAtMs,
      lastTsMs: startedAtMs,
      endedAtMs: null,
      durationMs: null,
      model: null,
      assistantTexts: [],
      reasoningBlocks: [],
      usage: null,
    };
  }

  function flushTurn(accum: TurnAccum): void {
    // Nothing worth an exchange — a turn with no assistant prose, no
    // reasoning, and no usage (e.g. a pure tool turn) produces no shell.
    if (
      accum.assistantTexts.length === 0 &&
      accum.reasoningBlocks.length === 0 &&
      accum.usage === null
    ) {
      return;
    }
    const startedAt = accum.startedAtMs;
    const endedAt = accum.endedAtMs ?? accum.lastTsMs;

    const content: AnthropicContentBlock[] = [];
    for (const r of accum.reasoningBlocks) {
      content.push({ type: 'thinking', text: redactJson(r) });
    }
    for (const t of accum.assistantTexts) {
      content.push({ type: 'text', text: redactJson(t) });
    }

    const entry: AnthropicMessagesEntry = {
      kind: 'anthropic_messages',
      startedAt,
      endedAt,
      request: {
        model: accum.model ?? 'codex',
        maxTokens: null,
        temperature: null,
        system: null,
        // The rollout carries the running conversation, but we keep the
        // turn SEQUENCE as the history (matching the Claude transcript
        // reader) rather than restuffing prior turns into every request.
        messages: [],
        tools: null,
      },
      response: {
        // The rollout doesn't record a stop reason on the turn; a
        // completed turn is end_turn, and a drained one is left null.
        stopReason: accum.endedAtMs !== null ? 'end_turn' : null,
        stopSequence: null,
        messages: [{ role: 'assistant', content }],
        usage: mapUsage(accum.usage),
        status: null,
        // No responseId: a codex exchange aggregates a whole TURN
        // (possibly several Responses API calls), so there is no
        // single API response id to carry — trace enrichment joins
        // codex rows by interval containment instead (each call's ts
        // falls inside this turn's [startedAt, endedAt] window, gated
        // by querySource class).
        responseId: null,
      },
    };

    enqueue({
      kind: 'llm_exchange',
      ts: startedAt,
      duration: accum.durationMs ?? Math.max(0, endedAt - startedAt),
      agent: 'codex',
      querySource,
      entry,
    });
    log('codex-rollout: emitted llm_exchange', {
      turnId: accum.turnId,
      textBlocks: accum.assistantTexts.length,
      reasoningBlocks: accum.reasoningBlocks.length,
    });
  }

  function handleEventMsg(payload: Record<string, unknown>, tsMs: number): void {
    const type = strField(payload, 'type');
    switch (type) {
      case 'task_started': {
        openTurn(strField(payload, 'turn_id'), secondsToMs(payload.started_at) ?? tsMs);
        return;
      }
      case 'task_complete': {
        if (!current) return;
        current.endedAtMs = secondsToMs(payload.completed_at) ?? current.lastTsMs;
        current.durationMs = numField(payload, 'duration_ms');
        flushTurn(current);
        current = null;
        return;
      }
      case 'user_message': {
        const text = strField(payload, 'message');
        if (text === null || text.length === 0) return;
        enqueue({
          kind: 'user_prompt',
          ts: tsMs,
          text: redactJson(text),
          agent: 'codex',
          querySource,
        });
        return;
      }
      case 'agent_message': {
        const text = strField(payload, 'message');
        if (text !== null && text.length > 0 && current) current.assistantTexts.push(text);
        return;
      }
      case 'token_count': {
        if (!current) return;
        const usage = readTokenUsage(payload.info);
        if (usage !== null) current.usage = usage;
        return;
      }
      default:
        // Other event_msg types (e.g. rate-limit-only updates, deltas)
        // carry no content for the activity stream.
        return;
    }
  }

  function handleResponseItem(payload: Record<string, unknown>, tsMs: number): void {
    const type = strField(payload, 'type');
    switch (type) {
      case 'function_call': {
        const callId = strField(payload, 'call_id');
        if (callId === null) return;
        pendingToolCalls.set(callId, {
          name: strField(payload, 'name') ?? 'tool',
          input: parseArguments(payload.arguments),
        });
        return;
      }
      case 'function_call_output': {
        const callId = strField(payload, 'call_id');
        if (callId === null) return;
        const call = pendingToolCalls.get(callId);
        pendingToolCalls.delete(callId);
        const output = payload.output;
        const outputText = typeof output === 'string' ? output : (output ?? null);
        enqueue({
          kind: 'tool_action',
          ts: tsMs,
          agent: 'codex',
          querySource,
          source: 'codex_rollout',
          toolName: call?.name ?? 'tool',
          input: call ? redactJson(call.input) : null,
          result: redactJson(outputText),
          isError: detectExecError(outputText),
          // codex DOES expose a tool id (the Responses API call_id), so the
          // web can fold this result into its call.
          toolUseId: callId,
        });
        return;
      }
      case 'reasoning': {
        const reasoning = extractReasoning(payload);
        if (reasoning !== null && reasoning.length > 0 && current) {
          current.reasoningBlocks.push(reasoning);
        }
        return;
      }
      default:
        // `message` response items (assistant/user) are intentionally
        // ignored — their clean `event_msg` forms (agent_message /
        // user_message) are the source of truth, so consuming both would
        // double-capture. Unknown item types are absorbed silently.
        return;
    }
  }

  return {
    handleLine(line: string): void {
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch (err) {
        log('codex-rollout: skipping unparseable line', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (!rec || typeof rec !== 'object') return;
      const record = rec as Record<string, unknown>;
      const tsMs = parseIsoMs(record.timestamp) ?? Date.now();
      // turn_context carries the turn's model; capture it onto the open turn.
      const type = strField(record, 'type');
      const payload = asObj(record.payload);
      if (payload === null) return;
      if (type === 'turn_context') {
        if (current) current.model = strField(payload, 'model') ?? current.model;
        return;
      }
      if (current) current.lastTsMs = tsMs;
      if (type === 'event_msg') {
        handleEventMsg(payload, tsMs);
      } else if (type === 'response_item') {
        handleResponseItem(payload, tsMs);
      }
      // session_meta and any other line type carry no activity event.
    },
    flush(): void {
      if (!current) return;
      flushTurn(current);
      current = null;
    },
  };
}

// ── Token mapping ───────────────────────────────────────────────────

/**
 * Map the rollout's snake_case token breakdown onto the Anthropic usage
 * shape the activity model carries. Note the rollout is snake_case where
 * the app-server stream is camelCase:
 *
 *   inputTokens              <- input_tokens
 *   cacheReadInputTokens     <- cached_input_tokens
 *   outputTokens             <- output_tokens        (includes reasoning per OpenAI)
 *   cacheCreationInputTokens <- null                 (codex has no cache-write count)
 *
 * `reasoning_output_tokens` / `total_tokens` / `model_context_window` are
 * not representable here — they belong to the operational telemetry layer.
 */
function mapUsage(usage: RolloutUsage | null): AnthropicUsage | null {
  if (usage === null) return null;
  if (
    usage.inputTokens === null &&
    usage.cachedInputTokens === null &&
    usage.outputTokens === null
  ) {
    return null;
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: usage.cachedInputTokens,
  };
}

/**
 * Read a `RolloutUsage` from a `token_count` payload's `info`. `info` is
 * null on rate-limit-only updates. Prefer `last_token_usage` (this turn's
 * request) over `total_token_usage` (thread cumulative). Returns null when
 * nothing numeric is present.
 */
function readTokenUsage(info: unknown): RolloutUsage | null {
  const obj = asObj(info);
  if (obj === null) return null;
  const src = asObj(obj.last_token_usage) ?? asObj(obj.total_token_usage) ?? obj;
  const input = numField(src, 'input_tokens');
  const cached = numField(src, 'cached_input_tokens');
  const output = numField(src, 'output_tokens');
  if (input === null && cached === null && output === null) return null;
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output };
}

// ── Reasoning + tool helpers ────────────────────────────────────────

/**
 * Pull reasoning prose from a `reasoning` response item. The 0.130.0
 * shape carries `summary: string[]` (user-visible summarized reasoning);
 * `content: string[]` holds raw reasoning only for models that emit it
 * (OpenAI-hosted models encrypt it into `encrypted_content`, which is
 * opaque and not captured). Prefer summary, fall back to content.
 */
function extractReasoning(payload: Record<string, unknown>): string | null {
  const fromArray = (v: unknown): string | null => {
    if (typeof v === 'string') return v.length > 0 ? v : null;
    if (Array.isArray(v)) {
      const parts: string[] = [];
      for (const block of v) {
        if (typeof block === 'string') {
          if (block.length > 0) parts.push(block);
        } else {
          const t = strField(block, 'text');
          if (t !== null && t.length > 0) parts.push(t);
        }
      }
      if (parts.length > 0) return parts.join('\n');
    }
    return null;
  };
  return fromArray(payload.summary) ?? fromArray(payload.content);
}

/** Parse a function_call `arguments` JSON string, tolerating a non-string. */
function parseArguments(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? null;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/**
 * Best-effort error detection for an exec tool's output text. Codex
 * formats exec output with a `Process exited with code N` line; a nonzero
 * code marks an error. Non-exec tools have no reliable signal in the
 * rollout output string, so they report undefined (unknown) rather than a
 * misleading false.
 */
function detectExecError(output: unknown): boolean | undefined {
  if (typeof output !== 'string') return undefined;
  const m = /exited with code (\d+)/i.exec(output);
  if (!m) return undefined;
  return Number(m[1]) !== 0;
}

// ── Defensive field helpers ─────────────────────────────────────────

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function strField(o: unknown, k: string): string | null {
  if (o && typeof o === 'object' && k in o) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === 'string') return v;
  }
  return null;
}

function numField(o: unknown, k: string): number | null {
  if (o && typeof o === 'object' && k in o) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** codex records `started_at` / `completed_at` in unix SECONDS. */
function secondsToMs(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) : null;
}

/** Parse the ISO-8601 envelope `timestamp` to epoch ms, defensively. */
function parseIsoMs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}
