/**
 * Store-side idempotency on `sourceId` — the broker's own defence
 * against a runner replaying activity it already uploaded.
 *
 * The runner dedups transcript lines in memory; that memory dies with
 * the process, and a fresh capture host re-reading a resumed transcript
 * uploaded hours of history as new rows (measured: 1000+ rows spanning
 * 15 hours in one second). So the SQLite store carries a partial unique
 * index over `(member_name, source_id)` and `append` is an
 * upsert-ignore. What is asserted here is the CONTRACT around that:
 *
 *   - a replay lands no row, returns no row, and wakes no subscriber;
 *   - the same id under a different member is a different event;
 *   - id-less events are never deduplicated (the positive control: an
 *     index that refused too much would pass every replay test);
 *   - an older database gains the column and the index lazily, with
 *     its existing rows untouched;
 *   - retention releases the key — a pruned event can be stored again;
 *   - through the HTTP route, a replayed batch is `accepted` in full
 *     (the broker holds every event it was sent) while the store holds
 *     each once.
 */

import {
  Broker,
  createApp,
  createSqliteActivityStore,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import { MEMBER_PATHS } from 'csuite-sdk/protocol';
import type { ActivityEvent, ActivityRow, Team } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { silentLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

let db: DatabaseSyncInstance;

beforeEach(() => {
  db = openDatabase(':memory:');
});

function prompt(ts: number, sourceId?: string): ActivityEvent {
  return {
    kind: 'user_prompt',
    ts,
    text: `p${ts}`,
    ...(sourceId !== undefined ? { sourceId } : {}),
  };
}

describe('member_activity dedup on sourceId', () => {
  it('stores a sourced event once: the replay lands nothing, returns nothing, wakes nobody', () => {
    const store = createSqliteActivityStore(db, silentLogger());
    const seen: ActivityRow[] = [];
    store.subscribe('worker', (row) => seen.push(row));

    const first = store.append('worker', [prompt(1, 'line-1'), prompt(2, 'line-2')]);
    expect(first.map((r) => r.event.sourceId)).toEqual(['line-1', 'line-2']);
    expect(seen).toHaveLength(2);

    // The replay: the same two lines plus one genuinely new one, the
    // shape a re-read resumed transcript produces.
    const replay = store.append('worker', [
      prompt(1, 'line-1'),
      prompt(2, 'line-2'),
      prompt(3, 'line-3'),
    ]);
    // Only the new row is reported — and with ITS id, not a stale
    // lastInsertRowid from the suppressed ones. (AUTOINCREMENT still
    // advances the sequence for a suppressed insert, so ids gap; the
    // contract is monotonic and unique, not contiguous.)
    expect(replay.map((r) => r.event.sourceId)).toEqual(['line-3']);
    expect(replay[0]?.id).toBeGreaterThan(first[1]?.id ?? Number.NaN);
    // The live tail saw the new row once and the replayed rows never again.
    expect(seen.map((r) => r.event.sourceId)).toEqual(['line-1', 'line-2', 'line-3']);

    const stored = store.list({ memberName: 'worker', limit: 10 });
    expect(stored.map((r) => r.event.sourceId)).toEqual(['line-3', 'line-2', 'line-1']);
    // The id handed back is the id of the row that landed.
    expect(stored.find((r) => r.event.sourceId === 'line-3')?.id).toBe(replay[0]?.id);
  });

  it('scopes the key per member: another member may store the same sourceId', () => {
    const store = createSqliteActivityStore(db, silentLogger());
    store.append('worker', [prompt(1, 'shared')]);
    const other = store.append('reviewer', [prompt(1, 'shared')]);
    expect(other).toHaveLength(1);
    expect(store.list({ memberName: 'reviewer', limit: 10 })).toHaveLength(1);
    expect(store.list({ memberName: 'worker', limit: 10 })).toHaveLength(1);
  });

  it('never dedups events without a sourceId (positive control)', () => {
    // An index that also refused id-less rows would pass every replay
    // assertion above; this is the row the mechanism must still admit.
    const store = createSqliteActivityStore(db, silentLogger());
    const seen: ActivityRow[] = [];
    store.subscribe('worker', (row) => seen.push(row));
    const rows = store.append('worker', [prompt(1), prompt(1), prompt(1)]);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    expect(seen).toHaveLength(3);
    expect(store.list({ memberName: 'worker', limit: 10 })).toHaveLength(3);
  });

  it('keeps the first occurrence when one batch names a source twice', () => {
    const store = createSqliteActivityStore(db, silentLogger());
    const rows = store.append('worker', [prompt(1, 'dup'), prompt(2, 'dup')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.ts).toBe(1);
  });

  it('migrates an older database: column and index added, existing rows untouched', () => {
    // A table created by a broker that predates `source_id`, already
    // holding rows. The store must open it, keep every row, and dedup
    // from here on.
    db.exec(`
      CREATE TABLE member_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_name TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO member_activity (member_name, ts, kind, event_json, created_at)
       VALUES ('worker', 5, 'user_prompt', '{"kind":"user_prompt","ts":5,"text":"old"}', 5)`,
    ).run();

    const store = createSqliteActivityStore(db, silentLogger());
    const legacy = store.list({ memberName: 'worker', limit: 10 });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.event).toMatchObject({ kind: 'user_prompt', text: 'old' });

    const columns = db.prepare('PRAGMA table_info(member_activity)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((c) => c.name)).toContain('source_id');
    const indexes = db.prepare('PRAGMA index_list(member_activity)').all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const dedup = indexes.find((i) => i.name === 'member_activity_member_source_idx');
    expect(dedup?.unique).toBe(1);
    expect(dedup?.partial).toBe(1);

    // And it dedups from here on, on the migrated table.
    expect(store.append('worker', [prompt(6, 'x')])).toHaveLength(1);
    expect(store.append('worker', [prompt(6, 'x')])).toHaveLength(0);
    // Opening the same database again is idempotent (the ALTER's
    // duplicate-column error is swallowed, the index already exists).
    expect(() => createSqliteActivityStore(db, silentLogger())).not.toThrow();
  });

  it('releases the key on prune: a pruned event can be stored again', () => {
    const store = createSqliteActivityStore(db, silentLogger());
    store.append('worker', [prompt(1, 'old-line')]);
    expect(store.append('worker', [prompt(1, 'old-line')])).toHaveLength(0);
    expect(store.prune(2)).toBe(1);
    expect(store.append('worker', [prompt(1, 'old-line')])).toHaveLength(1);
  });
});

describe('POST /members/:name/activity with replayed events', () => {
  const TOKEN = 'csuite_test_worker';
  const TEAM: Team = { name: 'demo-team', context: '', permissionPresets: {} };

  async function makeApp() {
    const broker = new Broker({
      eventLog: new InMemoryEventLog(),
      now: () => 1_700_000_000_000,
      idFactory: () => 'msg-fixed',
    });
    const members = createMemberStore([
      {
        name: 'worker',
        role: { title: 'engineer', description: '' },
        permissions: [],
        token: TOKEN,
      },
    ]);
    const activityStore = createSqliteActivityStore(db, silentLogger());
    const tokens = await createTokenStoreFromMembers(db, members);
    const { app } = createApp({
      broker,
      members,
      tokens,
      sessions: new SqliteSessionStore(db),
      activityStore,
      teamStore: mockTeamStore(TEAM),
      version: '0.0.0',
      logger: silentLogger(),
    });
    return { app, activityStore };
  }

  it('accepts the whole batch (the broker holds every event) while storing each once', async () => {
    const { app, activityStore } = await makeApp();
    const upload = (events: ActivityEvent[]) =>
      app.request(MEMBER_PATHS.activity('worker'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      });

    const first = await upload([prompt(1, 'l-1'), prompt(2, 'l-2')]);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ accepted: 2 });

    // A retry after a lost ack re-sends the same batch plus what came
    // after. The runner's `uploaded` accounting reads `accepted`, and
    // the first attempt counted nothing on its side — so every event
    // the broker now vouches for is counted, not only the row it wrote.
    const retry = await upload([prompt(1, 'l-1'), prompt(2, 'l-2'), prompt(3, 'l-3')]);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual({ accepted: 3 });

    const stored = activityStore.list({ memberName: 'worker', limit: 10 });
    expect(stored.map((r) => r.event.sourceId)).toEqual(['l-3', 'l-2', 'l-1']);
  });
});
