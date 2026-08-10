/**
 * Claude channel sink — implements `ChannelEventSink` so the runner
 * forwarder can deliver broker SSE events to the claude runner
 * without knowing the agent runs on the Agent SDK.
 *
 * Broker events render as `<channel>` tagged text (shared format with
 * the codex sink) and are pushed into the SDK's streaming-input
 * generator as user messages. Claude Code's own input queue handles
 * the turn mechanics natively: a message arriving while the agent is
 * idle starts a turn, one arriving mid-turn is queued and folded into
 * the conversation — the codex sink's `turn/start`-vs-`turn/steer`
 * routing (and its mismatch-retry dance) has no equivalent here.
 *
 * Bundling is kept: each dispatched user message has model-side
 * awareness cost, so a burst of micro-events (ten channel posts
 * landing at once) collapses within a 200ms window into a single
 * message carrying the same prose.
 *
 * The queue also solves cold start. The runner needs a sink before the
 * agent spawns; events that arrive while the SDK subprocess is still
 * booting simply sit in the stream until the CLI reads them — nothing
 * is dropped, nothing needs a second buffering layer.
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelEventSink } from '../forwarder.js';
import { formatChannelEvent } from './channel-format.js';

const DEFAULT_BUNDLE_WINDOW_MS = 200;

/**
 * Unbounded FIFO of streaming-input messages, consumed by the async
 * generator handed to the SDK's `query()`. `close()` ends the stream:
 * the generator returns after draining what's already queued, which is
 * the SDK's graceful-shutdown signal (stdin EOF → grace window).
 */
export class ClaudeMessageQueue {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): boolean {
    if (this.closed) return false;
    this.items.push(message);
    this.wake?.();
    return true;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  /** Number of queued-but-unconsumed messages (diagnostics only). */
  get depth(): number {
    return this.items.length;
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.items.length > 0) {
        const next = this.items.shift();
        if (next !== undefined) yield next;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null;
          resolve();
        };
      });
    }
  }
}

export interface ClaudeChannelSinkOptions {
  /**
   * Where flushed bundles go — read AT FLUSH TIME, not bound at
   * construction. The indirection is what makes agent restart
   * loss-free: the adapter re-points this at a fresh queue before
   * shutting the old session down, so events arriving during the swap
   * wait in the successor's stream (the same cold-start property a
   * first spawn relies on) instead of dying with the predecessor.
   */
  getQueue: () => ClaudeMessageQueue;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Bundle window in milliseconds. Defaults to 200ms. */
  bundleWindowMs?: number;
}

export interface ClaudeChannelSink extends ChannelEventSink {
  /**
   * Flush the bundle buffer immediately. The adapter calls this before
   * ending the input stream so a just-arrived event isn't stranded in
   * the 200ms window at teardown.
   */
  flushNow(): void;
}

export function createClaudeChannelSink(opts: ClaudeChannelSinkOptions): ClaudeChannelSink {
  const bundleWindow = opts.bundleWindowMs ?? DEFAULT_BUNDLE_WINDOW_MS;
  const buffer: string[] = [];
  let timer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const body = buffer.splice(0, buffer.length).join('\n');
    const accepted = opts.getQueue().push({
      type: 'user',
      message: { role: 'user', content: body },
      parent_tool_use_id: null,
    });
    if (!accepted) {
      opts.log('claude-sink: dropped events — input stream closed', { bytes: body.length });
    }
  };

  const scheduleFlush = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, bundleWindow);
    // Don't pin the event loop alive on the bundle timer.
    timer.unref?.();
  };

  return {
    async deliver(event) {
      // Channel events include the runner's `context_refresh`
      // re-briefs — same path. Capability updates
      // (`tools/list_changed`) reach claude through the bridge's stdio
      // MCP transport, not this sink.
      const text = formatChannelEvent(event);
      opts.log('claude-sink: received channel event', {
        bytes: text.length,
        bufferDepth: buffer.length + 1,
        queueDepth: opts.getQueue().depth,
      });
      buffer.push(text);
      scheduleFlush();
    },
    flushNow() {
      flush();
    },
  };
}
