/**
 * Codex channel sink — implements `ChannelEventSink` so the runner
 * forwarder can deliver broker events to us without knowing it's
 * talking to codex instead of claude.
 *
 * Responsibility: turn each inbound channel event into either a
 * `turn/start` (when codex is Idle) or a `turn/steer` (when codex is
 * Active mid-turn). Bundle bursts so a flurry of micro-events compose
 * into a single dispatch.
 *
 * Why bundling matters: each dispatch is a full JSON-RPC round-trip
 * with a model-side awareness cost — every steer adds a user-input
 * item the model sees on its next API call. Sending each broker event
 * as its own steer would inflate the model's input transcript with
 * one steer per event. Bundling within a 200ms window collapses
 * bursts (e.g. ten objective updates landing simultaneously) into one
 * steer carrying the same prose.
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
 *   <channel kind="chat" from="teammate" thread="primary" ts="...">
 *     <body>...</body>
 *   </channel>
 *
 * The rendering is shared with the claude sink (`channel-format.ts`).
 */

import { logger as defaultLogger, type Logger } from 'csuite-core';
import type { RunnerConditionCode, RunnerControlFrame } from 'csuite-sdk/types';
import type { ChannelDeliveryReceipt, ChannelEventSink } from '../../forwarder.js';
import { formatChannelEvent } from '../channel-format.js';
import type { JsonRpcClient } from './json-rpc.js';
import { METHODS, type ThreadStatus, type TurnStartResponse, type UserInput } from './protocol.js';

const DEFAULT_BUNDLE_WINDOW_MS = 200;
const UNREPORTED_RECEIPT: ChannelDeliveryReceipt = {
  messageId: '(unreported)',
  accepted() {},
  settle() {},
};

export interface CodexChannelSinkOptions {
  rpc: JsonRpcClient;
  /** Live thread id. Set by the adapter once `thread/start` returns. */
  getThreadId(): string | null;
  /** Latest known thread status (driven by `thread/status/changed`). */
  getStatus(): ThreadStatus;
  /** Latest known active turn id. `null` when no turn is active. */
  getActiveTurnId(): string | null;
  /** Structured logger. Defaults to the shared logger's 'codex-channel-sink' child. */
  logger?: Logger;
  /** Bundle window in milliseconds. Defaults to 200ms. */
  bundleWindowMs?: number;
}

interface BufferedEvent {
  /** The flattened text body to pass to codex. */
  text: string;
  receipt: ChannelDeliveryReceipt;
}

export interface CodexChannelSink extends ChannelEventSink {
  /**
   * Force an immediate flush of the buffer. Called by the adapter
   * during graceful shutdown so anything queued reaches codex before
   * we tear down the thread.
   */
  flushNow(): Promise<void>;
  turnStarted(turnId: string, at?: number): void;
  turnCompleted(turnId: string, failed?: boolean, at?: number): void;
  acted(turnId: string, kind: 'tool_call' | 'outbound_effect', at?: number): void;
  degraded(code: RunnerConditionCode, detail: string): void;
}

export function createCodexChannelSink(opts: CodexChannelSinkOptions): CodexChannelSink {
  const log = opts.logger ?? defaultLogger.child('codex-channel-sink');
  const bundleWindow = opts.bundleWindowMs ?? DEFAULT_BUNDLE_WINDOW_MS;

  const buffer: BufferedEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> | null = null;
  let sendControl: ((frame: RunnerControlFrame) => void) | null = null;
  const awaitingStarted = new Map<string, ChannelDeliveryReceipt[]>();
  const turnReceipts = new Map<string, ChannelDeliveryReceipt[]>();
  const actedTurns = new Map<string, 'tool_call' | 'outbound_effect'>();

  const defer = (events: BufferedEvent[], detail: string): void => {
    for (const event of events) {
      event.receipt.settle('deferred', { reason: { code: 'turn_failed', detail } });
    }
  };

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
      log.warn('deferring events — thread in systemError', { deferred: events.length });
      defer(events, 'codex thread is unavailable');
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
        const started = await opts.rpc.request<TurnStartResponse>(METHODS.turnStart, {
          threadId,
          input,
        });
        awaitingStarted.set(
          started.turn.id,
          events.map((event) => event.receipt),
        );
      } catch (err) {
        log.warn('turn/start failed', {
          error: err instanceof Error ? err.message : String(err),
          deferred: events.length,
        });
        defer(events, 'codex turn failed to start');
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
      const receipts = events.map((event) => event.receipt);
      for (const receipt of receipts) receipt.accepted();
      turnReceipts.set(turnId, [...(turnReceipts.get(turnId) ?? []), ...receipts]);
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
        log.warn('turn/steer failed (non-race)', {
          error: msg,
          deferred: events.length,
        });
        defer(events, 'codex turn steer failed');
        return;
      }
      log.warn('steer race — retrying', { reason: msg });
      const retryStatus = opts.getStatus();
      if (retryStatus.type === 'idle') {
        try {
          const started = await opts.rpc.request<TurnStartResponse>(METHODS.turnStart, {
            threadId,
            input,
          });
          awaitingStarted.set(
            started.turn.id,
            events.map((event) => event.receipt),
          );
        } catch (retryErr) {
          log.warn('retry turn/start failed', {
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
            deferred: events.length,
          });
          defer(events, 'codex retry turn failed to start');
        }
        return;
      }
      if (retryStatus.type === 'active') {
        const retryTurnId = opts.getActiveTurnId();
        if (retryTurnId === null) {
          // Still racing; give up rather than spin.
          log.warn('retry skipped — no turn id yet', {
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
          const receipts = events.map((event) => event.receipt);
          for (const receipt of receipts) receipt.accepted();
          turnReceipts.set(retryTurnId, [...(turnReceipts.get(retryTurnId) ?? []), ...receipts]);
        } catch (retryErr) {
          log.warn('retry turn/steer failed', {
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
            deferred: events.length,
          });
          defer(events, 'codex retry turn steer failed');
        }
        return;
      }
      // notLoaded / systemError on retry — re-buffer or drop.
      if (retryStatus.type === 'notLoaded') {
        buffer.unshift(...events);
      } else {
        log.warn('retry deferred — systemError', { deferred: events.length });
        defer(events, 'codex thread entered system error');
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
        log.error('scheduled flush threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, bundleWindow);
    // Don't pin the event loop alive on the buffer timer.
    timer.unref?.();
  };

  return {
    async deliver(event, receipt = UNREPORTED_RECEIPT) {
      // Channel events include the runner's `context_refresh`
      // re-briefs — same path. `tools/list_changed` capability updates
      // reach codex through the bridge's stdio MCP transport, not this
      // sink.
      const text = formatChannelEvent(event);
      log.debug('received channel event', {
        bytes: text.length,
        bufferDepth: buffer.length + 1,
        status: opts.getStatus().type,
        threadId: opts.getThreadId(),
      });
      buffer.push({ text, receipt });
      scheduleFlush();
    },
    attachControl(send) {
      sendControl = send;
      send({ kind: 'runner_condition', at: Date.now(), state: 'ready' });
    },
    turnStarted(turnId, at = Date.now()) {
      sendControl?.({ kind: 'runner_condition', at, state: 'ready' });
      sendControl?.({ kind: 'runner_turn', at, turnId, phase: 'started' });
      const receipts = awaitingStarted.get(turnId) ?? [];
      awaitingStarted.delete(turnId);
      for (const receipt of receipts) receipt.accepted();
      if (receipts.length > 0) turnReceipts.set(turnId, receipts);
    },
    acted(turnId, kind, _at = Date.now()) {
      actedTurns.set(turnId, kind);
      for (const receipt of turnReceipts.get(turnId) ?? []) {
        receipt.settle('acted', { evidence: { kind } });
      }
      turnReceipts.delete(turnId);
    },
    turnCompleted(turnId, failed = false, at = Date.now()) {
      const evidence = actedTurns.get(turnId);
      actedTurns.delete(turnId);
      const outcome = failed ? 'failed' : evidence ? 'acted' : 'no_action';
      sendControl?.({
        kind: 'runner_turn',
        at,
        turnId,
        phase: 'completed',
        outcome,
        ...(outcome === 'acted' && evidence ? { evidence: { kind: evidence } } : {}),
      });
      for (const receipt of turnReceipts.get(turnId) ?? []) {
        if (failed) {
          receipt.settle('deferred', {
            reason: { code: 'turn_failed', detail: 'codex turn failed' },
          });
        } else receipt.settle('handled');
      }
      turnReceipts.delete(turnId);
    },
    degraded(code, detail) {
      sendControl?.({
        kind: 'runner_condition',
        at: Date.now(),
        state: 'degraded',
        reason: { code, detail },
      });
    },
    async flushNow() {
      await flush();
    },
  };
}
