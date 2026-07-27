/**
 * Claude channel sink + message queue unit tests.
 *
 * The sink is the claude runner's `ForwarderNotificationSink`: broker
 * channel events render as `<channel>` blocks, bundle within a window,
 * and land on the streaming-input queue as single user messages. The
 * queue is the async generator the Agent SDK consumes.
 */

import { MCP_CHANNEL_NOTIFICATION } from 'csuite-sdk/protocol';
import { describe, expect, it } from 'vitest';
import {
  ClaudeMessageQueue,
  createClaudeChannelSink,
} from '../../src/runtime/agents/claude-sink.js';

const noopLog = (): void => {};

function channelArgs(body: string, meta: Record<string, string> = {}) {
  return {
    method: MCP_CHANNEL_NOTIFICATION,
    params: { content: body, meta: { kind: 'chat', from: 'director', ...meta } },
  };
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
    const sink = createClaudeChannelSink({ queue, log: noopLog, bundleWindowMs: 20 });
    await sink.notification(channelArgs('first event'));
    await sink.notification(channelArgs('second event'));
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
    const sink = createClaudeChannelSink({ queue, log: noopLog, bundleWindowMs: 5_000 });
    await sink.notification(channelArgs('urgent'));
    expect(queue.depth).toBe(0);
    sink.flushNow();
    expect(queue.depth).toBe(1);
  });

  it('ignores non-channel notifications', async () => {
    const queue = new ClaudeMessageQueue();
    const sink = createClaudeChannelSink({ queue, log: noopLog, bundleWindowMs: 5 });
    await sink.notification({ method: 'notifications/tools/list_changed', params: {} });
    sink.flushNow();
    expect(queue.depth).toBe(0);
  });
});
