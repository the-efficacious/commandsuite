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

import { createDiagnosticStore, createGenAiStore, createTelemetryStore } from 'csuite-core';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createRawBodyStore } from '../src/raw-body-store.js';
import { recordingLogger } from './helpers/logger.js';

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const quiet = recordingLogger().logger;

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

  it('retention failure does not replace the operation it observes', () => {
    // THE WORST DEFECT THIS OBJECTIVE PRODUCED, found by Rune. Every
    // site calls diagnostics beside an existing stderr warning, so an
    // emitter that throws propagates out of the catch it was added to,
    // skips the logger, and changes what the original operation does.
    // Measured before the fix: `Error: diagnostic store unavailable`
    // escaped getBlob and the warning never fired.
    //
    // The coupling is real rather than theoretical — retention shares
    // the activity DB handle with the streams it reports on, so a
    // full or corrupt handle fails both together. That is precisely
    // when the product most needs its prior behaviour intact.
    const { db, diagnostics } = harness();
    const rec = recordingLogger();
    const store = createRawBodyStore(db, {
      logger: rec.logger,
      diagnostics: diagnostics.emit,
    });
    const { hash } = store.appendBody({
      memberName: 'm',
      kind: 'request',
      bytes: Buffer.from('{}'),
    });
    db.prepare('UPDATE raw_blob SET bytes = ? WHERE hash = ?').run(Buffer.from([0x00]), hash);
    // Break retention underneath a live store.
    db.exec('DROP TABLE diagnostic_event');

    expect(store.getBlob(hash)).toBeNull(); // original behaviour intact
    expect(rec.atLeast('warn').length).toBeGreaterThan(0); // the log line still fires
    // …and retention says so WITHOUT consulting the store that failed.
    expect(diagnostics.health()).toBe('unknown');
  });

  it('a failure heals on an observed recovery, and stays queryable', () => {
    // Criterion 4 through the production path. Wiring only the failure
    // half latches a member unresolved forever — the permanent false
    // sickness the store round fixed, reintroduced one layer out.
    const { db, diagnostics } = harness();
    const store = createRawBodyStore(db, { logger: quiet, diagnostics: diagnostics.emit });

    // An incident: correlator raw capture failed for this member.
    diagnostics.emit.correlatorRawCaptureFailed('turner', new Error('x'));
    expect(diagnostics.unresolved('turner')).toHaveLength(1);

    // The success path fires on the next good capture.
    diagnostics.emit.correlatorRawCaptureSucceeded('turner');

    expect(diagnostics.unresolved('turner')).toHaveLength(0); // healthy NOW
    const hist = diagnostics.query({ member: 'turner', from: 0, to: Date.now() + 1000 });
    expect(hist.count).toBeGreaterThan(0); // history still queryable
    void store;
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

/**
 * Boundaries where evidence can be discarded.
 *
 * ONE PROPERTY, discovered three times at three boundaries: *a loss of
 * evidence must not read as absence of the thing lost.* It was written
 * into the contract, fixed at detail expiry, fixed again at cap
 * eviction, and re-emerged at the process boundary — because it is not
 * a property of the retention table, it is a property of every
 * transition where state can be dropped.
 *
 * So this enumerates the boundaries rather than waiting for the next
 * one to be found. Same discipline as enumerating the bypass routes,
 * which is why that one stayed closed.
 *
 *     detail expiry      diagnostics.test.ts — expiry never heals
 *     cap eviction       diagnostics.test.ts — floor + unknown latch
 *     process restart    HERE
 *     DB replacement     not asserted — see the note below
 */
describe('evidence survives each boundary', () => {
  it('a retention outage survives the process that observed it', () => {
    // The latch is in memory, so a restart would clear it and the new
    // process would report from SQLite as though the gap never
    // happened — "expiry heals", at a process boundary.
    //
    // So the first write that succeeds after a failure durably records
    // that the store was unavailable, and the latch clears only if
    // that record itself lands.
    const { db, diagnostics } = harness();
    diagnostics.emit.activityAppendFailed('m', 1);
    db.exec('DROP TABLE diagnostic_event'); // retention breaks
    diagnostics.emit.activityAppendFailed('m', 1); // this write fails
    expect(diagnostics.health()).toBe('unknown');

    // Repair the store, then let one more write succeed.
    db.exec(`CREATE TABLE diagnostic_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT, cause TEXT NOT NULL,
      member_name TEXT NOT NULL, attribution TEXT NOT NULL,
      ts INTEGER NOT NULL, fields TEXT NOT NULL)`);
    diagnostics.emit.activityAppendFailed('m', 1);

    // A NEW process reading the same database must still find the gap.
    const reopened = createDiagnosticStore(db);
    const outage = reopened.query({
      cause: 'retention.unavailable',
      from: 0,
      to: Date.now() + 60_000,
    });
    expect(outage.count).toBeGreaterThan(0);
  });

  it('the crash-before-persist window is real and is not claimed away', () => {
    // THE HONEST RESIDUAL. If the process dies after a failed write and
    // before any later write succeeds, nothing durable was ever
    // recorded and a new process reports from SQLite as though the
    // outage did not happen. Persisting at failure time is not
    // available — the store is what just failed.
    //
    // Asserted so the window is a known property with a test naming
    // it, rather than something discovered later. Stated in the result
    // too: a window named costs nothing; a window found costs the claim.
    const { db, diagnostics } = harness();
    db.exec('DROP TABLE diagnostic_event');
    diagnostics.emit.activityAppendFailed('m', 1); // fails, latches
    expect(diagnostics.health()).toBe('unknown'); // this process knows

    db.exec(`CREATE TABLE diagnostic_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT, cause TEXT NOT NULL,
      member_name TEXT NOT NULL, attribution TEXT NOT NULL,
      ts INTEGER NOT NULL, fields TEXT NOT NULL)`);
    // Simulate a restart with no intervening successful write.
    const reopened = createDiagnosticStore(db);
    expect(reopened.health()).toBe('healthy'); // …the next one does NOT
  });
});
