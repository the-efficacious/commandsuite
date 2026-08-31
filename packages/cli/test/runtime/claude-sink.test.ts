/**
 * Claude channel sink + message queue unit tests.
 *
 * The sink is the claude runner's `ChannelEventSink`: broker channel
 * events render as `<channel>` blocks, bundle within a window, and
 * land on the streaming-input queue as single user messages. The
 * queue is the async generator the Agent SDK consumes.
 */

import type { RunnerControlFrame } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeMessageQueue,
  createClaudeChannelSink,
} from '../../src/runtime/agents/claude-sink.js';
import { silentLogger } from '../helpers/logger.js';

function channelEvent(body: string, meta: Record<string, string> = {}) {
  return { content: body, meta: { kind: 'chat', from: 'director', ...meta } };
}

describe('ClaudeMessageQueue', () => {
  it('yields pushed messages in order and ends on close', async () => {
    const queue = new ClaudeMessageQueue();
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const msg of queue.stream()) {
        seen.push(msg.message.content as string);
      }
    })();
    queue.push({
      type: 'user',
      message: { role: 'user', content: 'one' },
      parent_tool_use_id: null,
    });
    queue.push({
      type: 'user',
      message: { role: 'user', content: 'two' },
      parent_tool_use_id: null,
    });
    // Let the consumer drain, then close.
    await new Promise((r) => setTimeout(r, 10));
    queue.close();
    await consumer;
    expect(seen).toEqual(['one', 'two']);
  });

  it('rejects pushes after close', () => {
    const queue = new ClaudeMessageQueue();
    queue.close();
    const accepted = queue.push({
      type: 'user',
      message: { role: 'user', content: 'late' },
      parent_tool_use_id: null,
    });
    expect(accepted).toBe(false);
    expect(queue.depth).toBe(0);
  });
});

describe('createClaudeChannelSink', () => {
  it('bundles a burst into one user message', async () => {
    const queue = new ClaudeMessageQueue();
    const sink = createClaudeChannelSink({
      getQueue: () => queue,
      log: silentLogger(),
      bundleWindowMs: 20,
    });
    await sink.deliver(channelEvent('first event'));
    await sink.deliver(channelEvent('second event'));
    expect(queue.depth).toBe(0); // still inside the bundle window
    await new Promise((r) => setTimeout(r, 60));
    expect(queue.depth).toBe(1);

    const iter = queue.stream();
    queue.close();
    const first = await iter.next();
    expect(first.done).toBe(false);
    const content = first.value?.message.content as string;
    expect(content).toContain('first event');
    expect(content).toContain('second event');
    expect(content).toContain('<channel kind="chat" from="director"');
    expect(content).toContain('</channel>');
  });

  it('flushNow drains the buffer without waiting for the window', async () => {
    const queue = new ClaudeMessageQueue();
    const sink = createClaudeChannelSink({
      getQueue: () => queue,
      log: silentLogger(),
      bundleWindowMs: 5_000,
    });
    await sink.deliver(channelEvent('urgent'));
    expect(queue.depth).toBe(0);
    sink.flushNow();
    expect(queue.depth).toBe(1);
  });

  it('classifies a prose capacity failure locally and defers its accepted mail', async () => {
    const queue = new ClaudeMessageQueue();
    const frames: RunnerControlFrame[] = [];
    const settle = vi.fn();
    const accepted = vi.fn();
    const sink = createClaudeChannelSink({
      getQueue: () => queue,
      log: silentLogger(),
      bundleWindowMs: 5_000,
    });
    sink.attachControl?.((frame) => frames.push(frame));
    await sink.deliver(channelEvent('please act'), {
      messageId: 'message-1',
      accepted,
      settle,
    });
    sink.flushNow();
    const iter = queue.stream();
    await iter.next();
    expect(accepted).toHaveBeenCalledOnce();

    sink.observe({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Selected model is at capacity: raw-secret-fragment' }],
      },
    } as never);

    expect(frames).toContainEqual({
      kind: 'runner_condition',
      at: expect.any(Number),
      state: 'degraded',
      reason: { code: 'server_overloaded', detail: 'model service is overloaded' },
    });
    expect(JSON.stringify(frames)).not.toContain('raw-secret-fragment');
    expect(settle).toHaveBeenCalledWith('deferred', expect.any(Object));
    queue.close();
  });

  it('uses the SDK model_not_found condition from a captured invalid-model turn', async () => {
    const queue = new ClaudeMessageQueue();
    const frames: RunnerControlFrame[] = [];
    const settle = vi.fn();
    const sink = createClaudeChannelSink({
      getQueue: () => queue,
      log: silentLogger(),
      bundleWindowMs: 5_000,
    });
    sink.attachControl?.((frame) => frames.push(frame));
    await sink.deliver(channelEvent('call a tool'), {
      messageId: 'invalid-model-message',
      accepted: vi.fn(),
      settle,
    });
    sink.flushNow();
    const iter = queue.stream();
    await iter.next();

    // Captured from `--model claude-definitely-not-a-model`. The prose is
    // deliberately not one the legacy matcher recognises; the typed SDK
    // error is the control fact and the vendor wording is only display text.
    sink.observe({
      type: 'assistant',
      isApiErrorMessage: true,
      error: 'model_not_found',
      message: {
        model: '<synthetic>',
        content: [
          {
            type: 'text',
            text: "There's an issue with the selected model (claude-definitely-not-a-model). It may not exist or you may not have access to it.",
          },
        ],
      },
    } as never);

    expect(frames).toContainEqual({
      kind: 'runner_condition',
      at: expect.any(Number),
      state: 'degraded',
      reason: { code: 'invalid_model', detail: 'configured model id is invalid' },
    });
    expect(JSON.stringify(frames)).not.toContain('claude-definitely-not-a-model');
    expect(settle).toHaveBeenCalledWith('deferred', expect.any(Object));
    queue.close();
  });

  it('degrades an unacted zero-cost turn when vendor naming is absent', async () => {
    const queue = new ClaudeMessageQueue();
    const frames: RunnerControlFrame[] = [];
    const settle = vi.fn();
    const sink = createClaudeChannelSink({
      getQueue: () => queue,
      log: silentLogger(),
      bundleWindowMs: 5_000,
    });
    sink.attachControl?.((frame) => frames.push(frame));
    await sink.deliver(channelEvent('call a tool'), {
      messageId: 'unnamed-failure',
      accepted: vi.fn(),
      settle,
    });
    sink.flushNow();
    const iter = queue.stream();
    await iter.next();

    // No assistant error or recognisable prose: our terminal facts decide.
    sink.observe({
      type: 'result',
      subtype: 'success',
      // Above the old one-second bound: measured credit exhaustion reaches
      // 1.45s and must not become a false negative.
      duration_ms: 1_450,
      total_cost_usd: 0,
    } as never);

    expect(frames).toContainEqual({
      kind: 'runner_turn',
      at: expect.any(Number),
      turnId: expect.any(String),
      phase: 'completed',
      outcome: 'failed',
    });
    expect(frames).toContainEqual({
      kind: 'runner_condition',
      at: expect.any(Number),
      state: 'degraded',
      reason: { code: 'unknown', detail: 'runner cannot complete turns' },
    });
    expect(settle).toHaveBeenCalledWith('deferred', expect.any(Object));
    queue.close();
  });

  it('does not degrade a healthy prose-only turn that incurred model cost', async () => {
    const queue = new ClaudeMessageQueue();
    const frames: RunnerControlFrame[] = [];
    const settle = vi.fn();
    const sink = createClaudeChannelSink({
      getQueue: () => queue,
      log: silentLogger(),
      bundleWindowMs: 5_000,
    });
    sink.attachControl?.((frame) => frames.push(frame));
    await sink.deliver(channelEvent('answer without a tool'), {
      messageId: 'healthy-no-action',
      accepted: vi.fn(),
      settle,
    });
    sink.flushNow();
    const iter = queue.stream();
    await iter.next();
    sink.observe({
      type: 'result',
      subtype: 'success',
      duration_ms: 400,
      total_cost_usd: 0.001,
    } as never);

    expect(frames).toContainEqual({
      kind: 'runner_turn',
      at: expect.any(Number),
      turnId: expect.any(String),
      phase: 'completed',
      outcome: 'no_action',
    });
    expect(frames).not.toContainEqual(
      expect.objectContaining({ kind: 'runner_condition', state: 'degraded' }),
    );
    expect(settle).toHaveBeenCalledWith('handled');
    queue.close();
  });

  it('degrades on an unrecognised structured Claude error instead of dropping it', async () => {
    const queue = new ClaudeMessageQueue();
    const frames: RunnerControlFrame[] = [];
    const sink = createClaudeChannelSink({
      getQueue: () => queue,
      log: silentLogger(),
      bundleWindowMs: 5_000,
    });
    sink.attachControl?.((frame) => frames.push(frame));
    await sink.deliver(channelEvent('please act'));
    sink.flushNow();
    const iter = queue.stream();
    await iter.next();
    sink.observe({
      type: 'assistant',
      error: 'future_vendor_error',
      message: { content: [{ type: 'text', text: 'wording can change' }] },
    } as never);

    expect(frames).toContainEqual({
      kind: 'runner_condition',
      at: expect.any(Number),
      state: 'degraded',
      reason: { code: 'unknown', detail: 'runner cannot complete turns' },
    });
    queue.close();
  });
});
