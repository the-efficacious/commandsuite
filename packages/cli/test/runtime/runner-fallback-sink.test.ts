import { describe, expect, it, vi } from 'vitest';
import { createFallbackChannelSink } from '../../src/runtime/runner.js';
import { recordingLogger } from '../helpers/logger.js';

describe('runner fallback channel sink', () => {
  it('explicitly refuses mail it cannot deliver', async () => {
    const rec = recordingLogger();
    const settle = vi.fn();
    const sink = createFallbackChannelSink(rec.logger);

    await sink.deliver(
      { content: 'cannot reach an agent', meta: { kind: 'chat', from: 'sender' } },
      { messageId: 'message-1', accepted: vi.fn(), settle },
    );

    expect(settle).toHaveBeenCalledWith('refused', {
      reason: { code: 'unsupported', detail: 'runner has no channel sink' },
    });
    expect(rec.messages()).toContain('channel event refused (no channel sink attached)');
  });
});
