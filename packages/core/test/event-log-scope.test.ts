/**
 * Feed scoping, run against BOTH event logs.
 *
 * The in-memory log and the SQLite log answer the same question in two
 * languages — a TypeScript predicate and a SQL `WHERE` clause — and the
 * bug this suite exists for was them disagreeing with the live fan-out
 * rather than with each other. Every case runs on both, so a fix
 * applied to one and forgotten in the other fails here.
 *
 * The rule under test: a message delivered to a named audience is
 * readable afterwards by that audience, and by nobody else.
 */

import { DatabaseSync } from 'node:sqlite';
import type { Message } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { channelThreadTag, type EventLog, InMemoryEventLog } from '../src/event-log.js';
import type { SqlDriver } from '../src/sql-driver.js';
import { SqliteEventLog } from '../src/sqlite-event-log.js';

function msg(overrides: Partial<Message> & { id: string; ts: number }): Message {
  return {
    to: null,
    from: 'alice',
    title: null,
    body: 'body',
    level: 'info',
    data: {},
    attachments: [],
    ...overrides,
  };
}

const IMPLEMENTATIONS: Array<{ name: string; make: () => EventLog }> = [
  { name: 'InMemoryEventLog', make: () => new InMemoryEventLog() },
  {
    name: 'SqliteEventLog',
    make: () => new SqliteEventLog(new DatabaseSync(':memory:') as unknown as SqlDriver),
  },
];

for (const impl of IMPLEMENTATIONS) {
  describe(`feed scoping — ${impl.name}`, () => {
    let log: EventLog;
    beforeEach(() => {
      log = impl.make();
    });

    const idsFor = async (viewer: string): Promise<string[]> =>
      (await log.query({ viewer })).map((m) => m.id).sort();

    it('keeps a channel message to the channel', async () => {
      // The bug: this row persists with `to: null`, so a feed keyed on
      // "is it addressed to me" handed a private channel to the team.
      await log.append(
        msg({
          id: 'chan',
          ts: 1,
          from: 'alice',
          data: { thread: channelThreadTag('secret-room') },
        }),
        { recipients: ['alice', 'bob'] },
      );
      expect(await idsFor('alice')).toEqual(['chan']);
      expect(await idsFor('bob')).toEqual(['chan']);
      expect(await idsFor('carol')).toEqual([]);
    });

    it('keeps an objective thread to its participants', async () => {
      await log.append(msg({ id: 'obj', ts: 1, from: 'alice', data: { thread: 'obj:obj-1' } }), {
        recipients: ['alice', 'bob'],
      });
      expect(await idsFor('bob')).toEqual(['obj']);
      expect(await idsFor('carol')).toEqual([]);
    });

    it('still broadcasts what was actually broadcast', async () => {
      await log.append(msg({ id: 'all', ts: 1 }));
      expect(await idsFor('carol')).toEqual(['all']);
    });

    it('treats the general channel as team-wide', async () => {
      // General's membership is implicit, so its pushes carry no
      // recipient list. Scoping must not swallow them.
      await log.append(msg({ id: 'gen', ts: 1, data: { thread: channelThreadTag('general') } }));
      expect(await idsFor('carol')).toEqual(['gen']);
    });

    it('shows the sender their own scoped message', async () => {
      await log.append(
        msg({ id: 'chan', ts: 1, from: 'alice', data: { thread: channelThreadTag('room') } }),
        { recipients: ['bob'] },
      );
      expect(await idsFor('alice')).toEqual(['chan']);
    });

    it('withholds a legacy scoped row that cannot say who it was for', async () => {
      // Rows written before the audience column exist in every
      // deployment that will take this upgrade. They cannot be
      // reconstructed, so a scoped tag on one means "not for the feed"
      // — fail closed rather than keep leaking on the strength of
      // having been written first.
      await log.append(
        msg({ id: 'legacy-chan', ts: 1, from: 'alice', data: { thread: channelThreadTag('old') } }),
      );
      await log.append(msg({ id: 'legacy-obj', ts: 2, from: 'alice', data: { thread: 'obj:o' } }));
      expect(await idsFor('carol')).toEqual([]);
      // …and the sender still sees their own history.
      expect(await idsFor('alice')).toEqual(['legacy-chan', 'legacy-obj']);
    });

    it('withholds every legacy thread family that used recipient-list delivery', async () => {
      await log.append(msg({ id: 'tool', ts: 1, data: { thread: 'tool:private-api' } }));
      await log.append(msg({ id: 'variable', ts: 2, data: { thread: 'variable:region' } }));
      await log.append(msg({ id: 'hook', ts: 3, data: { thread: 'hook:incident-feed' } }));

      expect(await idsFor('carol')).toEqual([]);
      expect(await idsFor('alice')).toEqual(['hook', 'tool', 'variable']);
    });

    it('withholds legacy recipient-list events that have no thread tag', async () => {
      await log.append(msg({ id: 'instructions', ts: 1, data: { kind: 'instructions' } }));
      await log.append(
        msg({
          id: 'control',
          ts: 2,
          data: { kind: 'context_control', target: 'bob', reason: 'private reason' },
        }),
      );

      expect(await idsFor('carol')).toEqual([]);
      expect(await idsFor('alice')).toEqual(['control', 'instructions']);
    });

    it('uses the recorded audience for every current thread family', async () => {
      for (const [index, thread] of ['tool:s', 'variable:v', 'hook:h'].entries()) {
        await log.append(msg({ id: thread, ts: index + 1, data: { thread } }), {
          recipients: ['bob'],
        });
      }

      expect(await idsFor('bob')).toEqual(['hook:h', 'tool:s', 'variable:v']);
      expect(await idsFor('carol')).toEqual([]);
    });

    it('leaves legacy unscoped rows visible', async () => {
      await log.append(msg({ id: 'plain', ts: 1, data: { kind: 'chat' } }));
      expect(await idsFor('carol')).toEqual(['plain']);
    });

    it('does not treat an empty audience as a broadcast', async () => {
      // A channel whose members are all offline fans out to nobody.
      // Collapsing `[]` into `null` would republish it to the team.
      await log.append(
        msg({ id: 'nobody', ts: 1, from: 'alice', data: { thread: channelThreadTag('quiet') } }),
        { recipients: [] },
      );
      expect(await idsFor('carol')).toEqual([]);
    });

    it('keeps DMs to their two ends', async () => {
      await log.append(msg({ id: 'dm', ts: 1, from: 'alice', to: 'bob' }));
      expect(await idsFor('bob')).toEqual(['dm']);
      expect(await idsFor('alice')).toEqual(['dm']);
      expect(await idsFor('carol')).toEqual([]);
    });

    it('never puts a secret event in anyone’s feed, audience or not', async () => {
      await log.append(
        msg({ id: 'sec', ts: 1, from: 'alice', data: { thread: 'secret:deploy-key' } }),
        { recipients: ['alice', 'bob'] },
      );
      expect(await idsFor('alice')).toEqual([]);
      expect(await idsFor('bob')).toEqual([]);
    });
  });
}
