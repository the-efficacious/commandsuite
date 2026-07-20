/**
 * Pure-logic tests for the messages signal store.
 */

import type { Message } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetMessagesForTests,
  appendMessages,
  PRIMARY_THREAD,
  prependMessages,
  threadKeyOf,
  threadKeys,
  threadMessages,
} from '../src/lib/messages.js';

function msg(overrides: Partial<Message>): Message {
  return {
    id: 'm1',
    ts: 1,
    to: null,
    from: 'director-1',
    title: null,
    body: 'hi',
    level: 'info',
    data: {},
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  __resetMessagesForTests();
});

describe('threadKeyOf', () => {
  it('maps broadcasts to primary', () => {
    expect(threadKeyOf(msg({ to: null }), 'director-1')).toBe(PRIMARY_THREAD);
  });

  it('inbound DM is keyed by the sender name', () => {
    expect(threadKeyOf(msg({ to: 'director-1', from: 'build-bot' }), 'director-1')).toBe(
      'dm:build-bot',
    );
  });

  it('outbound DM is keyed by the recipient name', () => {
    expect(threadKeyOf(msg({ to: 'build-bot', from: 'director-1' }), 'director-1')).toBe(
      'dm:build-bot',
    );
  });

  it('self-DM gets its own key', () => {
    expect(threadKeyOf(msg({ to: 'director-1', from: 'director-1' }), 'director-1')).toBe(
      'dm:self',
    );
  });

  it('channel-tagged broadcasts route by channel id', () => {
    expect(threadKeyOf(msg({ to: null, data: { thread: 'chan:abc-123' } }), 'director-1')).toBe(
      'chan:abc-123',
    );
  });

  it('chan:general collapses to the legacy primary key', () => {
    expect(threadKeyOf(msg({ to: null, data: { thread: 'chan:general' } }), 'director-1')).toBe(
      PRIMARY_THREAD,
    );
  });

  it('untagged broadcasts still map to primary (legacy general)', () => {
    expect(threadKeyOf(msg({ to: null, data: {} }), 'director-1')).toBe(PRIMARY_THREAD);
  });
});

describe('appendMessages', () => {
  it('sorts by ts and dedupes by id', () => {
    appendMessages('director-1', [
      msg({ id: 'a', ts: 2, body: 'second' }),
      msg({ id: 'b', ts: 1, body: 'first' }),
    ]);
    // Overlapping re-append (simulates a reconnect backfill).
    appendMessages('director-1', [msg({ id: 'a', ts: 2, body: 'second' })]);
    const primary = threadMessages(PRIMARY_THREAD);
    expect(primary.map((m) => m.id)).toEqual(['b', 'a']);
    expect(primary).toHaveLength(2);
  });

  it('routes DMs and broadcasts into separate buckets', () => {
    appendMessages('director-1', [
      msg({ id: 'p1', ts: 1, to: null, body: 'team' }),
      msg({ id: 'd1', ts: 2, to: 'build-bot', from: 'director-1', body: 'dm' }),
    ]);
    expect(threadMessages(PRIMARY_THREAD)).toHaveLength(1);
    expect(threadMessages('dm:build-bot')).toHaveLength(1);
  });
});

describe('appendMessages out-of-order', () => {
  it('sorts a backwards-in-time arrival into place (slow path)', () => {
    appendMessages('director-1', [msg({ id: 'a', ts: 3 }), msg({ id: 'b', ts: 4 })]);
    // A reconnect backfill delivers an older message after newer ones.
    appendMessages('director-1', [msg({ id: 'c', ts: 1 })]);
    expect(threadMessages(PRIMARY_THREAD).map((m) => m.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('prependMessages', () => {
  it('places an older page ahead of existing messages', () => {
    appendMessages('director-1', [msg({ id: 'a', ts: 5 }), msg({ id: 'b', ts: 6 })]);
    prependMessages('director-1', [msg({ id: 'x', ts: 1 }), msg({ id: 'y', ts: 2 })]);
    expect(threadMessages(PRIMARY_THREAD).map((m) => m.id)).toEqual(['x', 'y', 'a', 'b']);
  });

  it('dedupes against messages already loaded', () => {
    appendMessages('director-1', [msg({ id: 'a', ts: 5 })]);
    // Overlapping page — `a` is re-sent alongside genuinely older rows.
    prependMessages('director-1', [msg({ id: 'older', ts: 1 }), msg({ id: 'a', ts: 5 })]);
    expect(threadMessages(PRIMARY_THREAD).map((m) => m.id)).toEqual(['older', 'a']);
  });

  it('sorts when an incoming page overlaps the current head in time', () => {
    appendMessages('director-1', [msg({ id: 'a', ts: 4 })]);
    // Page contains a row newer than the current head — slow path.
    prependMessages('director-1', [msg({ id: 'p', ts: 2 }), msg({ id: 'q', ts: 6 })]);
    expect(threadMessages(PRIMARY_THREAD).map((m) => m.id)).toEqual(['p', 'a', 'q']);
  });
});

describe('threadKeys', () => {
  it('always includes primary and sorts DMs alphabetically', () => {
    appendMessages('director-1', [
      msg({ id: 'd1', ts: 1, to: 'zebra', from: 'director-1' }),
      msg({ id: 'd2', ts: 2, to: 'alpha', from: 'director-1' }),
    ]);
    expect(threadKeys()).toEqual([PRIMARY_THREAD, 'dm:alpha', 'dm:zebra']);
  });
});
