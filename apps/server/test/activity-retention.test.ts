/**
 * Retention across the whole activity database.
 *
 * The defect these cover: `prune-traces` deleted from `member_activity`
 * and nothing else, while `gen_ai_inference`, `telemetry` and the raw
 * body store — the three heaviest things in the same file — grew
 * forever. So the first group asserts every table actually moves.
 *
 * The second group is the dangerous half. `raw_blob` is deduped by
 * content hash, so one row can back many exchanges and its
 * `first_seen_at` says when the bytes arrived, not when they stopped
 * being needed. A blob deleted by age takes the bytes out from under
 * a retained exchange. These assert the reference rule in BOTH
 * directions — collected when nothing points at it, kept when anything
 * does — because a collector that deletes nothing satisfies every
 * "still there" assertion, and one that deletes everything satisfies
 * every "it was collected" assertion.
 */

import { createGenAiStore, createSqliteActivityStore, pruneActivityDb } from 'csuite-core';
import type { ActivityEvent } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';
import { createRawBodyStore } from '../src/raw-body-store.js';
import { silentLogger } from './helpers/logger.js';

const HOUR = 3_600_000;
const NOW = 1_770_000_000_000;
const CUTOFF = NOW - 24 * HOUR;

let db: DatabaseSyncInstance;

beforeEach(() => {
  db = openDatabase(':memory:');
});

function activityEvent(ts: number): ActivityEvent {
  return { kind: 'user_prompt', ts, text: 'hello' };
}

function seedActivity(ts: number): void {
  createSqliteActivityStore(db, silentLogger()).append('engineer-1', [activityEvent(ts)]);
}

function seedTelemetry(tsMs: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT, member_name TEXT NOT NULL, signal TEXT NOT NULL,
    name TEXT NOT NULL, ts_unix_nano INTEGER NOT NULL, ts_ms INTEGER NOT NULL,
    attributes TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL,
    payload TEXT NOT NULL, received_at INTEGER NOT NULL)`);
  db.prepare(
    `INSERT INTO telemetry (member_name, signal, name, ts_unix_nano, ts_ms,
       attributes, resource, scope, payload, received_at)
     VALUES ('engineer-1','log','api_request',?,?,'{}','{}','{}','{}',?)`,
  ).run(tsMs * 1_000_000, tsMs, tsMs);
}

function seedInference(ts: number, hashes: { req?: string; res?: string } = {}): number {
  const store = createGenAiStore(db, { logger: silentLogger() });
  store.append('engineer-1', {
    ts,
    operationName: 'chat',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    responseId: `msg_${ts}`,
    finishReasons: ['end_turn'],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    systemInstructions: [],
    inputMessages: [],
    outputMessages: [],
    querySource: 'repl_main_thread',
    agentName: null,
    requestBodyRef: null,
    ...(hashes.req !== undefined ? { requestSha256: hashes.req } : {}),
    ...(hashes.res !== undefined ? { responseSha256: hashes.res } : {}),
  });
  return ts;
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint };
  return Number(row.n);
}

describe('every captured table is pruned, not just member_activity', () => {
  it('deletes old rows from activity, inferences and telemetry alike', () => {
    seedActivity(NOW - 48 * HOUR);
    seedActivity(NOW - 1 * HOUR);
    seedInference(NOW - 48 * HOUR);
    seedInference(NOW - 1 * HOUR);
    seedTelemetry(NOW - 48 * HOUR);
    seedTelemetry(NOW - 1 * HOUR);

    const result = pruneActivityDb(db, CUTOFF);

    expect(result.memberActivity).toBe(1);
    expect(result.genAiInference).toBe(1);
    expect(result.telemetry).toBe(1);
    // The nearest valid thing it must NOT delete: everything inside the
    // window survives. A prune that took both rows would satisfy the
    // counts above if they were only asserted as ">= 1".
    expect(countRows('member_activity')).toBe(1);
    expect(countRows('gen_ai_inference')).toBe(1);
    expect(countRows('telemetry')).toBe(1);
  });

  it('reports each table separately so an operator can see what moved', () => {
    seedActivity(NOW - 48 * HOUR);
    seedTelemetry(NOW - 48 * HOUR);

    const result = pruneActivityDb(db, CUTOFF);

    expect(result).toMatchObject({ memberActivity: 1, telemetry: 1, genAiInference: 0 });
    expect(result.total).toBe(
      result.memberActivity +
        result.genAiInference +
        result.telemetry +
        result.rawExchange +
        result.rawBlob,
    );
  });

  it('prunes a database missing the optional capture tables', () => {
    // A broker without gen-ai capture has no gen_ai_inference or
    // raw_blob table at all. Retention must still run rather than
    // throwing on the first absent table.
    seedActivity(NOW - 48 * HOUR);
    expect(() => pruneActivityDb(db, CUTOFF)).not.toThrow();
    expect(countRows('member_activity')).toBe(0);
  });
});

describe('raw blobs are collected by reference, never by age', () => {
  it('collects a blob once its last exchange is pruned', () => {
    const store = createRawBodyStore(db, { logger: silentLogger() });
    const { hash } = store.appendBody({
      memberName: 'engineer-1',
      kind: 'request',
      bytes: Buffer.from('{"old":true}'),
      envelope: { eventTs: NOW - 48 * HOUR },
    });

    const result = pruneActivityDb(db, CUTOFF);

    expect(result.rawExchange).toBe(1);
    expect(result.rawBlob).toBe(1);
    expect(store.getBlob(hash)).toBeNull();
  });

  it('KEEPS a blob still referenced by a retained exchange', () => {
    // The dedup case, and the reason age is the wrong discriminator:
    // identical bytes sent on an old turn and a recent one are ONE row,
    // whose first_seen_at is the old timestamp. Deleting by that
    // timestamp would strip the bytes from the retained exchange.
    const store = createRawBodyStore(db, { logger: silentLogger() });
    const bytes = Buffer.from('{"resent":true}');
    const first = store.appendBody({
      memberName: 'engineer-1',
      kind: 'request',
      bytes,
      envelope: { eventTs: NOW - 48 * HOUR },
    });
    const second = store.appendBody({
      memberName: 'engineer-1',
      kind: 'request',
      bytes,
      envelope: { eventTs: NOW - 1 * HOUR },
    });
    expect(second.hash).toBe(first.hash); // deduped to one blob

    const result = pruneActivityDb(db, CUTOFF);

    expect(result.rawExchange).toBe(1); // the old exchange only
    expect(result.rawBlob).toBe(0);
    // The bytes the retained exchange points at are still readable.
    expect(store.getBlob(first.hash)?.toString()).toBe('{"resent":true}');
  });

  it('KEEPS a blob referenced only by a retained inference', () => {
    // The second referrer, and the one a raw_exchange-only rule would
    // miss: gen_ai_inference points back at its source bytes by hash.
    const store = createRawBodyStore(db, { logger: silentLogger() });
    const { hash } = store.appendBody({
      memberName: 'engineer-1',
      kind: 'request',
      bytes: Buffer.from('{"cited":true}'),
      envelope: { eventTs: NOW - 48 * HOUR },
    });
    seedInference(NOW - 1 * HOUR, { req: hash });

    const result = pruneActivityDb(db, CUTOFF);

    expect(result.rawExchange).toBe(1); // its exchange aged out
    expect(result.rawBlob).toBe(0); // but the inference still cites it
    expect(store.getBlob(hash)?.toString()).toBe('{"cited":true}');
  });

  it('collects the blob once the citing inference is pruned too', () => {
    // Positive control for the rule above: with the inference gone,
    // the same blob IS collected. Without this, a collector that never
    // deletes anything passes both "KEEPS" tests.
    const store = createRawBodyStore(db, { logger: silentLogger() });
    const { hash } = store.appendBody({
      memberName: 'engineer-1',
      kind: 'request',
      bytes: Buffer.from('{"cited":true}'),
      envelope: { eventTs: NOW - 48 * HOUR },
    });
    seedInference(NOW - 48 * HOUR, { req: hash });

    const result = pruneActivityDb(db, CUTOFF);

    expect(result.rawBlob).toBe(1);
    expect(store.getBlob(hash)).toBeNull();
  });

  it('matches a response_sha256 citation, not only request_sha256', () => {
    const store = createRawBodyStore(db, { logger: silentLogger() });
    const { hash } = store.appendBody({
      memberName: 'engineer-1',
      kind: 'response',
      bytes: Buffer.from('{"answer":true}'),
      envelope: { eventTs: NOW - 48 * HOUR },
    });
    seedInference(NOW - 1 * HOUR, { res: hash });

    expect(pruneActivityDb(db, CUTOFF).rawBlob).toBe(0);
    expect(store.getBlob(hash)?.toString()).toBe('{"answer":true}');
  });
});

describe('retention indexes', () => {
  it('creates a ts index for each present table so the DELETE is not a scan', () => {
    seedActivity(NOW - 1 * HOUR);
    seedTelemetry(NOW - 1 * HOUR);
    pruneActivityDb(db, CUTOFF);

    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toContain('member_activity_ts_idx');
    expect(names).toContain('telemetry_ts_ms_idx');
  });
});
