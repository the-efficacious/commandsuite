/**
 * End-to-end: a real failure at a real call site is RETAINED.
 *
 * Everything before this commit was mechanism. The store was correct,
 * the emitter was correct, eleven repairs were verified — and nothing
 * was retained, because no call site reported into it. This is the
 * file that turns "nothing is retained in practice" into a false
 * statement, so it drives the actual modules rather than the emitter.
 *
 * Each test provokes a genuine failure the way production would — a
 * corrupt blob, an unserializable record — and asserts the diagnostic
 * survives in the store, attributed, with the raw material converted.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createDiagnosticStore } from '../src/diagnostics.js';
import { createGenAiStore } from '../src/genai-store.js';
import { createRawBodyStore } from '../src/raw-body-store.js';
import { createTelemetryStore } from '../src/telemetry-store.js';

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function harness() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const diagnostics = createDiagnosticStore(db);
  return { db, diagnostics };
}

/** Everything in the retention tables, regardless of window. */
function rows(db: ReturnType<typeof openDatabase>) {
  return db
    .prepare('SELECT cause, member_name, attribution, fields FROM diagnostic_event ORDER BY id')
    .all() as Array<{ cause: string; member_name: string; attribution: string; fields: string }>;
}

describe('wiring: a real failure is retained', () => {
  it('a corrupt blob is retained and attributed to its referents', () => {
    // The production path: getBlob(hash) finds a row whose bytes do not
    // gunzip. It has no member — the emitter resolves the affected set
    // from raw_exchange, which the store itself wrote.
    const { db, diagnostics } = harness();
    const store = createRawBodyStore(db, { logger: quiet, diagnostics: diagnostics.emit });

    const { hash } = store.appendBody({
      memberName: 'turner',
      kind: 'request',
      bytes: Buffer.from('{"a":1}'),
    });
    // Corrupt the stored bytes so gunzip fails on read.
    db.prepare('UPDATE raw_blob SET bytes = ? WHERE hash = ?').run(
      Buffer.from([0x00, 0x01, 0x02]),
      hash,
    );

    expect(store.getBlob(hash)).toBeNull(); // the failure actually happens

    const r = rows(db).filter((x) => x.cause.startsWith('rawstore.'));
    expect(r).toHaveLength(1);
    expect(r[0]?.member_name).toBe('turner'); // resolved, not passed in
    expect(r[0]?.attribution).toBe('affected');
    expect(r[0]?.fields).toContain(hash);
  });

  it('an unserializable gen_ai record is retained against its member', () => {
    const { db, diagnostics } = harness();
    const store = createGenAiStore(db, { logger: quiet, diagnostics: diagnostics.emit });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic; // JSON.stringify throws

    // `append` takes ONE record. My first fixture passed an array, so
    // `rec.inputMessages` was undefined, the stringify never threw, and
    // the failure came from the INSERT instead — a different defect
    // than the one under test.
    store.append('lea', {
      responseId: 'r1',
      operationName: 'chat',
      provider: 'anthropic',
      model: 'claude',
      // biome-ignore lint/suspicious/noExplicitAny: deliberately unserializable
      inputMessages: cyclic as any,
      ts: 1,
    } as never);

    const r = rows(db).filter((x) => x.cause.startsWith('genaistore.'));
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]?.member_name).toBe('lea');
  });

  it('an unserializable telemetry record is retained against its member', () => {
    const { db, diagnostics } = harness();
    const store = createTelemetryStore(db, { logger: quiet, diagnostics: diagnostics.emit });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    store.append('turner', [
      // biome-ignore lint/suspicious/noExplicitAny: deliberately unserializable
      { name: 'x', ts: 1, attributes: cyclic as any } as never,
    ]);

    const r = rows(db).filter((x) => x.cause.startsWith('telemetrystore.'));
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]?.member_name).toBe('turner');
  });

  it('a store constructed WITHOUT diagnostics still works and retains nothing', () => {
    // Retention is optional by design: a broker without it behaves
    // exactly as before. "No opinion" has to be a real state here too.
    const { db } = harness();
    const store = createRawBodyStore(db, { logger: quiet });
    const { hash } = store.appendBody({
      memberName: 'm',
      kind: 'request',
      bytes: Buffer.from('{}'),
    });
    db.prepare('UPDATE raw_blob SET bytes = ? WHERE hash = ?').run(Buffer.from([0x00]), hash);

    expect(store.getBlob(hash)).toBeNull();
    expect(rows(db).filter((x) => x.cause.startsWith('rawstore.'))).toHaveLength(0);
  });
});
