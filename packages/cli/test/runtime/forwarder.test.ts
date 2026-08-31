/**
 * Forwarder routing tests.
 *
 * The forwarder reads broker SSE messages and delivers each one as a
 * typed `ChannelEvent` (content + structured meta) to the runner's
 * channel sink. The classification of `meta.thread` is the agent's
 * only clue about whether a message is a DM, a team broadcast, or a
 * post into a named channel — get that wrong and channel posts arrive
 * at the agent indistinguishable from DMs.
 *
 * We exercise `forwardMessage` indirectly by driving `runForwarder`
 * with a fake broker stream + a capturing channel sink.
 */

import type { Client as BrokerClient } from 'csuite-sdk/client';
import type { Message, MessageDispositionFrame, RunnerControlFrame } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { runForwarder } from '../../src/runtime/forwarder.js';
import { silentLogger } from '../helpers/logger.js';

interface CapturedEvent {
  content: string;
  meta: Record<string, string>;
}

function makeBrokerClient(
  messages: Message[],
  channels: Array<{ id: string; slug: string }> = [],
): {
  client: BrokerClient;
} {
  const subscribe = (_name: string, signal: AbortSignal): AsyncIterable<Message> => {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const m of messages) {
          if (signal.aborted) return;
          yield m;
        }
        // After yielding all fixtures, wait until aborted so the
        // forwarder's reconnect loop doesn't spin.
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
  };
  const listChannels = async (): Promise<Array<{ id: string; slug: string }>> => channels;
  return {
    client: { subscribe, listChannels } as unknown as BrokerClient,
  };
}

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'msg-1',
    ts: 1_700_000_000_000,
    to: null,
    from: 'someone-else',
    title: null,
    body: 'hi',
    level: 'info',
    data: {},
    attachments: [],
    ...overrides,
  };
}

async function captureNotifications(
  messages: Message[],
  selfName = 'me',
  channels: Array<{ id: string; slug: string }> = [],
): Promise<CapturedEvent[]> {
  const captured: CapturedEvent[] = [];
  const { client } = makeBrokerClient(messages, channels);
  const ctrl = new AbortController();
  const sink = {
    deliver: async (event: CapturedEvent) => {
      captured.push(event);
      // Stop after the last fixture has been forwarded so the test
      // doesn't hang.
      if (captured.length === messages.filter((m) => m.from !== selfName).length) {
        // Microtask delay so the forwarder finishes its loop body
        // before we abort.
        queueMicrotask(() => ctrl.abort());
      }
    },
  };
  await runForwarder({
    sink,
    brokerClient: client,
    name: selfName,
    signal: ctrl.signal,
    logger: silentLogger(),
  });
  return captured;
}

describe('forwarder thread classification', () => {
  it('re-accepts a held receipt on the subscription generation that settles it', async () => {
    vi.useFakeTimers();
    try {
      const ctrl = new AbortController();
      const dispositions: MessageDispositionFrame[][] = [[], []];
      const controls: RunnerControlFrame[][] = [[], []];
      let subscriptions = 0;
      let heldReceipt: Parameters<
        NonNullable<Parameters<typeof runForwarder>[0]['sink']['deliver']>
      >[1];
      let secondReady!: () => void;
      const secondSubscribed = new Promise<void>((resolve) => {
        secondReady = resolve;
      });
      const subscribeReliable = vi.fn((_name: string, signal: AbortSignal) => {
        const generation = subscriptions++;
        const iterable: AsyncIterable<Message> = {
          [Symbol.asyncIterator]: async function* () {
            if (generation === 0) {
              yield makeMessage({ id: 'across-reconnect', to: 'me' });
              return;
            }
            secondReady();
            await new Promise<void>((resolve) => {
              if (signal.aborted) return resolve();
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        };
        return Object.assign(iterable, {
          disposition(frame: MessageDispositionFrame) {
            dispositions[generation]?.push(frame);
          },
          control(frame: RunnerControlFrame) {
            controls[generation]?.push(frame);
          },
        });
      });
      const running = runForwarder({
        sink: {
          async deliver(_event, receipt) {
            if (heldReceipt === undefined) {
              heldReceipt = receipt;
              receipt?.accepted();
            }
          },
          attachControl: vi.fn(),
        },
        brokerClient: {
          subscribeReliable,
          listChannels: vi.fn().mockResolvedValue([]),
        } as unknown as BrokerClient,
        name: 'me',
        signal: ctrl.signal,
        runnerIdentity: {
          runner: 'codex',
          modelId: null,
          runnerVersion: 'test',
          runnerBuildSource: 'main',
        },
        logger: silentLogger(),
      });

      for (let i = 0; i < 5 && heldReceipt === undefined; i += 1) await Promise.resolve();
      expect(heldReceipt).toBeDefined();
      expect(dispositions[0]?.map((frame) => frame.disposition)).toEqual(['accepted']);

      await vi.advanceTimersByTimeAsync(1_000);
      await secondSubscribed;
      heldReceipt?.settle('acted', { evidence: { kind: 'tool_call' } });

      expect(dispositions[1]?.map((frame) => frame.disposition)).toEqual(['accepted', 'acted']);
      expect(dispositions[0]?.map((frame) => frame.disposition)).toEqual(['accepted']);
      ctrl.abort();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns without subscribing when the lifecycle gate rejects', async () => {
    const subscribe = vi.fn();
    await expect(
      runForwarder({
        sink: { deliver: vi.fn() },
        brokerClient: { subscribe } as unknown as BrokerClient,
        name: 'me',
        signal: new AbortController().signal,
        subscriptionGate: Promise.reject(new Error('session_start could not be delivered')),
        logger: silentLogger(),
      }),
    ).resolves.toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();
  });
  it('marks broadcasts to general as thread=primary', async () => {
    const captured = await captureNotifications([
      makeMessage({ id: 'm-broadcast', to: null, from: 'director' }),
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.meta.thread).toBe('primary');
    expect(captured[0]?.meta.channel).toBeUndefined();
    expect(captured[0]?.meta.target).toBeUndefined();
  });

  it('marks targeted DMs as thread=dm with target=<recipient>', async () => {
    const captured = await captureNotifications([
      makeMessage({ id: 'm-dm', to: 'me', from: 'director' }),
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.meta.thread).toBe('dm');
    expect(captured[0]?.meta.target).toBe('me');
    expect(captured[0]?.meta.channel).toBeUndefined();
  });

  it('marks channel posts as thread=channel with channel=<id> (regression)', async () => {
    // Per-recipient broker fanout: `to` is stamped with my name even
    // though it's a channel post, because the broker pushes one copy
    // per channel member. Without the channel-detection branch this
    // would misclassify as `dm`.
    const captured = await captureNotifications([
      makeMessage({
        id: 'm-chan',
        to: 'me',
        from: 'director',
        data: { thread: 'chan:eng-id-123' },
      }),
    ]);
    expect(captured).toHaveLength(1);
    const meta = captured[0]?.meta;
    expect(meta?.thread).toBe('channel');
    expect(meta?.channel).toBe('eng-id-123');
    // No `target` for channel posts — the per-recipient `to` stamp
    // would mislead the agent into thinking it was DMed.
    expect(meta?.target).toBeUndefined();
  });

  it('adds channel_slug when the id resolves via listChannels', async () => {
    const captured = await captureNotifications(
      [
        makeMessage({
          id: 'm-chan-slug',
          to: 'me',
          from: 'director',
          data: { thread: 'chan:eng-id-123' },
        }),
      ],
      'me',
      [{ id: 'eng-id-123', slug: 'engineering' }],
    );
    const meta = captured[0]?.meta;
    expect(meta?.thread).toBe('channel');
    expect(meta?.channel).toBe('eng-id-123');
    expect(meta?.channel_slug).toBe('engineering');
  });

  it('omits channel_slug (but keeps the id) when resolution fails', async () => {
    const captured = await captureNotifications(
      [
        makeMessage({
          id: 'm-chan-unknown',
          to: 'me',
          from: 'director',
          data: { thread: 'chan:ghost-id' },
        }),
      ],
      'me',
      [{ id: 'other-id', slug: 'other' }],
    );
    const meta = captured[0]?.meta;
    expect(meta?.channel).toBe('ghost-id');
    expect(meta?.channel_slug).toBeUndefined();
  });

  it('does not let a sender spoof channel or channel_slug via data', async () => {
    // Regression: `channel` was not in RESERVED_META_KEYS, so a DM
    // with `data.channel` set would overwrite the (absent) authoritative
    // channel meta and masquerade as a channel post.
    const captured = await captureNotifications([
      makeMessage({
        id: 'm-chan-spoof',
        to: 'me',
        from: 'attacker',
        data: { channel: 'FAKE-ID', channel_slug: 'fake-slug' },
      }),
    ]);
    const meta = captured[0]?.meta;
    expect(meta?.thread).toBe('dm');
    expect(meta?.channel).toBeUndefined();
    expect(meta?.channel_slug).toBeUndefined();
  });

  it('treats chan:general specially (falls through to primary)', async () => {
    // The general channel is the implicit-broadcast channel; messages
    // tagged `chan:general` should report as `primary`, not `channel`,
    // matching the broker's own special-casing.
    const captured = await captureNotifications([
      makeMessage({
        id: 'm-gen',
        to: null,
        from: 'director',
        data: { thread: 'chan:general' },
      }),
    ]);
    expect(captured[0]?.meta.thread).toBe('primary');
    expect(captured[0]?.meta.channel).toBeUndefined();
  });

  it('does not let a sender override `thread` via data spoofing', async () => {
    // Reserved-keys filter: even if a malicious payload sets
    // `data.thread = 'primary'` on what is actually a DM, the
    // forwarder's authoritative classification wins.
    const captured = await captureNotifications([
      makeMessage({
        id: 'm-dm-spoof',
        to: 'me',
        from: 'attacker',
        data: { thread: 'primary' }, // not chan:* — straight spoof attempt
      }),
    ]);
    expect(captured[0]?.meta.thread).toBe('dm');
  });

  it('drops self-echoes', async () => {
    const captured = await captureNotifications([
      makeMessage({ id: 'm-self', from: 'me', to: null }),
      makeMessage({ id: 'm-other', from: 'director', to: null }),
    ]);
    expect(captured.map((c) => c.meta.msg_id)).toEqual(['m-other']);
  });
});

describe('forwarder data passthrough', () => {
  it('forwards arbitrary data keys as flat string meta', async () => {
    const captured = await captureNotifications([
      makeMessage({
        from: 'director',
        data: {
          kind: 'announcement',
          urgency: 7,
          actionable: true,
        },
      }),
    ]);
    const meta = captured[0]?.meta;
    expect(meta?.kind).toBe('announcement');
    expect(meta?.urgency).toBe('7');
    expect(meta?.actionable).toBe('true');
  });

  it('drops complex (object/array) data values', async () => {
    const captured = await captureNotifications([
      makeMessage({
        from: 'director',
        data: { nested: { foo: 'bar' }, list: [1, 2, 3] },
      }),
    ]);
    const meta = captured[0]?.meta;
    expect(meta?.nested).toBeUndefined();
    expect(meta?.list).toBeUndefined();
  });

  it('sanitizes meta keys with non-identifier characters', async () => {
    const captured = await captureNotifications([
      makeMessage({ from: 'director', data: { 'kind-of': 'announcement' } }),
    ]);
    expect(captured[0]?.meta.kind_of).toBe('announcement');
  });
});
