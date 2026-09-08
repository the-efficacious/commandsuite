/**
 * The indexes are actually used by the queries they were added for.
 *
 * An index that the planner ignores is pure cost: it slows every write
 * and speeds nothing, and nothing about its existence says which it is.
 * `CREATE INDEX` succeeding proves only that the statement parsed.
 *
 * So these assert the PLAN. Each names the index it expects and the
 * access it expects (`SEARCH`, not `SCAN`), which is the only form of
 * this claim that can fail when the query, the schema, or the planner's
 * mind changes.
 *
 * Each also has a control asserting the plan is not a full scan, so a
 * rename that quietly stopped matching would surface as a failure
 * rather than as a test that no longer means anything.
 */

import { createSqliteActivityStore, InMemoryEventLog, SqliteEventLog } from 'csuite-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';
import { silentLogger } from './helpers/logger.js';

let db: DatabaseSyncInstance;

/** The planner's description of how it will run `sql`. */
function plan(sql: string, ...params: unknown[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail).join(' | ');
}

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('event log reads', () => {
  beforeEach(() => {
    // Constructing the store is what creates the schema and indexes.
    new SqliteEventLog(db);
  });

  // These are the statements `SqliteEventLog` actually prepares, in the
  // shape it prepares them: the COMPOSITE seek
  // `(ts < ?1 OR (ts = ?1 AND id < ?2))` with `ORDER BY ts DESC, id
  // DESC`. The earlier version of this file asserted the plan for a
  // scalar `WHERE ts < ?`, which is a query production no longer runs —
  // a plan assertion against a statement nobody executes measures the
  // planner's opinion of a hypothetical. That is exactly the failure the
  // repo's own note about measuring rather than assuming warns about,
  // and the reason the composite change had to be re-measured rather
  // than copied from the activity store's precedent.
  it('seeks a channel thread by its indexed json expression', () => {
    const detail = plan(
      `SELECT id FROM events WHERE (ts < ?1 OR (ts = ?1 AND id < ?3))
         AND json_extract(data, '$.thread') = ?2
       ORDER BY ts DESC, id DESC LIMIT 50`,
      9,
      'chan:general',
      '',
    );

    expect(detail).toContain('events_thread_ts_id_idx');
    expect(detail).toContain('SEARCH');
    // The defect this replaced: reaching the thread's rows by walking
    // every event newer than the cursor.
    expect(detail).not.toContain('SCAN events');
  });

  it('seeks a DM pair by sender and recipient', () => {
    const detail = plan(
      `SELECT id FROM events WHERE (ts < ?1 OR (ts = ?1 AND id < ?6))
         AND to_name IS NOT NULL
         AND ((from_name = ?2 AND to_name = ?3) OR (from_name = ?4 AND to_name = ?5))
       ORDER BY ts DESC, id DESC LIMIT ?7`,
      9,
      'a',
      'b',
      'b',
      'a',
      '',
      50,
    );

    expect(detail).toContain('events_from_to_ts_id_idx');
    expect(detail).not.toContain('SCAN events');
  });

  it('still seeks the plain feed read by the composite cursor', () => {
    // Positive control: the new indexes must not have displaced the
    // one the unfiltered read depends on. Adding `id` to the index is
    // what keeps the tiebreak half of the seek off a row-by-row filter.
    const detail = plan(
      `SELECT id FROM events WHERE (ts < ?1 OR (ts = ?1 AND id < ?2))
       ORDER BY ts DESC, id DESC LIMIT ?3`,
      9,
      '',
      50,
    );
    expect(detail).toContain('events_ts_id_idx');
    expect(detail).toContain('SEARCH');
    expect(detail).not.toContain('SCAN events');
  });

  it('leaves no ts-only event index behind after the widening', () => {
    // `CREATE INDEX IF NOT EXISTS` cannot widen an index that already
    // exists, so the schema drops the three narrow ones by name. If that
    // drop were removed, a fresh database would still look right here —
    // which is why the assertion is that the OLD names are ABSENT, not
    // that the new ones are present.
    const names = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).not.toContain('events_ts_idx');
    expect(names).not.toContain('events_from_to_ts_idx');
    expect(names).not.toContain('events_thread_ts_idx');
    expect(names).toEqual(
      expect.arrayContaining([
        'events_ts_id_idx',
        'events_from_to_ts_id_idx',
        'events_thread_ts_id_idx',
      ]),
    );
  });

  it('drops a narrow index left by an older schema', () => {
    // The migration itself, driven: put a database back into its
    // earlier shape — narrow index present, wide one absent — and
    // reopen the store over it.
    const legacy = openDatabase(':memory:');
    new SqliteEventLog(legacy);
    legacy.exec(`DROP INDEX events_ts_id_idx;
                 CREATE INDEX events_ts_idx ON events (ts);`);
    const before = (
      legacy
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(before).toContain('events_ts_idx');
    expect(before).not.toContain('events_ts_id_idx');

    new SqliteEventLog(legacy);

    const after = (
      legacy
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(after).not.toContain('events_ts_idx');
    expect(after).toContain('events_ts_id_idx');
  });
});

describe('capture health', () => {
  beforeEach(() => {
    createSqliteActivityStore(db, silentLogger());
  });

  it('seeks the created_at range rather than filtering every marker', () => {
    // This runs per connected member on every roster poll, so the
    // difference between a seek and a filter is paid continuously.
    const detail = plan(
      `SELECT COUNT(*) FROM member_activity a
       WHERE a.member_name = ? AND a.kind = 'llm_exchange' AND a.created_at >= ?`,
      'worker',
      1_000,
    );

    expect(detail).toContain('member_activity_member_kind_created_idx');
    expect(detail).toContain('created_at>');
    expect(detail).not.toContain('SCAN a');
  });

  it('leaves the ts-bounded activity read on its own index', () => {
    // Positive control in the other direction: the timeline's own
    // range read bounds on ts, and must not have been pushed onto the
    // created_at index.
    const detail = plan(
      `SELECT * FROM member_activity WHERE member_name = ? AND ts < ? ORDER BY ts DESC LIMIT ?`,
      'worker',
      9,
      50,
    );

    expect(detail).toContain('member_activity_member_ts_idx');
    expect(detail).not.toContain('SCAN');
  });
});

describe('in-memory event log parity', () => {
  it('exists as a backend without a query planner at all', async () => {
    // Guards the assumption above: these plan assertions are about the
    // SQLite backend specifically, and the runtime-neutral contract has
    // another implementation that must keep working regardless.
    const log = new InMemoryEventLog();
    expect(await log.tail({ limit: 10 })).toEqual([]);
  });
});
