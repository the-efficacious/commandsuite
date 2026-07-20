/**
 * Runner-side Claude Code transcript reader — the transcript-primary
 * capture source for Claude runners.
 *
 * Claude Code appends every turn to a newline-delimited JSON transcript
 * at `~/.claude/projects/<slug>/<sessionId>.jsonl`. Its hooks carry the
 * live file path as `transcript_path`; once the capture host has learned
 * that path (via the hook server), we tail the file here and map each
 * new line to `ActivityEvent`s that flow to the existing uploader. This
 * REPLACES the old OpenTelemetry export: the transcript carries the full,
 * untruncated turn (thinking + text + tool_use + usage), not the ~2KB
 * OTEL body, and the tool RESULTS Claude Code records for each tool call.
 *
 * The reader is:
 *   - DEFENSIVE: it may be handed a truncated/garbage line mid-write, or
 *     a schema that mutated across Claude Code versions. It NEVER throws
 *     on a bad line — it logs + skips and keeps going. Structuring is
 *     delegated to core's pure `parseTranscriptLine` (which redacts all
 *     free text before it leaves the runner).
 *   - IDEMPOTENT: every line carries a unique `uuid`; we dedup on it so a
 *     re-read (poll + fs.watch both firing, or a resumed offset) can't
 *     double-emit.
 *   - RESUMABLE: we track a byte offset and only ever consume COMPLETE
 *     lines (up to the last newline in what we've read). A partial final
 *     line is left for the next drain.
 *
 * Liveness comes from BOTH `fs.watch` (low latency) and a ~300ms poll
 * fallback (fs.watch is unreliable on some platforms / network fs). Both
 * funnel into a single serialized `drain()`; the uuid dedup + offset make
 * concurrent/overlapping drains safe.
 *
 * MAPPING (see the rebase design):
 *   - `assistant` line -> `llm_exchange`: the parsed assistant message
 *     (thinking + text + tool_use blocks) becomes the entry's SINGLE
 *     response message; usage/model/stopReason come off the same
 *     envelope; request.messages stays `[]` (the turn SEQUENCE is the
 *     history — we don't restuff prior turns). duration ≈ this line's ts
 *     minus the prior line's ts.
 *   - `user` line with tool_result blocks -> one `tool_action` per
 *     result: toolName resolved from a tool_use id->name map built off
 *     assistant lines (falling back to MCP attribution, then 'tool');
 *     result/isError/toolUseId from the block. The tool INPUT already
 *     lives in the turn's tool_use block, so we don't duplicate it — the
 *     web folds by toolUseId.
 *   - `user` line with TEXT content -> `user_prompt` (the turn opener).
 *   - SKIP: isMeta lines, and any line core can't structure. Sidechain
 *     (subagent) lines ARE included — they're real activity.
 */

import { type FSWatcher, watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseTranscriptLine } from 'csuite-core';
import type { ActivityEvent, AnthropicMessage, AnthropicMessagesEntry } from 'csuite-sdk/types';

export interface TranscriptReaderOptions {
  /**
   * Returns the transcript file path once it's known (from a hook's
   * `transcript_path`), or null/undefined before the first hook fires.
   * Polled until it yields a path; the reader begins tailing then.
   */
  getPath: () => string | null | undefined;
  /** Sink for the mapped activity events (the capture host's uploader). */
  enqueue: (event: ActivityEvent) => void;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Poll interval in ms for the path-resolve + drain fallback. Default 300. */
  pollMs?: number;
}

export interface TranscriptReader {
  /** Stop watching/polling and release the file handle path. Idempotent. */
  close(): void;
}

const DEFAULT_POLL_MS = 300;
/** LF byte — line delimiter in the JSONL transcript. */
const NEWLINE = 0x0a;

export function attachTranscriptReader(options: TranscriptReaderOptions): TranscriptReader {
  const log =
    options.log ??
    ((msg: string, ctx: Record<string, unknown> = {}): void => {
      const record = { ts: new Date().toISOString(), component: 'transcript-reader', msg, ...ctx };
      process.stderr.write(`${JSON.stringify(record)}\n`);
    });
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  // The transcript path, resolved once from getPath() and then pinned.
  // Claude Code writes exactly one transcript per session, so once we
  // see a path we tail it for the runner's lifetime.
  let path: string | null = null;
  // Bytes consumed so far — always aligned to a newline boundary, so a
  // partial trailing line is never counted and re-reads resume cleanly.
  let offset = 0;
  // Dedup set: every line's `uuid`. Guards against poll+watch double-fire
  // and a resumed/overlapping read re-processing a line.
  const seen = new Set<string>();
  // tool_use id -> tool name, harvested from assistant lines so a later
  // user tool_result line can label its `tool_action`.
  const toolNames = new Map<string, string>();
  // ts of the previously processed line — the "triggering prior line" for
  // an assistant line's duration estimate.
  let prevLineTs = 0;

  let watcher: FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let draining = false;
  let drainQueued = false;
  let closed = false;

  const enqueue = (event: ActivityEvent): void => {
    try {
      options.enqueue(event);
    } catch (err) {
      log('transcript-reader: enqueue threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /**
   * Map one structured transcript line to activity events and enqueue
   * them. Never throws — a shape we don't expect simply produces nothing.
   */
  const processLine = (line: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      // A truncated/garbage line (mid-write, or a Claude Code quirk). The
      // offset only advances past COMPLETE lines, so this is a whole line
      // that failed to parse — log + skip, never throw.
      log('transcript-reader: skipping unparseable line', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const entry = parseTranscriptLine(raw);
    if (!entry) return;

    // `prevLineTs` tracks the immediately-preceding line for duration
    // math — update it for EVERY structured line (including skipped/meta
    // ones) so the "prior line" is truly the previous transcript line.
    const triggerTs = prevLineTs;
    if (entry.ts > 0) prevLineTs = entry.ts;

    // System-reminder noise — never activity.
    if (entry.isMeta) return;
    // Idempotency: a line we've already emitted for.
    if (seen.has(entry.uuid)) return;
    seen.add(entry.uuid);

    const msg = entry.message;

    if (entry.type === 'assistant' && msg) {
      // Harvest tool names so the matching tool_result line can label its
      // action. Do this even if we somehow don't emit below.
      for (const block of msg.content) {
        if (block.type === 'tool_use') toolNames.set(block.id, block.name);
      }
      // Build the single-response-message entry. request.messages stays
      // empty — the turn SEQUENCE is the history, we don't restuff prior
      // turns. startedAt uses the prior line's ts when we have one so the
      // duration reflects generation time; else it collapses to 0.
      const endedAt = entry.ts;
      const startedAt = triggerTs > 0 ? triggerTs : endedAt;
      const responseMessage: AnthropicMessage = { role: msg.role, content: msg.content };
      const messagesEntry: AnthropicMessagesEntry = {
        kind: 'anthropic_messages',
        startedAt,
        endedAt,
        request: {
          model: msg.model,
          maxTokens: null,
          temperature: null,
          system: null,
          messages: [],
          tools: null,
        },
        response: {
          stopReason: msg.stopReason,
          stopSequence: null,
          messages: [responseMessage],
          usage: msg.usage,
          status: null,
          // The API message id — the exact join key to this call's
          // GenAI inference record (full request context) downstream.
          responseId: msg.id,
        },
      };
      enqueue({
        kind: 'llm_exchange',
        ts: endedAt,
        duration: Math.max(0, endedAt - startedAt),
        agent: 'claude',
        entry: messagesEntry,
      });
      return;
    }

    if (entry.type === 'user' && msg) {
      // A user line is EITHER tool results (the turn's tool outputs) OR
      // an opener text prompt — never both in practice. tool_result wins
      // so a stray text block alongside results can't spawn a bogus
      // opener. Content is already redacted by parseAnthropicMessage.
      const toolResults = msg.content.filter(
        (b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result',
      );
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const toolName =
            toolNames.get(tr.toolUseId) ??
            entry.attributionMcpTool ??
            entry.attributionMcpServer ??
            'tool';
          enqueue({
            kind: 'tool_action',
            ts: entry.ts,
            agent: 'claude',
            source: 'transcript',
            toolName,
            result: tr.content,
            isError: tr.isError,
            toolUseId: tr.toolUseId,
          });
        }
        return;
      }

      const text = msg.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text.length > 0) {
        enqueue({
          kind: 'user_prompt',
          ts: entry.ts,
          text,
          promptId: entry.promptId,
          agent: 'claude',
        });
      }
    }
    // Any other line type (system / mode / file-history-snapshot) carries
    // no activity — structured above only for prevLineTs bookkeeping.
  };

  /**
   * Read every complete new line since `offset` and process it. Serialized
   * against itself (a second trigger while draining sets `drainQueued` and
   * re-runs afterward) so poll + fs.watch overlap is safe. Never throws;
   * a missing/again-vanished file is a silent no-op.
   */
  const drain = async (): Promise<void> => {
    if (closed || path === null) return;
    if (draining) {
      drainQueued = true;
      return;
    }
    draining = true;
    try {
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(path, 'r');
      } catch {
        // File not there yet (or transiently gone). The poll will retry.
        return;
      }
      try {
        const stat = await handle.stat();
        if (stat.size <= offset) return;
        const len = stat.size - offset;
        const buf = Buffer.alloc(len);
        const { bytesRead } = await handle.read(buf, 0, len, offset);
        if (bytesRead <= 0) return;
        // Only consume up to the LAST newline — everything after it is a
        // partial line still being written; leave it for the next drain.
        // Work in BYTES (newline is a single-byte 0x0A, never part of a
        // multibyte UTF-8 sequence) so the offset stays exact regardless
        // of a truncated multibyte tail.
        const lastNl = buf.lastIndexOf(NEWLINE, bytesRead - 1);
        if (lastNl < 0) return; // no complete line available yet
        const completeText = buf.subarray(0, lastNl).toString('utf8');
        offset += lastNl + 1; // advance past the consumed bytes + the newline
        for (const line of completeText.split('\n')) {
          if (line.trim().length === 0) continue;
          processLine(line);
        }
      } finally {
        await handle.close();
      }
    } catch (err) {
      // Belt-and-suspenders: nothing above should throw, but if a read
      // races a truncation/rotation we log + swallow rather than crash.
      log('transcript-reader: drain error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      draining = false;
      if (drainQueued && !closed) {
        drainQueued = false;
        void drain();
      }
    }
  };

  /** Resolve the path once, then attach fs.watch for low-latency drains. */
  const ensurePath = (): void => {
    if (path !== null || closed) return;
    const p = options.getPath();
    if (typeof p !== 'string' || p.length === 0) return;
    path = p;
    log('transcript-reader: tailing transcript', { path });
    try {
      watcher = watch(path, () => {
        void drain();
      });
      watcher.on('error', (err) => {
        // fs.watch died (rotation, platform quirk). Drop it; the poll
        // fallback keeps us live.
        log('transcript-reader: watcher error, relying on poll', {
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          watcher?.close();
        } catch {
          /* ignore */
        }
        watcher = null;
      });
    } catch (err) {
      // Couldn't watch (file vanished between resolve and watch, etc.).
      // The poll covers us.
      log('transcript-reader: watch failed, relying on poll', {
        error: err instanceof Error ? err.message : String(err),
      });
      watcher = null;
    }
    // Kick an immediate drain so we don't wait a poll interval for the
    // backlog already in the file.
    void drain();
  };

  // The steady-state loop: resolve the path if we still need it, then
  // drain. Runs on an interval; unref'd so it can't keep the process alive
  // past runner shutdown.
  pollTimer = setInterval(() => {
    ensurePath();
    void drain();
  }, pollMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  // Try to resolve immediately in case the path is already known.
  ensurePath();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
        watcher = null;
      }
    },
  };
}
