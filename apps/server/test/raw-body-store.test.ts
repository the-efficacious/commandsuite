/**
 * Raw-body store tests.
 *
 * Covers the content-addressed round-trip (gzip at rest, sha256
 * re-verified on read), whole-body dedup (same bytes twice → one blob,
 * two exchange rows), the fill-NULLs-only `assignRequestId` bridge,
 * `list` filters, and `stats` raw-vs-stored visibility. The invariant
 * under test: `getBlob(hash)` returns EXACTLY the appended bytes, or
 * null when the stored blob no longer verifies.
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { createRawBodyStore } from '../src/raw-body-store.js';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Silent logger — the corruption test warns on purpose. */
const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// Repetitive JSON compresses well — lets stats assert stored < raw.
const REQUEST_BYTES = Buffer.from(
  JSON.stringify({
    model: 'claude-opus-4-6',
    messages: Array.from({ length: 20 }, () => ({
      role: 'user',
      content: [{ type: 'text', text: 'the same text over and over again' }],
    })),
  }),
  'utf8',
);
const RESPONSE_BYTES = Buffer.from(
  JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'ok' }] }),
  'utf8',
);

describe('raw body store', () => {
  it('round-trips bytes verbatim: sha256 key, gzip at rest, verified read', () => {
    const store = createRawBodyStore(openDatabase(':memory:'));
    const { hash, exchangeId } = store.appendBody({
      memberName: 'alice',
      kind: 'request',
      bytes: REQUEST_BYTES,
      envelope: {
        promptId: 'prompt-1',
        sessionId: 'session-1',
        querySource: 'repl_main_thread',
        model: 'claude-opus-4-6',
        eventTs: 1_700_000_000_001,
      },
    });

    expect(hash).toBe(sha256(REQUEST_BYTES));
    expect(exchangeId).toBeGreaterThan(0);
    // getBlob gunzips and re-verifies the content address.
    expect(store.getBlob(hash)?.equals(REQUEST_BYTES)).toBe(true);

    const [row] = store.list();
    expect(row).toMatchObject({
      id: exchangeId,
      memberName: 'alice',
      kind: 'request',
      hash,
      bodyLength: REQUEST_BYTES.length,
      requestId: null,
      promptId: 'prompt-1',
      sessionId: 'session-1',
      querySource: 'repl_main_thread',
      agentName: null,
      model: 'claude-opus-4-6',
      eventTs: 1_700_000_000_001,
    });
    expect(row?.receivedAt).toBeGreaterThan(0);
  });

  it('dedups byte-identical bodies: one blob, two exchange rows', () => {
    const store = createRawBodyStore(openDatabase(':memory:'));
    const a = store.appendBody({ memberName: 'alice', kind: 'request', bytes: REQUEST_BYTES });
    const b = store.appendBody({ memberName: 'bob', kind: 'request', bytes: REQUEST_BYTES });

    expect(a.hash).toBe(b.hash);
    expect(a.exchangeId).not.toBe(b.exchangeId);

    const stats = store.stats();
    expect(stats.blobs).toBe(1);
    expect(stats.exchanges).toBe(2);
    expect(store.count()).toBe(2);
    // Both exchange rows point at the shared blob.
    expect(store.list({ hash: a.hash })).toHaveLength(2);
  });

  it('reports raw vs stored byte totals (gzip visibly compresses)', () => {
    const store = createRawBodyStore(openDatabase(':memory:'));
    store.appendBody({ memberName: 'alice', kind: 'request', bytes: REQUEST_BYTES });
    store.appendBody({ memberName: 'alice', kind: 'response', bytes: RESPONSE_BYTES });

    const stats = store.stats();
    expect(stats.blobs).toBe(2);
    expect(stats.exchanges).toBe(2);
    expect(stats.rawBytes).toBe(REQUEST_BYTES.length + RESPONSE_BYTES.length);
    expect(stats.storedBytes).toBeGreaterThan(0);
    // The repetitive request body must compress below its raw size.
    expect(stats.storedBytes).toBeLessThan(stats.rawBytes);
  });

  it('getBlob returns null (never wrong bytes) on a hash mismatch', () => {
    const db = openDatabase(':memory:');
    const store = createRawBodyStore(db, { logger: quiet });
    const { hash } = store.appendBody({
      memberName: 'alice',
      kind: 'request',
      bytes: REQUEST_BYTES,
    });

    // Corrupt the blob in place: valid gzip, wrong content.
    db.prepare('UPDATE raw_blob SET bytes = ? WHERE hash = ?').run(
      gzipSync(Buffer.from('tampered', 'utf8')),
      hash,
    );
    expect(store.getBlob(hash)).toBeNull();

    // Corrupt to a non-gzip payload: gunzip failure also yields null.
    db.prepare('UPDATE raw_blob SET bytes = ? WHERE hash = ?').run(
      Buffer.from('not gzip at all', 'utf8'),
      hash,
    );
    expect(store.getBlob(hash)).toBeNull();

    // Unknown hash → null, no throw.
    expect(store.getBlob('0'.repeat(64))).toBeNull();
  });

  it('assignRequestId fills only NULL fields, never overwriting', () => {
    const store = createRawBodyStore(openDatabase(':memory:'));
    const { exchangeId } = store.appendBody({
      memberName: 'alice',
      kind: 'request',
      bytes: REQUEST_BYTES,
      envelope: { querySource: 'from_capture' },
    });

    store.assignRequestId(exchangeId, {
      requestId: 'req_011C',
      querySource: 'from_bridge',
      agentName: 'general-purpose',
    });

    const [row] = store.list();
    expect(row?.requestId).toBe('req_011C');
    // Already-set field is preserved; NULL field is filled.
    expect(row?.querySource).toBe('from_capture');
    expect(row?.agentName).toBe('general-purpose');

    // A second assign cannot overwrite the request_id either.
    store.assignRequestId(exchangeId, { requestId: 'req_other' });
    expect(store.list()[0]?.requestId).toBe('req_011C');
  });

  it('list filters by member, kind, request_id, and event_ts range', () => {
    const store = createRawBodyStore(openDatabase(':memory:'));
    store.appendBody({
      memberName: 'alice',
      kind: 'request',
      bytes: REQUEST_BYTES,
      envelope: { eventTs: 1000 },
    });
    store.appendBody({
      memberName: 'alice',
      kind: 'response',
      bytes: RESPONSE_BYTES,
      envelope: { requestId: 'req_1', eventTs: 2000 },
    });
    store.appendBody({
      memberName: 'bob',
      kind: 'request',
      bytes: RESPONSE_BYTES,
      envelope: { eventTs: 3000 },
    });

    expect(store.list({ memberName: 'alice' })).toHaveLength(2);
    expect(store.list({ kind: 'request' })).toHaveLength(2);
    expect(store.list({ requestId: 'req_1' })).toHaveLength(1);
    expect(store.list({ from: 1500, to: 2500 })).toHaveLength(1);
    expect(store.list({ limit: 1 })).toHaveLength(1);
    // Oldest-first by event_ts.
    expect(store.list().map((r) => r.eventTs)).toEqual([1000, 2000, 3000]);
  });

  it('is durable across separate store handles on the same DB', () => {
    const db = openDatabase(':memory:');
    const first = createRawBodyStore(db);
    const { hash } = first.appendBody({
      memberName: 'alice',
      kind: 'request',
      bytes: REQUEST_BYTES,
    });
    const second = createRawBodyStore(db);
    expect(second.count()).toBe(1);
    expect(second.getBlob(hash)?.equals(REQUEST_BYTES)).toBe(true);
  });
});
