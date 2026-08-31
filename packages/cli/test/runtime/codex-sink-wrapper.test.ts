import type { RunnerControlFrame } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createCodexSinkWrapper } from '../../src/runtime/agents/codex/codex-agent.js';
import type { ChannelDeliveryReceipt, ChannelEventSink } from '../../src/runtime/forwarder.js';

function receipt(): ChannelDeliveryReceipt {
  return {
    messageId: 'message-1',
    accepted: vi.fn(),
    settle: vi.fn(),
  };
}

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

  it('forwards the receipt on live delivery so acted mail can settle', async () => {
    const wrapper = createCodexSinkWrapper();
    const delivered = vi.fn<ChannelEventSink['deliver']>(async (_event, delivery) => {
      delivery?.settle('acted');
    });
    wrapper.attach({ deliver: delivered });
    const delivery = receipt();

    await wrapper.sink.deliver({ content: 'live', meta: {} }, delivery);

    expect(delivered).toHaveBeenCalledWith({ content: 'live', meta: {} }, delivery);
    expect(delivery.settle).toHaveBeenCalledWith('acted');
  });

  it('retains cold-start messages with their receipt until a live sink is attached', async () => {
    const wrapper = createCodexSinkWrapper();
    const event = { content: 'retained', meta: { id: 'message-1' } };
    const delivery = receipt();
    await wrapper.sink.deliver(event, delivery);

    const live: ChannelEventSink = {
      async deliver(_event, queuedReceipt) {
        queuedReceipt?.settle('handled');
      },
    };
    const drain = wrapper.attach(live);
    expect(drain).toEqual([{ event, receipt: delivery }]);
    for (const queued of drain) await live.deliver(queued.event, queued.receipt);
    expect(delivery.settle).toHaveBeenCalledWith('handled');
  });

  it('forwards a control sender that arrives after the live sink', () => {
    const wrapper = createCodexSinkWrapper();
    let liveEmitter: ((frame: RunnerControlFrame) => void) | undefined;
    wrapper.attach({
      deliver: vi.fn(),
      attachControl(send) {
        liveEmitter = send;
      },
    });
    expect(liveEmitter).toBeUndefined();

    const transmitted: RunnerControlFrame[] = [];
    wrapper.sink.attachControl?.((frame) => transmitted.push(frame));
    expect(liveEmitter).toBeTypeOf('function');
    liveEmitter?.({ kind: 'runner_condition', at: 3, state: 'ready' });
    expect(transmitted).toEqual([{ kind: 'runner_condition', at: 3, state: 'ready' }]);
  });
});
