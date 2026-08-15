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

  it('seeks a channel thread by its indexed json expression', () => {
    const detail = plan(
      `SELECT id FROM events WHERE ts < ? AND json_extract(data, '$.thread') = ?
       ORDER BY ts DESC LIMIT ?`,
      9,
      'chan:general',
      50,
    );

    expect(detail).toContain('events_thread_ts_idx');
    expect(detail).toContain('SEARCH');
    // The defect this replaced: reaching the thread's rows by walking
    // every event newer than the cursor.
    expect(detail).not.toContain('SCAN events');
  });

  it('seeks a DM pair by sender and recipient', () => {
    const detail = plan(
      `SELECT id FROM events WHERE ts < ? AND to_name IS NOT NULL
         AND ((from_name = ? AND to_name = ?) OR (from_name = ? AND to_name = ?))
       ORDER BY ts DESC LIMIT ?`,
      9,
      'a',
      'b',
      'b',
      'a',
      50,
    );

    expect(detail).toContain('events_from_to_ts_idx');
    expect(detail).not.toContain('SCAN events');
  });

  it('still seeks the plain feed read by ts', () => {
    // Positive control: the new indexes must not have displaced the
    // one the unfiltered read depends on.
    const detail = plan(`SELECT id FROM events WHERE ts < ? ORDER BY ts DESC LIMIT ?`, 9, 50);
    expect(detail).toContain('events_ts_idx');
    expect(detail).not.toContain('SCAN events');
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
