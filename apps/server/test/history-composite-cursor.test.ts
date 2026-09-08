/**
 * `GET /history` enumerates a shared millisecond.
 *
 * The failure this exists to prevent is not "the page is in the wrong
 * order" — it is that messages became UNREACHABLE. `/history` paged on a
 * scalar `before` timestamp, message timestamps are `Date.now()` at push
 * time, and a page boundary inside a tie excluded every row sharing that
 * millisecond, including ones the client had not seen. No later value of
 * `before` could recover them: any bound that admitted them also
 * re-returned rows the client already held, and there was no id to
 * deduplicate against a page that never arrived.
 *
 * So the assertion is the WHOLE id sequence across the whole walk, with
 * `toEqual` — not a count, not a set membership, not "the second page
 * differs from the first". A pager that returns *some* of the right
 * answer is exactly the defect, and the repository's own rule says a
 * test that would pass against that is not testing the contract.
 *
 * Both backends run the same walk. `InMemoryEventLog` and
 * `SqliteEventLog` are one contract with two implementations, and the
 * composite cursor is only correct if each one's traversal order matches
 * the order its cursor compares in. The in-memory log used to walk in
 * INSERTION order while SQLite ordered by `ts` — a divergence invisible
 * until a cursor needs the two to agree.
 */

import {
  Broker,
  createApp,
  createTokenStoreFromMembers,
  type EventLog,
  InMemoryEventLog,
  SqliteEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import { PATHS } from 'csuite-sdk/protocol';
import type { Message, Team } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { silentLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const TEAM: Team = { name: 'demo-team', context: '', permissionPresets: {} };
const TOKEN = 'csuite_test_history_cursor';

/** One millisecond, shared by three broadcasts — the collision the fix is about. */
const TIED_MS = 1_700_000_100_000;

function message(id: string, ts: number): Message {
  return {
    id,
    ts,
    to: null,
    from: 'alice',
    title: null,
    body: id,
    level: 'info',
    data: {},
    attachments: [],
  };
}

async function makeApp(log: EventLog) {
  const db = openDatabase(':memory:');
  const members = createMemberStore([
    {
      name: 'alice',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      token: TOKEN,
    },
  ]);
  const broker = new Broker({ eventLog: log });
  broker.seedMembers(members.members());
  const { app } = createApp({
    broker,
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    logger: silentLogger(),
  });
  return app;
}

/**
 * Seed one older message and three sharing `TIED_MS`, in an order that
 * is deliberately NOT the id order — so a walk that happens to return
 * insertion order and a walk that sorts by id cannot both be right.
 */
async function seed(log: EventLog): Promise<void> {
  await log.append(message('m-older', TIED_MS - 100));
  await log.append(message('m-b', TIED_MS));
  await log.append(message('m-c', TIED_MS));
  await log.append(message('m-a', TIED_MS));
}

interface Page {
  messages: Array<{ id: string; ts: number }>;
}

/** Walk `/history` one row at a time until it runs out. */
async function pageThrough(
  app: Awaited<ReturnType<typeof makeApp>>,
  cursorParams: (last: { id: string; ts: number }) => string,
): Promise<string[]> {
  const seen: string[] = [];
  let last: { id: string; ts: number } | undefined;
  for (let guard = 0; guard < 12; guard++) {
    const qs = `limit=1${last ? `&${cursorParams(last)}` : ''}`;
    const res = await app.request(`${PATHS.history}?${qs}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Page;
    if (body.messages.length === 0) return seen;
    for (const m of body.messages) seen.push(m.id);
    last = body.messages[body.messages.length - 1];
  }
  throw new Error('paging /history did not terminate within 12 pages');
}

const BACKENDS: Array<{ name: string; make: () => EventLog }> = [
  { name: 'InMemoryEventLog', make: () => new InMemoryEventLog() },
  { name: 'SqliteEventLog', make: () => new SqliteEventLog(openDatabase(':memory:')) },
];

describe.each(BACKENDS)('GET /history composite cursor ($name)', ({ make }) => {
  it('returns every message across pages, in order, none dropped and none repeated', async () => {
    const log = make();
    await seed(log);
    const app = await makeApp(log);

    const seen = await pageThrough(app, (last) => `before_ts=${last.ts}&before_id=${last.id}`);

    // The whole sequence. Newest-first, and within the tie the total
    // order is id-descending — arbitrary, but total and stable, which
    // is the property that makes the walk complete.
    expect(seen).toEqual(['m-c', 'm-b', 'm-a', 'm-older']);
  });

  it('gives the same rows in one page as it does one at a time', async () => {
    // Positive control against a pager that is complete because it is
    // returning too much: the unpaged read is the reference answer.
    const log = make();
    await seed(log);
    const app = await makeApp(log);

    const res = await app.request(`${PATHS.history}?limit=50`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as Page;
    expect(body.messages.map((m) => m.id)).toEqual(['m-c', 'm-b', 'm-a', 'm-older']);
  });

  it('the retired scalar bound still loses the tie — which is why it is retired', async () => {
    // The defect, reproduced through the compatibility path, so the
    // difference between the two mechanisms is a fixture rather than a
    // claim in a comment. `?before=` (and equally `?before_ts=` with no
    // id) is a bound, not a cursor.
    const log = make();
    await seed(log);
    const app = await makeApp(log);

    const seen = await pageThrough(app, (last) => `before=${last.ts}`);

    expect(seen).toEqual(['m-c', 'm-older']);
    // Two of four. `m-b` and `m-a` are reachable by no value of the
    // scalar bound, which is the whole of the defect.
    expect(seen).not.toContain('m-b');
    expect(seen).not.toContain('m-a');
  });

  it('rejects `before_id` without `before_ts`', async () => {
    // Half a cursor would otherwise read from the newest row while the
    // caller believed it was resuming — the same silent-restart bug the
    // activity endpoint rejects.
    const log = make();
    await seed(log);
    const app = await makeApp(log);

    const res = await app.request(`${PATHS.history}?before_id=m-b`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });
});

describe('event log backends agree', () => {
  it('order the same tied millisecond identically', async () => {
    // The two implementations are one contract. The in-memory log used
    // to walk in insertion order and SQLite in `ts` order, so this
    // fixture is seeded in an order that is neither.
    const memory = new InMemoryEventLog();
    const sqlite = new SqliteEventLog(openDatabase(':memory:'));
    await seed(memory);
    await seed(sqlite);

    const fromMemory = (await memory.query({ viewer: 'alice', limit: 50 })).map((m) => m.id);
    const fromSqlite = (await sqlite.query({ viewer: 'alice', limit: 50 })).map((m) => m.id);

    expect(fromMemory).toEqual(fromSqlite);
    expect(fromMemory).toEqual(['m-c', 'm-b', 'm-a', 'm-older']);
  });
});
