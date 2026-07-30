import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from 'csuite-sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';
import { SqliteEventLog } from '../src/sqlite-event-log.js';

describe('SqliteEventLog', () => {
  const dirsToClean: string[] = [];
  const dbsToClose: DatabaseSyncInstance[] = [];

  afterEach(() => {
    for (const db of dbsToClose.splice(0)) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'csuite-sqlite-test-'));
    dirsToClean.push(dir);
    return join(dir, 'events.db');
  }

  function makeLog(path: string): SqliteEventLog {
    const db = openDatabase(path);
    dbsToClose.push(db);
    return new SqliteEventLog(db);
  }

  it('append + tail round-trip preserves the full message shape', async () => {
    const log = makeLog(tmpDbPath());
    const m1: Message = {
      id: 'a',
      ts: 1,
      to: 'x',
      from: 'alice',
      title: 'hi',
      body: 'hello',
      level: 'warning',
      data: { foo: 'bar', n: 42 },
      attachments: [],
    };
    await log.append(m1);
    const tailed = await log.tail();
    expect(tailed).toHaveLength(1);
    expect(tailed[0]).toEqual(m1);
  });

  it('round-trips messages with null `from` (e.g., pre-auth migration data)', async () => {
    const log = makeLog(tmpDbPath());
    const m: Message = {
      id: 'legacy',
      ts: 5,
      to: null,
      from: null,
      title: null,
      body: 'no sender known',
      level: 'info',
      data: {},
      attachments: [],
    };
    await log.append(m);
    const tailed = await log.tail();
    expect(tailed[0]?.from).toBeNull();
  });

  it('tail honours since + limit', async () => {
    const log = makeLog(tmpDbPath());
    for (let i = 0; i < 5; i++) {
      await log.append({
        id: `m${i}`,
        ts: i,
        to: null,
        from: null,
        title: null,
        body: `msg ${i}`,
        level: 'info',
        data: {},
        attachments: [],
      });
    }
    const since = await log.tail({ since: 3 });
    expect(since.map((m) => m.id).sort()).toEqual(['m3', 'm4']);

    const limit = await log.tail({ limit: 2 });
    expect(limit.map((m) => m.id).sort()).toEqual(['m3', 'm4']);
  });

  it('persists messages across reopening the database', async () => {
    const path = tmpDbPath();
    const firstDb = openDatabase(path);
    const first = new SqliteEventLog(firstDb);
    await first.append({
      id: 'persist',
      ts: 10,
      to: 'a1',
      from: 'alice',
      title: null,
      body: 'survive',
      level: 'info',
      data: {},
      attachments: [],
    });
    firstDb.close();

    const secondDb = openDatabase(path);
    dbsToClose.push(secondDb);
    const second = new SqliteEventLog(secondDb);
    const tailed = await second.tail();
    expect(tailed).toHaveLength(1);
    expect(tailed[0]?.body).toBe('survive');
    expect(tailed[0]?.from).toBe('alice');
  });

  // The SQL feed filter and `matchesViewer` in `csuite-core` answer the
  // same question and must not drift. Measured on the live broker
  // before this fix: 27 of 27 secret events were returned to a member
  // neither bound to any of them nor holding `secrets.manage`, because
  // a fan-out push persists `to_name = NULL` and the feed returns every
  // such row to everyone.
  describe('secret-event scoping', () => {
    function secretEvent(id: string, ts: number, slug: string): Message {
      return {
        id,
        ts,
        to: null,
        from: 'admin',
        title: null,
        body: `Secret '${slug}' was updated by admin.`,
        level: 'info',
        data: { kind: 'secret', event: 'value_set', thread: `secret:${slug}`, actor: 'admin' },
        attachments: [],
      };
    }

    function plain(id: string, ts: number, over: Partial<Message> = {}): Message {
      return {
        id,
        ts,
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

    it('keeps secret events out of the default feed', async () => {
      const log = makeLog(tmpDbPath());
      await log.append(secretEvent('s', 1, 'deploy-key'));
      expect(await log.query({ viewer: 'outsider' })).toEqual([]);
    });

    it('hides them from the actor too', async () => {
      const log = makeLog(tmpDbPath());
      await log.append(secretEvent('s', 1, 'deploy-key'));
      expect(await log.query({ viewer: 'admin' })).toEqual([]);
    });

    it('still returns everything else, so the empty result above means something', async () => {
      const log = makeLog(tmpDbPath());
      await log.append(plain('broadcast', 1));
      await log.append(plain('dm', 2, { from: 'bob', to: 'outsider' }));
      await log.append(plain('chan', 3, { data: { thread: 'chan:abc' } }));
      await log.append(plain('obj', 4, { data: { thread: 'obj:obj-123' } }));
      await log.append(secretEvent('secret', 5, 'deploy-key'));

      const seen = await log.query({ viewer: 'outsider' });
      expect(seen.map((m) => m.id).sort()).toEqual(['broadcast', 'chan', 'dm', 'obj']);
    });

    it('matches the prefix rather than one slug', async () => {
      const log = makeLog(tmpDbPath());
      await log.append(secretEvent('s0', 1, 'a'));
      await log.append(secretEvent('s1', 2, 'cora-github-token'));
      expect(await log.query({ viewer: 'outsider' })).toEqual([]);
    });

    it('leaves a channel thread that merely contains "secret:" alone', async () => {
      const log = makeLog(tmpDbPath());
      await log.append(plain('c', 1, { data: { thread: 'chan:top-secret:stuff' } }));
      expect((await log.query({ viewer: 'outsider' })).map((m) => m.id)).toEqual(['c']);
    });
  });
});
