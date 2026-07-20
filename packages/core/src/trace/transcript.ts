/**
 * Claude Code session-transcript parsers.
 *
 * Claude Code appends every turn to a newline-delimited JSON transcript
 * at `~/.claude/projects/<slug>/<sessionId>.jsonl`. The runner's
 * TranscriptReader tails that file and maps each line to an
 * ActivityEvent; these are the pure, reusable parsers it leans on.
 *
 * Two concerns live here:
 *   - `parseAnthropicMessage` structures a single Anthropic assistant
 *     (or user) message envelope — the `message` field of a transcript
 *     line — into the same content-block shape the HTTP-trace extractor
 *     produces, so the web turn-block renderer stays unchanged. It
 *     reuses `parseContent`/`parseUsage`/`asString` from the anthropic
 *     extractor so there's one content-block parser, not two.
 *   - `parseTranscriptLine` structures the transcript envelope itself
 *     (uuid / ts / type / flags / attribution) and folds the message
 *     through `parseAnthropicMessage` when present.
 *
 * Everything is defensive: real transcripts carry envelope fields we
 * don't model, mutate message shapes across Claude Code versions, and
 * occasionally contain a truncated/garbage line the reader hands us
 * mid-write. We NEVER throw — an unusable line yields `null` and the
 * reader logs+skips it. All free text (message text, tool inputs, tool
 * results) is redacted via `redactJson` before it leaves this module,
 * matching the HTTP-trace path.
 *
 * Pure module — no `node:` imports, no fs, no http — so it lives in
 * `csuite-core` and both the runner reader and any server
 * consumer can import it.
 */

import {
  type AnthropicContentBlock,
  type AnthropicUsage,
  asString,
  parseContent,
  parseUsage,
} from './anthropic.js';
import { redactJson } from './redact.js';

/**
 * A single Anthropic message envelope (transcript `message` field),
 * structured. `role`/`content` mirror the HTTP-trace `AnthropicMessage`;
 * `model`/`usage`/`stopReason` are pulled from the assistant response
 * envelope (null on user lines, which carry none of them).
 */
export interface ParsedAnthropicMessage {
  role: string;
  content: AnthropicContentBlock[];
  model: string | null;
  usage: AnthropicUsage | null;
  stopReason: string | null;
  /**
   * The API message id (`msg_...`) from the assistant response
   * envelope; null on user lines. Carried into the llm_exchange's
   * `response.responseId` — the exact join key to the matching
   * GenAI inference record (same id space as `gen_ai.response.id`).
   */
  id: string | null;
}

/**
 * A structured transcript line. Only the fields the reader needs to
 * build an ActivityEvent are surfaced; unknown envelope fields are
 * tolerated and dropped. `message` is present only when the line
 * carried a parseable message envelope (assistant / user lines).
 */
export interface TranscriptEntry {
  /** Line-unique id — the reader's dedup key. */
  uuid: string;
  /** Line timestamp in epoch milliseconds (parsed from the ISO string). */
  ts: number;
  /** Envelope type: 'assistant' | 'user' | 'system' | 'mode' | … */
  type: string;
  /** True for subagent/Task activity — real activity, kept. */
  isSidechain: boolean;
  /** True for system-reminder noise the reader should skip. */
  isMeta: boolean;
  /** Prompt id, when the line carries one. */
  promptId?: string;
  /** MCP attribution, when the tool call came from an MCP server. */
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  /** Parsed message envelope, when present. */
  message?: ParsedAnthropicMessage;
}

/**
 * Structure a single Anthropic message envelope — the `message` field
 * of an `assistant` or `user` transcript line — into content blocks +
 * response metadata.
 *
 * Content blocks reuse the HTTP-trace parser (`parseContent`), so a
 * thinking block's `thinking` field maps to the block's `text`, a
 * `tool_use` keeps `{id,name,input}`, and a `tool_result` maps
 * `{tool_use_id,content,is_error}` -> `{toolUseId,content,isError}`.
 * The parsed blocks are redacted via `redactJson` (matching
 * `parseMessages` in the HTTP path — `parseContent` itself does not
 * redact) so text / tool inputs / tool results are scrubbed before
 * leaving the runner. `usage` maps input/output/cache token counts;
 * `model` and `stopReason` come from the assistant response envelope.
 *
 * Never throws: a non-object message yields an empty-content message
 * with null metadata.
 */
export function parseAnthropicMessage(message: unknown): ParsedAnthropicMessage {
  if (!message || typeof message !== 'object') {
    return { role: 'unknown', content: [], model: null, usage: null, stopReason: null, id: null };
  }
  const m = message as Record<string, unknown>;
  const role = asString(m.role) ?? 'unknown';
  // parseContent tolerates string | block-array | anything else (-> []).
  const content = redactJson(parseContent(m.content));
  return {
    role,
    content,
    model: asString(m.model),
    usage: parseUsage(m.usage),
    stopReason: asString(m.stop_reason),
    id: asString(m.id),
  };
}

/**
 * Parse epoch-ms from an ISO-8601 timestamp string. Returns 0 for a
 * missing/garbage timestamp rather than NaN so downstream duration math
 * stays finite.
 */
function parseTs(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Structure one raw transcript line (already JSON-parsed) into a
 * `TranscriptEntry`, or `null` when the line is unusable.
 *
 * A line is unusable — and dropped — when it isn't an object or lacks a
 * string `type` or a string `uuid` (the dedup key). Everything else is
 * tolerated: unknown envelope fields are ignored, flags default false,
 * and the message envelope is folded through `parseAnthropicMessage`
 * only when it's a present object (so system/mode/snapshot lines carry
 * no `message`). Never throws.
 */
export function parseTranscriptLine(raw: unknown): TranscriptEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const type = asString(o.type);
  const uuid = asString(o.uuid);
  if (!type || !uuid) return null;

  const entry: TranscriptEntry = {
    uuid,
    ts: parseTs(o.timestamp),
    type,
    isSidechain: o.isSidechain === true,
    isMeta: o.isMeta === true,
  };

  const promptId = asString(o.promptId);
  if (promptId) entry.promptId = promptId;

  const mcpServer = asString(o.attributionMcpServer);
  if (mcpServer) entry.attributionMcpServer = mcpServer;
  const mcpTool = asString(o.attributionMcpTool);
  if (mcpTool) entry.attributionMcpTool = mcpTool;

  // Only assistant/user lines carry a message envelope; skip parsing for
  // system/mode/file-history-snapshot lines (no `message`, or a
  // non-object one) so they surface as a bare envelope entry.
  if (o.message && typeof o.message === 'object') {
    entry.message = parseAnthropicMessage(o.message);
  }

  return entry;
}
