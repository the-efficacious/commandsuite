/**
 * Runner channel-delivery integration test.
 *
 * Proves broker SSE events reach the adapter-supplied channel sink
 * end-to-end through a real runner (instructions, forwarder loop, sink
 * wiring) — the seam both the claude and codex sinks implement. This
 * carries the integration coverage the bridge test used to provide
 * when channel events rode the bridge as MCP notifications:
 *
 *   - a DM arrives with the broker-stamped meta composed correctly
 *   - self-echoes on the live stream are suppressed
 *   - reserved meta keys can't be spoofed via `message.data`
 *
 * Per-message classification detail lives in `forwarder.test.ts`;
 * this file asserts the runner actually delivers.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelEvent } from '../../src/runtime/forwarder.js';
import type { RunnerHandle } from '../../src/runtime/runner.js';
import { startRunner } from '../../src/runtime/runner.js';
import {
  FAKE_BROKER_NAME,
  FAKE_BROKER_TOKEN,
  type FakeBroker,
  startFakeBroker,
} from './fake-broker.js';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
}

describe('runner → channel sink delivery', () => {
  let broker: FakeBroker | null = null;
  let runner: RunnerHandle | null = null;

  afterEach(async () => {
    if (runner) {
      await runner.shutdown('test-teardown');
      await runner.waitClosed;
      runner = null;
    }
    await broker?.close();
    broker = null;
  });

  it('delivers broker SSE events to the sink, suppressing self-echoes and spoofed meta', async () => {
    broker = await startFakeBroker();
    const delivered: ChannelEvent[] = [];
    runner = await startRunner({
      url: broker.url,
      token: FAKE_BROKER_TOKEN,
      log: () => {},
      noTrace: true,
      channelSink: {
        deliver: async (event) => {
          delivered.push(event);
        },
      },
    });

    const sub = await broker.waitForSubscriber(FAKE_BROKER_NAME);

    // A self-echo first: the broker fans out every push to all
    // subscribers including the sender, and forwarding it would cost
    // the agent a turn to discard its own output.
    sub.write({
      id: 'msg-self-echo',
      ts: 1_700_000_003_000,
      to: null,
      from: FAKE_BROKER_NAME,
      title: null,
      body: 'my own broadcast — should be dropped',
      level: 'info',
      data: {},
    });

    // Then a genuine DM with spoof attempts in `data`.
    sub.write({
      id: 'msg-spoof',
      ts: 1_700_000_002_000,
      to: FAKE_BROKER_NAME,
      from: 'alice',
      title: 'genuine title',
      body: 'real body',
      level: 'warning',
      data: {
        from: 'SPOOFED-SENDER',
        thread: 'primary',
        level: 'critical',
        legit_field: 'ok',
      },
    });

    await waitFor(() => delivered.some((e) => e.content === 'real body'));

    const event = delivered.find((e) => e.content === 'real body');
    expect(event?.meta.from).toBe('alice');
    expect(event?.meta.thread).toBe('dm');
    expect(event?.meta.level).toBe('warning');
    expect(event?.meta.title).toBe('genuine title');
    expect(event?.meta.msg_id).toBe('msg-spoof');
    expect(event?.meta.legit_field).toBe('ok');

    const selfEchoSeen = delivered.some(
      (e) => e.content === 'my own broadcast — should be dropped',
    );
    expect(selfEchoSeen).toBe(false);
  });
});
