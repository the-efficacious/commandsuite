import type { Message } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { channelThreadTag, GENERAL_CHANNEL_ID, InMemoryEventLog } from '../src/index.js';

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm',
    ts: 1,
    to: null,
    from: 'alice',
    title: null,
    body: 'hi',
    level: 'info',
    data: {},
    attachments: [],
    ...over,
  };
}

describe('InMemoryEventLog channel filter', () => {
  it('returns only messages tagged for the requested channel', async () => {
    const log = new InMemoryEventLog();
    await log.append(msg({ id: 'a', ts: 1, data: { thread: channelThreadTag('abc-123') } }));
    await log.append(msg({ id: 'b', ts: 2, data: { thread: channelThreadTag('xyz') } }));
    await log.append(msg({ id: 'c', ts: 3 })); // untagged broadcast

    const out = await log.query({ viewer: 'alice', channel: 'abc-123' });
    expect(out.map((m) => m.id)).toEqual(['a']);
  });

  it('general includes untagged broadcasts', async () => {
    const log = new InMemoryEventLog();
    await log.append(msg({ id: 'a', ts: 1, to: null })); // untagged broadcast
    await log.append(
      msg({ id: 'b', ts: 2, data: { thread: channelThreadTag(GENERAL_CHANNEL_ID) } }),
    );
    await log.append(msg({ id: 'c', ts: 3, data: { thread: channelThreadTag('other') } }));
    await log.append(msg({ id: 'd', ts: 4, to: 'alice', from: 'bob' })); // DM, not broadcast

    const out = await log.query({ viewer: 'alice', channel: GENERAL_CHANNEL_ID });
    expect(out.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('returns empty for unknown channel', async () => {
    const log = new InMemoryEventLog();
    await log.append(msg({ id: 'a', ts: 1 }));
    const out = await log.query({ viewer: 'alice', channel: 'nonexistent' });
    expect(out).toEqual([]);
  });
});
