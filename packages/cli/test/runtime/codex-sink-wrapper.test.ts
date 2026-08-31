import type { RunnerControlFrame } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createCodexSinkWrapper } from '../../src/runtime/agents/codex/codex-agent.js';
import type { ChannelEventSink } from '../../src/runtime/forwarder.js';

describe('codex cold-start sink wrapper', () => {
  it('advertises control support and forwards it to every live sink generation', () => {
    const wrapper = createCodexSinkWrapper();
    const transmitted: RunnerControlFrame[] = [];

    // This method's presence is the reliable-subscription handshake signal.
    // The old deliver-only wrapper failed here and advertised no liveness
    // protocol, leaving a broken Codex seat honestly `unreported` forever.
    expect(wrapper.sink.attachControl).toBeTypeOf('function');
    wrapper.sink.attachControl?.((frame) => transmitted.push(frame));

    let firstEmitter: ((frame: RunnerControlFrame) => void) | undefined;
    const first: ChannelEventSink = {
      deliver: vi.fn(),
      attachControl(send) {
        firstEmitter = send;
      },
    };
    wrapper.attach(first);
    expect(firstEmitter).toBeTypeOf('function');

    const degraded: RunnerControlFrame = {
      kind: 'runner_condition',
      at: 1,
      state: 'degraded',
      reason: { code: 'invalid_model', detail: 'configured model is unavailable' },
    };
    firstEmitter?.(degraded);
    expect(transmitted).toEqual([degraded]);

    // A respawn replaces the app-server sink. The subscription-side sender
    // survives that swap and must be attached to the successor as well.
    wrapper.detach();
    let secondEmitter: ((frame: RunnerControlFrame) => void) | undefined;
    wrapper.attach({
      deliver: vi.fn(),
      attachControl(send) {
        secondEmitter = send;
      },
    });
    expect(secondEmitter).toBeTypeOf('function');
    secondEmitter?.({ kind: 'runner_condition', at: 2, state: 'ready' });
    expect(transmitted).toEqual([degraded, { kind: 'runner_condition', at: 2, state: 'ready' }]);
  });

  it('retains cold-start messages until a live sink is attached', async () => {
    const wrapper = createCodexSinkWrapper();
    const event = { content: 'retained', meta: { id: 'message-1' } };
    await wrapper.sink.deliver(event);

    expect(wrapper.attach({ deliver: vi.fn() })).toEqual([event]);
  });
});
