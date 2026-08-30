/**
 * Stub adapter behavior — the pieces the conformance kit exempts
 * (ambient event delivery is per-runner) plus the visibility contract:
 * the canned turn goes only to addressed DMs, once each, serialized
 * through the injected bridge, and every self-identification surface
 * names the stub as a test/CI instrument.
 */

import { describe, expect, it } from 'vitest';
import {
  cannedReply,
  createStubAdapter,
  isAddressedDm,
  STUB_META,
  type StubBridge,
  StubProcess,
  StubSink,
} from '../../src/runtime/agents/stub-agent.js';
import type { ChannelEvent } from '../../src/runtime/forwarder.js';
import { silentLogger } from '../helpers/logger.js';

function dm(from: string, target?: string): ChannelEvent {
  return {
    content: `<channel thread="dm" from="${from}">hello</channel>`,
    meta: { thread: 'dm', from, ...(target !== undefined ? { target } : {}) },
  };
}

function recordingBridge(): { bridge: StubBridge; sent: Array<{ to: string; body: string }> } {
  const sent: Array<{ to: string; body: string }> = [];
  return {
    sent,
    bridge: {
      send: async (to, body) => {
        sent.push({ to, body });
      },
      close: async () => {},
    },
  };
}

describe('stub addressing', () => {
  it('only a dm thread addressed to the member counts', () => {
    expect(isAddressedDm(dm('admin', 'stubby'), 'stubby')).toBe(true);
    expect(isAddressedDm(dm('admin'), 'stubby')).toBe(true);
    expect(isAddressedDm(dm('admin', 'someone-else'), 'stubby')).toBe(false);
    expect(
      isAddressedDm({ content: 'x', meta: { thread: 'primary', from: 'admin' } }, 'stubby'),
    ).toBe(false);
  });
});

describe('stub canned turn', () => {
  it('answers each addressed DM once, to the sender, self-identifying', async () => {
    const { bridge, sent } = recordingBridge();
    const proc = new StubProcess(bridge, 'stubby', silentLogger());

    proc.deliver(dm('admin', 'stubby'));
    proc.deliver(dm('lea', 'stubby'));
    proc.deliver({ content: 'x', meta: { thread: 'channel', from: 'admin' } });
    proc.deliver(dm('stubby', 'stubby')); // own echo — never answered
    await proc.shutdown(); // drains the reply chain

    expect(sent.map((s) => s.to)).toEqual(['admin', 'lea']);
    for (const s of sent) {
      expect(s.body).toContain('stub runner');
      expect(s.body).toContain('CI test instrument');
      expect(s.body).toContain("stubby's");
    }
    expect(await proc.exitCode).toBe(0);
  });

  it('a closed generation answers nothing (positive control above)', async () => {
    const { bridge, sent } = recordingBridge();
    const proc = new StubProcess(bridge, 'stubby', silentLogger());
    await proc.shutdown();
    proc.deliver(dm('admin', 'stubby'));
    expect(sent).toEqual([]);
  });
});

describe('stub sink buffering', () => {
  it('buffers while detached and replays to the next generation', async () => {
    const sink = new StubSink();
    await sink.deliver(dm('admin', 'stubby')); // no generation yet — buffered
    const { bridge, sent } = recordingBridge();
    const proc = new StubProcess(bridge, 'stubby', silentLogger());
    sink.attach(proc);
    await proc.shutdown();
    expect(sent.map((s) => s.to)).toEqual(['admin']);

    sink.detach();
    await sink.deliver(dm('lea', 'stubby')); // mid-restart — buffered, not lost
    const second = recordingBridge();
    const next = new StubProcess(second.bridge, 'stubby', silentLogger());
    sink.attach(next);
    await next.shutdown();
    expect(second.sent.map((s) => s.to)).toEqual(['lea']);
  });
});

describe('stub visibility contract', () => {
  it('meta, doctor, and canned reply all name the instrument', async () => {
    expect(STUB_META.id).toBe('stub');
    expect(STUB_META.displayName).toContain('CI instrument');
    const checks = await createStubAdapter().doctor?.();
    const instrument = checks?.find((c) => c.name === 'stub instrument');
    expect(instrument?.status).toBe('WARN');
    expect(instrument?.detail).toContain('test/CI instrument');
    expect(instrument?.detail).toContain('never deploy');
    expect(cannedReply('x')).toContain('csuite stub');
  });
});
