/**
 * Codex channel sink — implements `ForwarderNotificationSink` so the
 * existing runner forwarder can dispatch broker SSE events at us
 * without knowing it's talking to codex instead of claude.
 *
 * Responsibility: turn each inbound `notifications/claude/channel`
 * call into either a `turn/start` (when codex is Idle) or a
 * `turn/steer` (when codex is Active mid-turn). Bundle bursts so a
 * flurry of micro-events compose into a single dispatch.
 *
 * Why bundling matters: claude's MCP channel flows arrive
 * mid-turn as ambient context with zero protocol overhead. Codex
 * accepts the same content via `turn/steer`, but each dispatch is a
 * full JSON-RPC round-trip with a model-side awareness cost — every
 * steer adds a user-input item the model sees on its next API call.
 * Sending each broker event as its own steer would inflate the model's
 * input transcript with one steer per event. Bundling within a 200ms
 * window collapses bursts (e.g. ten objective updates landing
 * simultaneously) into one steer carrying the same prose.
 *
 * Routing rule:
 *   ThreadStatus.idle       → buffer + 200ms timer → turn/start
 *   ThreadStatus.active     → buffer + 200ms timer → turn/steer
 *                              (with expectedTurnId from latest turn/started)
 *   ThreadStatus.notLoaded  → buffer indefinitely until status flips;
 *                              avoids dispatching before thread/start
 *                              completes on cold boot
 *   ThreadStatus.systemError → drop with a log line — no point queuing
 *                              against a broken thread
 *
 * Mid-turn → idle race (turn/steer mismatch): when codex transitions
 * out of `active` between our flush decision and the JSON-RPC
 * dispatch arriving server-side, codex returns ExpectedTurnMismatch.
 * We retry once: re-read current status, dispatch as turn/start (if
 * idle) or turn/steer with the new turn_id (if a new turn started).
 * If the second attempt also fails we drop the event with a log;
 * that's almost always thread-shutdown anyway.
 *
 * Channel-event content is wrapped in unmistakable framing so the
 * agent recognises it as ambient signal, not a fresh user request:
 *
 *   <channel kind="chat" from="director" thread="primary" ts="...">
 *     <body>...</body>
 *   </channel>
 *
 * The shape mirrors the meta-keyed format the claude side emits
 * through `notifications/claude/channel`, just rendered as text.
 */

import { MCP_CHANNEL_NOTIFICATION } from 'csuite-sdk/protocol';
import type { ForwarderNotificationSink } from '../../forwarder.js';
import type { JsonRpcClient } from './json-rpc.js';
import { METHODS, type ThreadStatus, type TurnStartResponse, type UserInput } from './protocol.js';

const DEFAULT_BUNDLE_WINDOW_MS = 200;

export interface CodexChannelSinkOptions {
  rpc: JsonRpcClient;
  /** Live thread id. Set by the adapter once `thread/start` returns. */
  getThreadId(): string | null;
  /** Latest known thread status (driven by `thread/status/changed`). */
  getStatus(): ThreadStatus;
  /** Latest known active turn id. `null` when no turn is active. */
  getActiveTurnId(): string | null;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Bundle window in milliseconds. Defaults to 200ms. */
  bundleWindowMs?: number;
}

interface BufferedEvent {
  /** The MCP method the forwarder was trying to call. */
  method: string;
  /** The flattened text body to pass to codex. */
  text: string;
}

export interface CodexChannelSink extends ForwarderNotificationSink {
  /**
   * Force an immediate flush of the buffer. Called by the adapter
   * during graceful shutdown so anything queued reaches codex before
   * we tear down the thread.
   */
  flushNow(): Promise<void>;
}

export function createCodexChannelSink(opts: CodexChannelSinkOptions): CodexChannelSink {
  const bundleWindow = opts.bundleWindowMs ?? DEFAULT_BUNDLE_WINDOW_MS;

  const buffer: BufferedEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> | null = null;

  const renderBuffer = (events: BufferedEvent[]): UserInput[] => {
    if (events.length === 0) return [];
    // Single text item carrying every buffered channel event back-to-back.
    // Codex's UserInput.Text accepts arbitrary prose; the agent reads it
    // as user input and we make the framing unambiguous so the model
    // treats it as ambient signal.
    const body = events.map((e) => e.text).join('\n');
    return [{ type: 'text', text: body }];
  };

  const dispatchOnce = async (events: BufferedEvent[]): Promise<void> => {
    const threadId = opts.getThreadId();
    if (threadId === null) {
      // Adapter hasn't completed thread/start yet. Re-buffer and let
      // the adapter flush after the thread is ready. Adapter wires a
      // status watcher that calls flushNow() when status flips off
      // notLoaded.
      buffer.unshift(...events);
      return;
    }

    const status = opts.getStatus();
    if (status.type === 'systemError') {
      opts.log('codex-channel-sink: dropping events — thread in systemError', {
        dropped: events.length,
      });
      return;
    }
    if (status.type === 'notLoaded') {
      buffer.unshift(...events);
      return;
    }

    const input = renderBuffer(events);
    if (input.length === 0) return;

    if (status.type === 'idle') {
      try {
        await opts.rpc.request<TurnStartResponse>(METHODS.turnStart, {
          threadId,
          input,
        });
      } catch (err) {
        opts.log('codex-channel-sink: turn/start failed', {
          error: err instanceof Error ? err.message : String(err),
          dropped: events.length,
        });
      }
      return;
    }

    // status.type === 'active' — steer the live turn.
    const turnId = opts.getActiveTurnId();
    if (turnId === null) {
      // Race: status says active but we haven't seen turn/started yet.
      // Re-buffer; the next status-change tick will flush us.
      buffer.unshift(...events);
      return;
    }
    try {
      await opts.rpc.request(METHODS.turnSteer, {
        threadId,
        input,
        expectedTurnId: turnId,
      });
    } catch (err) {
      // ExpectedTurnMismatch / NoActiveTurn on race with turn end. The
      // protocol surfaces these as JSON-RPC errors with code -32600
      // (invalid request). We retry once with whatever the current
      // state tells us.
      const msg = err instanceof Error ? err.message : String(err);
      const looksLikeRace =
        msg.includes('expected active turn') ||
        msg.includes('no active turn') ||
        msg.includes('not steerable');
      if (!looksLikeRace) {
        opts.log('codex-channel-sink: turn/steer failed (non-race)', {
          error: msg,
          dropped: events.length,
        });
        return;
      }
      opts.log('codex-channel-sink: steer race — retrying', { reason: msg });
      const retryStatus = opts.getStatus();
      if (retryStatus.type === 'idle') {
        try {
          await opts.rpc.request<TurnStartResponse>(METHODS.turnStart, {
            threadId,
            input,
          });
        } catch (retryErr) {
          opts.log('codex-channel-sink: retry turn/start failed', {
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
            dropped: events.length,
          });
        }
        return;
      }
      if (retryStatus.type === 'active') {
        const retryTurnId = opts.getActiveTurnId();
        if (retryTurnId === null) {
          // Still racing; give up rather than spin.
          opts.log('codex-channel-sink: retry skipped — no turn id yet', {
            dropped: events.length,
          });
          return;
        }
        try {
          await opts.rpc.request(METHODS.turnSteer, {
            threadId,
            input,
            expectedTurnId: retryTurnId,
          });
        } catch (retryErr) {
          opts.log('codex-channel-sink: retry turn/steer failed', {
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
            dropped: events.length,
          });
        }
        return;
      }
      // notLoaded / systemError on retry — re-buffer or drop.
      if (retryStatus.type === 'notLoaded') {
        buffer.unshift(...events);
      } else {
        opts.log('codex-channel-sink: retry dropped — systemError', {
          dropped: events.length,
        });
      }
    }
  };

  const flush = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    // Serialize concurrent flushes — if a status-change-driven flush
    // races with the timer, only one runs at a time.
    if (flushing !== null) {
      await flushing;
      // Re-check buffer after the prior flush; a new event may have
      // arrived during it.
      if (buffer.length === 0) return;
    }
    const drain = buffer.splice(0, buffer.length);
    flushing = dispatchOnce(drain).finally(() => {
      flushing = null;
    });
    await flushing;
  };

  const scheduleFlush = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush().catch((err) => {
        opts.log('codex-channel-sink: scheduled flush threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, bundleWindow);
    // Don't pin the event loop alive on the buffer timer.
    timer.unref?.();
  };

  return {
    async notification(args) {
      // We only handle the channel notification (which includes the
      // runner's `context_refresh` re-briefs — they use the same
      // method). Any future `tools/list_changed` capability updates
      // reach codex through the bridge's stdio MCP transport, not this
      // sink. Anything other than the channel notification we ignore
      // here.
      if (args.method !== MCP_CHANNEL_NOTIFICATION) {
        opts.log('codex-channel-sink: ignored non-channel notification', {
          method: args.method,
        });
        return;
      }
      const text = formatChannelEvent(args.params);
      if (text === null) return;
      opts.log('codex-channel-sink: received channel event', {
        bytes: text.length,
        bufferDepth: buffer.length + 1,
        status: opts.getStatus().type,
        threadId: opts.getThreadId(),
      });
      buffer.push({ method: args.method, text });
      scheduleFlush();
    },
    async flushNow() {
      await flush();
    },
  };
}

/**
 * Render the channel-notification params (content + meta) into a single
 * `<channel>` tagged block that the agent can recognise as ambient
 * signal rather than fresh user input. Format mirrors the meta keys
 * the forwarder produces (`from`, `thread`, `ts`, etc.).
 */
function formatChannelEvent(params: Record<string, unknown> | undefined): string | null {
  if (!params || typeof params !== 'object') return null;
  const content = typeof params.content === 'string' ? params.content : '';
  const metaRaw = params.meta;
  const meta: Record<string, string> =
    metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw)
      ? (metaRaw as Record<string, string>)
      : {};

  // Highest-signal meta fields first; the rest land as `key="value"`
  // attributes so the agent can scan them.
  const ordered: Array<[string, string | undefined]> = [
    ['kind', meta.kind],
    ['from', meta.from],
    ['thread', meta.thread],
    ['title', meta.title],
    ['target', meta.target],
    ['level', meta.level],
    ['ts', meta.ts],
    ['msg_id', meta.msg_id],
  ];
  const seen = new Set<string>();
  const attrs: string[] = [];
  for (const [k, v] of ordered) {
    seen.add(k);
    if (typeof v === 'string' && v.length > 0) {
      attrs.push(`${k}=${attrEscape(v)}`);
    }
  }
  for (const [k, v] of Object.entries(meta)) {
    if (seen.has(k)) continue;
    if (typeof v === 'string' && v.length > 0) {
      attrs.push(`${k}=${attrEscape(v)}`);
    }
  }
  const open = attrs.length > 0 ? `<channel ${attrs.join(' ')}>` : '<channel>';
  return `${open}\n${content}\n</channel>`;
}

function attrEscape(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}
