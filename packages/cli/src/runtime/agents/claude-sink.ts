/**
 * Claude channel sink — implements `ChannelEventSink` so the runner
 * forwarder can deliver broker events to the claude runner
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
 * awareness cost, so a burst of micro-events (ten objective updates
 * landing at once) collapses within a 200ms window into a single
 * message carrying the same prose.
 *
 * The queue also solves cold start. The runner needs a sink before the
 * agent spawns; events that arrive while the SDK subprocess is still
 * booting simply sit in the stream until the CLI reads them — nothing
 * is dropped, nothing needs a second buffering layer.
 */

import { randomUUID } from 'node:crypto';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from 'csuite-core';
import type { RunnerConditionCode, RunnerControlFrame } from 'csuite-sdk/types';
import type { ChannelDeliveryReceipt, ChannelEventSink } from '../forwarder.js';
import {
  classifyRunnerFailure,
  isUnactedClaudeFailure,
  RUNNER_CONDITION_DETAIL,
} from '../runner-condition.js';
import { formatChannelEvent } from './channel-format.js';

const DEFAULT_BUNDLE_WINDOW_MS = 200;
const UNREPORTED_RECEIPT: ChannelDeliveryReceipt = {
  messageId: '(unreported)',
  accepted() {},
  settle() {},
};

/**
 * Unbounded FIFO of streaming-input messages, consumed by the async
 * generator handed to the SDK's `query()`. `close()` ends the stream:
 * the generator returns after draining what's already queued, which is
 * the SDK's graceful-shutdown signal (stdin EOF → grace window).
 */
export class ClaudeMessageQueue {
  private items: Array<{ message: SDKUserMessage; onConsumed?: () => void }> = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage, onConsumed?: () => void): boolean {
    if (this.closed) return false;
    this.items.push({ message, ...(onConsumed ? { onConsumed } : {}) });
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
        if (next !== undefined) {
          next.onConsumed?.();
          yield next.message;
        }
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
  log: Logger;
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
  observe(message: SDKMessage): void;
}

export function createClaudeChannelSink(opts: ClaudeChannelSinkOptions): ClaudeChannelSink {
  const bundleWindow = opts.bundleWindowMs ?? DEFAULT_BUNDLE_WINDOW_MS;
  const buffer: Array<{ text: string; receipt: ChannelDeliveryReceipt }> = [];
  let timer: NodeJS.Timeout | null = null;
  let sendControl: ((frame: RunnerControlFrame) => void) | null = null;
  let turn: {
    id: string;
    receipts: ChannelDeliveryReceipt[];
    acted: boolean;
    failureCode?: RunnerConditionCode;
  } | null = null;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const events = buffer.splice(0, buffer.length);
    const body = events.map((event) => event.text).join('\n');
    const receipts = events.map((event) => event.receipt);
    const accepted = opts.getQueue().push(
      {
        type: 'user',
        message: { role: 'user', content: body },
        parent_tool_use_id: null,
      },
      () => {
        for (const receipt of receipts) receipt.accepted();
        if (turn === null) {
          turn = { id: randomUUID(), receipts: [], acted: false };
          sendControl?.({ kind: 'runner_condition', at: Date.now(), state: 'ready' });
          sendControl?.({ kind: 'runner_turn', at: Date.now(), turnId: turn.id, phase: 'started' });
        }
        turn.receipts.push(...receipts);
      },
    );
    if (!accepted) {
      opts.log.warn('deferred events — input stream closed', { bytes: body.length });
      for (const receipt of receipts) {
        receipt.settle('deferred', {
          reason: { code: 'turn_failed', detail: 'claude input stream is closed' },
        });
      }
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
    async deliver(event, receipt = UNREPORTED_RECEIPT) {
      // Channel events include the runner's `context_refresh`
      // re-briefs — same path. Capability updates
      // (`tools/list_changed`) reach claude through the bridge's stdio
      // MCP transport, not this sink.
      const text = formatChannelEvent(event);
      opts.log.debug('received channel event', {
        bytes: text.length,
        bufferDepth: buffer.length + 1,
        queueDepth: opts.getQueue().depth,
      });
      buffer.push({ text, receipt });
      scheduleFlush();
    },
    attachControl(send) {
      sendControl = send;
      send({ kind: 'runner_condition', at: Date.now(), state: 'ready' });
    },
    observe(message) {
      if (message.type === 'assistant' && turn !== null) {
        const code = classifyRunnerFailure(message);
        // A typed SDK error is itself the degraded fact. `unknown` means
        // "known failure, reason not yet classified" when that field is
        // present; it means "no prose match" only for legacy messages that
        // carry no structured error.
        if (message.error !== undefined || code !== 'unknown') {
          turn.failureCode = code;
          sendControl?.({
            kind: 'runner_condition',
            at: Date.now(),
            state: 'degraded',
            reason: { code, detail: RUNNER_CONDITION_DETAIL[code] },
          });
          for (const receipt of turn.receipts) {
            receipt.settle('deferred', {
              reason: { code: 'turn_failed', detail: 'claude cannot act on this turn' },
            });
          }
          turn.receipts = [];
        }
        const usedTool = message.message.content.some((block) => block.type === 'tool_use');
        if (usedTool && !turn.acted) {
          turn.acted = true;
          for (const receipt of turn.receipts) {
            receipt.settle('acted', { evidence: { kind: 'tool_call' } });
          }
          turn.receipts = [];
        }
        return;
      }
      if (message.type !== 'result' || turn === null) return;
      const current = turn;
      turn = null;
      const unactedFailure = isUnactedClaudeFailure(message, current.acted);
      const failed =
        message.subtype !== 'success' || current.failureCode !== undefined || unactedFailure;
      const outcome = failed ? 'failed' : current.acted ? 'acted' : 'no_action';
      sendControl?.({
        kind: 'runner_turn',
        at: Date.now(),
        turnId: current.id,
        phase: 'completed',
        outcome,
        ...(outcome === 'acted' ? { evidence: { kind: 'tool_call' } } : {}),
      });
      for (const receipt of current.receipts) {
        if (failed) {
          receipt.settle('deferred', {
            reason: { code: 'turn_failed', detail: 'claude turn failed' },
          });
        } else receipt.settle('handled');
      }
      if (failed) {
        const classified = classifyRunnerFailure(message);
        const code = current.failureCode ?? (classified !== 'unknown' ? classified : 'unknown');
        sendControl?.({
          kind: 'runner_condition',
          at: Date.now(),
          state: 'degraded',
          reason: { code, detail: RUNNER_CONDITION_DETAIL[code] },
        });
      }
    },
    flushNow() {
      flush();
    },
  };
}
