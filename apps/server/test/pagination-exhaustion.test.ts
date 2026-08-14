/**
 * A short page means exhausted, and nothing else.
 *
 * All three list paths skip rows they cannot decode. Skipping without
 * refilling returns a page shorter than the limit — and every pager in
 * the tree, client and server alike, reads "shorter than limit" as "no
 * more rows". So one corrupt row inside a window ended a trace early
 * and reported it as complete.
 *
 * The store's own comment argued the skip was safe because the cursor
 * is driven by the last REAL row returned, so nothing double-counts or
 * desyncs. That is true of the cursor and false of the exhaustion
 * signal, which is the thing callers actually branch on.
 *
 * This is the defect class CONTRIBUTING names outright — "a trace view
 * silently truncated its window; the test asserted that the call
 * returned, never that the result was complete" — so these assert
 * COMPLETENESS: the page is full, and the rows that follow a corrupt
 * one are all present.
 */

import { createGenAiStore, createSqliteActivityStore, createTelemetryStore } from 'csuite-core';
import type { ActivityEvent } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';
import { silentLogger } from './helpers/logger.js';

let db: DatabaseSyncInstance;

beforeEach(() => {
  db = openDatabase(':memory:');
});

function prompt(ts: number): ActivityEvent {
  return { kind: 'user_prompt', ts, text: `p${ts}` };
}

/** Persist a row whose payload no longer validates. */
function corruptActivityRow(ts: number): void {
  db.prepare(
    `INSERT INTO member_activity (member_name, ts, kind, event_json, created_at)
     VALUES ('worker', ?, 'opaque_http', '{"kind":"opaque_http","ts":1}', ?)`,
  ).run(ts, ts);
}

describe('member_activity', () => {
  it('returns a FULL page despite a corrupt row inside the window', () => {
    const store = createSqliteActivityStore(db, silentLogger());
    // Newest-first, so ts 1..5 come back as 5,4,3,2,1. The corruption
    // sits at 4 — inside the first page, not at its edge.
    for (const ts of [1, 2, 3, 5]) store.append('worker', [prompt(ts)]);
    corruptActivityRow(4);

    const page = store.list({ memberName: 'worker', limit: 3 });

    // Would be 2 without the refill, and every caller reads 2-of-3 as
    // "that is everything".
    expect(page).toHaveLength(3);
    expect(page.map((r) => r.event.ts)).toEqual([5, 3, 2]);
  });

  it('still returns a short page when the data really is exhausted', () => {
    // The positive control. Without it, a "refill" that looped forever
    // or padded the page would satisfy the test above.
    const store = createSqliteActivityStore(db, silentLogger());
    store.append('worker', [prompt(1)]);

    expect(store.list({ memberName: 'worker', limit: 10 })).toHaveLength(1);
  });

  it('reaches rows PAST the corrupt one rather than stopping at it', () => {
    const store = createSqliteActivityStore(db, silentLogger());
    store.append('worker', [prompt(1)]);
    corruptActivityRow(2);
    store.append('worker', [prompt(3)]);

    const all = store.list({ memberName: 'worker', limit: 10 });

    expect(all.map((r) => r.event.ts)).toEqual([3, 1]);
  });

  it('a window of nothing but corrupt rows is empty, not an infinite loop', () => {
    const store = createSqliteActivityStore(db, silentLogger());
    corruptActivityRow(1);
    corruptActivityRow(2);

    expect(store.list({ memberName: 'worker', limit: 10 })).toEqual([]);
  });

  it('pages consistently across a corrupt row using the composite cursor', () => {
    const store = createSqliteActivityStore(db, silentLogger());
    for (const ts of [1, 2, 3, 5]) store.append('worker', [prompt(ts)]);
    corruptActivityRow(4);

    const first = store.list({ memberName: 'worker', limit: 2 });
    expect(first.map((r) => r.event.ts)).toEqual([5, 3]);
    const cursorRow = first[1];
    expect(cursorRow).toBeDefined();

    const second = store.list({
      memberName: 'worker',
      limit: 2,
      before: { ts: cursorRow?.event.ts ?? 0, id: cursorRow?.id ?? 0 },
    });
    // No repeat of the cursor row, no gap.
    expect(second.map((r) => r.event.ts)).toEqual([2, 1]);
  });

  it('treats limit=0 as a bad value rather than an empty page', () => {
    // `LIMIT 0` returns nothing, which a pager reads as exhausted —
    // the store contract says a non-positive limit falls back to the
    // default instead.
    const store = createSqliteActivityStore(db, silentLogger());
    store.append('worker', [prompt(1)]);

    expect(store.list({ memberName: 'worker', limit: 0 })).toHaveLength(1);
  });
});

describe('gen_ai_inference', () => {
  function seed(ts: number): void {
    createGenAiStore(db, { logger: silentLogger() }).append('worker', {
      ts,
      operationName: 'chat',
      provider: 'anthropic',
      model: 'm',
      responseId: `msg_${ts}`,
      finishReasons: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      systemInstructions: [],
      inputMessages: [],
      outputMessages: [],
      querySource: 'repl_main_thread',
      agentName: null,
      requestBodyRef: null,
    });
  }

  it('returns a FULL page despite an undecodable row inside the window', () => {
    const store = createGenAiStore(db, { logger: silentLogger() });
    seed(1);
    seed(2);
    seed(3);
    seed(4);
    // Corrupt the second row's JSON columns in place.
    db.prepare('UPDATE gen_ai_inference SET input_messages = ? WHERE ts = 2').run('{not json');

    const page = store.list({ memberName: 'worker', limit: 3 });

    expect(page).toHaveLength(3);
    expect(page.map((r) => r.ts)).toEqual([1, 3, 4]);
  });

  it('still returns a short page when exhausted', () => {
    const store = createGenAiStore(db, { logger: silentLogger() });
    seed(1);
    expect(store.list({ memberName: 'worker', limit: 10 })).toHaveLength(1);
  });
});

describe('telemetry', () => {
  function seed(tsMs: number): void {
    createTelemetryStore(db, { logger: silentLogger() }).append('worker', [
      {
        signal: 'log',
        name: 'api_request',
        // ts_ms is derived from the nanosecond stamp on append.
        tsUnixNano: tsMs * 1_000_000,
        attributes: {},
        resource: {},
        scope: null,
        payload: {},
      },
    ]);
  }

  it('returns a FULL page despite an undecodable row inside the window', () => {
    const store = createTelemetryStore(db, { logger: silentLogger() });
    seed(1);
    seed(2);
    seed(3);
    seed(4);
    db.prepare('UPDATE telemetry SET attributes = ? WHERE ts_ms = 2').run('{not json');

    const page = store.list({ memberName: 'worker', limit: 3 });

    expect(page).toHaveLength(3);
    expect(page.map((r) => r.tsMs)).toEqual([1, 3, 4]);
  });

  it('still returns a short page when exhausted', () => {
    const store = createTelemetryStore(db, { logger: silentLogger() });
    seed(1);
    expect(store.list({ memberName: 'worker', limit: 10 })).toHaveLength(1);
  });
});
