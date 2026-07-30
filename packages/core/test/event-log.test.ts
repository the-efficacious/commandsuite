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

describe('InMemoryEventLog secret-event scoping', () => {
  // Secret lifecycle events are pushed to an explicit recipient set —
  // the bound members plus every `secrets.manage` holder — but a
  // fan-out push persists `to: null`, and the default feed returns
  // every `to: null` row to every viewer. So delivery was private and
  // readback was not.
  //
  // Measured on the live broker before this fix: 27 of 27 secret
  // events were returned to a member who was neither bound to any of
  // them nor held `secrets.manage`. The leaked body carries the slug,
  // the env var name, and who the secret was bound to.

  it('keeps secret events out of the default feed', async () => {
    const log = new InMemoryEventLog();
    await log.append(
      msg({ id: 's', ts: 1, from: 'admin', data: { thread: 'secret:deploy-key', kind: 'secret' } }),
    );
    const seen = await log.query({ viewer: 'outsider' });
    expect(seen.map((m) => m.id)).toEqual([]);
  });

  it('hides them from the actor too, not just from non-recipients', async () => {
    // The actor's own feed is the one that produced the complaint, so
    // an exception for `from === viewer` would leave the noise exactly
    // where it was noticed.
    const log = new InMemoryEventLog();
    await log.append(msg({ id: 's', ts: 1, from: 'admin', data: { thread: 'secret:deploy-key' } }));
    expect(await log.query({ viewer: 'admin' })).toEqual([]);
  });

  it('does not swallow anything else — the feed still works', async () => {
    // Absence tests need a control that proves the query can see rows
    // at all, or "empty" means nothing.
    const log = new InMemoryEventLog();
    await log.append(msg({ id: 'broadcast', ts: 1 }));
    await log.append(msg({ id: 'dm', ts: 2, from: 'bob', to: 'outsider' }));
    await log.append(msg({ id: 'chan', ts: 3, data: { thread: channelThreadTag('abc') } }));
    await log.append(msg({ id: 'obj', ts: 4, data: { thread: 'obj:obj-123' } }));
    await log.append(msg({ id: 'secret', ts: 5, data: { thread: 'secret:deploy-key' } }));

    const seen = await log.query({ viewer: 'outsider' });
    expect(seen.map((m) => m.id).sort()).toEqual(['broadcast', 'chan', 'dm', 'obj']);
  });

  it('matches on the prefix, not on an exact tag', async () => {
    // Every secret has its own slug, so a test pinned to one tag would
    // pass while every other secret still leaked.
    const log = new InMemoryEventLog();
    for (const [i, slug] of ['a', 'deploy-key', 'cora-github-token'].entries()) {
      await log.append(msg({ id: `s${i}`, ts: i + 1, data: { thread: `secret:${slug}` } }));
    }
    expect(await log.query({ viewer: 'outsider' })).toEqual([]);
  });

  it('leaves a thread merely containing "secret:" alone', async () => {
    // The rule is a prefix, and a channel that happens to mention the
    // word is not a secret event.
    const log = new InMemoryEventLog();
    await log.append(msg({ id: 'c', ts: 1, data: { thread: 'chan:top-secret:stuff' } }));
    expect((await log.query({ viewer: 'outsider' })).map((m) => m.id)).toEqual(['c']);
  });
});
