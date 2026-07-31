/**
 * Retained completeness diagnostics.
 *
 * The criteria this store exists to satisfy compose badly, and the
 * compositions are what these tests are mostly about:
 *
 *   - a bound on detail PLUS a surviving fact per expired entry is an
 *     unbounded table with a different name;
 *   - "expiry must not read clean" PLUS a surviving fact leaves a member
 *     who failed Monday and recovered Tuesday sick forever;
 *   - a hard cap PLUS a query surface that answers zero satisfies the
 *     disk budget by destroying the evidence it was protecting.
 *
 * Each of those passes a per-property review and fails as a system, so
 * each has a test below asserting the interaction rather than the part.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import {
  causeSpec,
  classifyError,
  createDiagnosticStore,
  DIAGNOSTIC_CAUSES,
  digestPath,
  safeHash,
} from '../src/diagnostics.js';

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

/**
 * These exercise the STORE's mechanics — caps, floors, folding,
 * coverage — through generic `record`, which is why it stays on the
 * surface. What stops a call site inventing a field value is the brand
 * plus runtime shape validation, not the reachability of this method.
 * Emitter behaviour has its own tests below.
 */
function store(opts: Parameters<typeof createDiagnosticStore>[1] = {}) {
  const db = openDatabase(':memory:');
  dbs.push(db);
  let clock = T0;
  const s = createDiagnosticStore(db, { now: () => clock, ...opts });
  return {
    s,
    db,
    at(t: number) {
      clock = t;
    },
  };
}

describe('safe context', () => {
  it('never retains a path, only a digest and a length', () => {
    // These sites carry OTLP `body_ref` values — attacker-influenced
    // filesystem paths. A durable, agent-queryable store must not become
    // the place they are archived.
    const secret = '/tmp/csuite-otel-bodies-Turner-1495904/req-abc123.json';
    const d = digestPath(secret);

    expect(d.pathDigest).toHaveLength(16);
    expect(d.pathLength).toBe(secret.length);
    expect(JSON.stringify(d)).not.toContain('Turner');
    expect(JSON.stringify(d)).not.toContain('/tmp');
  });

  it('never retains Error.message, even for an unrecognised error', () => {
    // The message is the field most likely to contain a token, a path,
    // or a fragment of a request body.
    const err = new Error('failed reading /home/aprzy/.secret token=sk-live-9f3');
    expect(classifyError(err)).toBe('unclassified');
    expect(classifyError(err)).not.toContain('sk-live');
  });

  it('classifies a known errno and passes nothing else through', () => {
    const e = Object.assign(new Error('nope'), { code: 'ENOENT' });
    expect(classifyError(e)).toBe('ENOENT');
    const weird = Object.assign(new Error('nope'), { code: 'E_CUSTOM_/etc/passwd' });
    expect(classifyError(weird)).toBe('unclassified');
  });

  it('keeps only the fields the CAUSE permits, and no unknown keys', () => {
    // Truncating a value is not refusing it. The policy is a property
    // of the cause, so a hash offered to a path-only cause is dropped
    // rather than stored at 64 characters.
    const { s, db } = store();
    s.record({
      cause: 'correlator.body_ref_unreadable', // policy: ['path']
      members: ['turner'],
      // biome-ignore lint/suspicious/noExplicitAny: deliberately hostile input
      fields: { ...digestPath('/tmp/x'), hash: 'a'.repeat(64), secret: '/etc/shadow' } as any,
    });
    const row = db.prepare('SELECT fields FROM diagnostic_event').get() as { fields: string };
    expect(row.fields).toContain('pathDigest'); // permitted
    expect(row.fields).not.toContain('abc'); // hash: not permitted for this cause
    expect(row.fields).not.toContain('shadow'); // unknown key: never
  });

  it('the caller cannot choose attribution — the cause owns it', () => {
    // A caller could previously pair `members: []` with 'producer', or
    // declare a blob corruption attributable to whoever read it.
    const { s, db } = store();
    s.record({ cause: 'activity.append_failed', members: [] });
    const row = db.prepare('SELECT attribution FROM diagnostic_event').get() as {
      attribution: string;
    };
    expect(row.attribution).toBe('unattributed');
  });
});

describe('attribution', () => {
  it('records unattributed explicitly rather than omitting the row', () => {
    // `getBlob(hash)` has no member. Dropping the event would make the
    // store silent about exactly the corruption it exists to surface.
    const { s } = store();
    s.record({ cause: 'rawstore.blob_gunzip_failed' });

    const r = s.query({ member: null, from: T0 - HOUR, to: T0 + HOUR });
    expect(r.count).toBe(1);
  });

  it('records one row per affected member when a blob has several', () => {
    // Content addressing is many-to-one: one corrupt blob can be
    // referenced by several members. Picking the caller would be false
    // attribution inside the store built to prevent false absence.
    const { s } = store();
    s.record({
      cause: 'rawstore.blob_hash_mismatch',
      members: ['turner', 'lea'],
      fields: safeHash('d'.repeat(64)),
    });

    expect(s.query({ member: 'turner', from: T0 - HOUR, to: T0 + HOUR }).count).toBe(1);
    expect(s.query({ member: 'lea', from: T0 - HOUR, to: T0 + HOUR }).count).toBe(1);
    expect(s.query({ from: T0 - HOUR, to: T0 + HOUR }).count).toBe(2);
  });
});

describe('current health vs historical presence', () => {
  it('a recovered member is currently healthy while the failure stays queryable', () => {
    // THE COMPOSITION. "Expiry must not read clean" plus a surviving
    // historical fact leaves a member sick forever unless recovery is
    // an observed event. Permanent false sickness is the mirror of
    // permanent false health and just as wrong.
    const h = store();
    h.at(T0);
    h.s.record({
      cause: 'activity.append_failed',
      members: ['turner'],
    });
    expect(h.s.unresolved('turner')).toHaveLength(1);

    h.at(T0 + DAY);
    h.s.resolve('activity.append_failed', 'turner');

    expect(h.s.unresolved('turner')).toHaveLength(0); // currently healthy
    expect(h.s.query({ member: 'turner', from: T0 - HOUR, to: T0 + HOUR }).count).toBe(1); // Monday still there
  });

  it('detail expiry does NOT heal an unresolved failure', () => {
    // The other half. If a sweep could clear unresolved state, the disk
    // bound would be satisfied by erasing the evidence.
    const h = store({ detailMs: HOUR });
    h.at(T0);
    h.s.record({
      cause: 'correlator.raw_capture_failed',
      members: ['turner'],
    });

    h.at(T0 + 10 * DAY);
    h.s.sweep();

    expect(h.s.unresolved('turner')).toHaveLength(1);
    expect(h.s.unresolved('turner')[0]?.since).toBe(T0);
  });
});

describe('retention and coverage', () => {
  it('folds detail into hour buckets, and the count survives', () => {
    const h = store({ detailMs: HOUR });
    h.at(T0);
    for (let i = 0; i < 3; i++) {
      h.s.record({ cause: 'otlp.genai_ingest_failed', members: ['lea'] });
    }
    h.at(T0 + 5 * HOUR);
    h.s.sweep();

    const r = h.s.query({ member: 'lea', from: T0 - HOUR, to: T0 + 6 * HOUR });
    expect(r.count).toBe(3);
    expect(r.coverage).toBe('bucket');
    expect(r.resolution).toBe('hour');
  });

  it('a sub-bucket window answers at bucket resolution, never as a bare count', () => {
    // Seamus's rule: overlap is evidence at the bucket's resolution, not
    // proof the event fell inside the requested sub-window. The caller
    // gets the interval actually answered and a coverage flag.
    const h = store({ detailMs: HOUR });
    h.at(T0);
    h.s.record({ cause: 'otlp.logs_store_failed', members: ['lea'] });
    h.at(T0 + 5 * HOUR);
    h.s.sweep();

    const r = h.s.query({ member: 'lea', from: T0 + 60_000, to: T0 + 120_000 });
    expect(r.coverage).toBe('bucket');
    expect(r.resolution).toBe('hour');
    // The answered interval is wider than the request — it must say so.
    expect(r.interval.to - r.interval.from).toBeGreaterThan(120_000 - 60_000);
  });

  it('sweeping twice does not double a count', () => {
    // Idempotence. A rollup that accumulates on every sweep inflates
    // history silently, and nothing downstream could tell.
    const h = store({ detailMs: HOUR });
    h.at(T0);
    h.s.record({
      cause: 'codex.genai_ingest_entry_failed',
      members: ['x'],
    });
    h.at(T0 + 5 * HOUR);
    h.s.sweep();
    const once = h.s.query({ member: 'x', from: T0 - HOUR, to: T0 + 6 * HOUR }).count;
    h.s.sweep();
    h.s.sweep();
    const thrice = h.s.query({ member: 'x', from: T0 - HOUR, to: T0 + 6 * HOUR }).count;

    expect(once).toBe(1);
    expect(thrice).toBe(1);
  });

  it('a query below the coverage floor is indeterminate, NOT zero', () => {
    // The criterion-4 trap: a cap that evicts and then answers zero
    // satisfies the disk budget by destroying the evidence. The floor
    // makes eviction speak.
    const h = store({ detailMs: HOUR, hourMs: 2 * HOUR, dayMs: 3 * DAY });
    h.at(T0);
    h.s.record({ cause: 'rawstore.blob_gunzip_failed' });

    h.at(T0 + 30 * DAY);
    h.s.sweep();

    const r = h.s.query({ member: null, from: T0 - HOUR, to: T0 + HOUR });
    expect(r.coverage).toBe('indeterminate');
    expect(r.resolution).toBe('none');
    // Explicitly NOT a confident zero: the count is 0 but coverage says
    // the answer is unknown, and a caller must read coverage first.
    expect(h.s.coverageFloor()).toBeGreaterThan(T0);
  });

  it('hitting the hard row cap raises the floor rather than silently forgetting', () => {
    const h = store({ maxDetailRows: 5 });
    h.at(T0);
    for (let i = 0; i < 20; i++) {
      h.at(T0 + i * 1000);
      h.s.record({ cause: 'activity.append_failed', members: ['m'] });
    }

    expect(h.s.coverageFloor()).toBeGreaterThanOrEqual(T0);
    expect(h.s.query({ member: 'm', from: T0, to: T0 + 100_000 }).coverage).toBe('indeterminate');
  });
});

describe('retention health', () => {
  it('is healthy with no overflow', () => {
    const { s } = store();
    expect(s.health()).toBe('healthy');
  });

  it('reports degraded while it is actively shedding evidence', () => {
    // Criterion 7: if the audit signal is itself lossy, say so — or this
    // objective recreates itself one layer down.
    const h = store({ maxDetailRows: 2 });
    h.at(T0);
    for (let i = 0; i < 10; i++) {
      h.at(T0 + i * 1000);
      h.s.record({ cause: 'activity.append_failed', members: ['m'] });
    }
    expect(h.s.health()).toBe('degraded');
  });
});

describe('cause enum', () => {
  it('is finite, unique, and covers the 21 in-scope sites plus overflow', () => {
    // This is the cardinality basis for the bucket tables. If it stops
    // being closed, criterion 4's bound stops being true.
    const set = new Set(DIAGNOSTIC_CAUSES);
    expect(set.size).toBe(DIAGNOSTIC_CAUSES.length);
    expect(DIAGNOSTIC_CAUSES.length).toBe(23); // 21 sites + overflow + fanout_truncated
  });
});

/**
 * Regressions for the seven defects Seamus found before wiring.
 *
 * Every one of them passed the suite above. That is the point of
 * writing them down here rather than folding them in: each defect had
 * coverage that could not see it, and the case that discriminates is
 * usually one repetition or one boundary away from the case that does
 * not.
 */
describe('repairs', () => {
  it('two unattributed events fold to ONE bucket row, not one row per event', () => {
    // SQLite does not consider two NULLs equal, so a nullable column in
    // a composite PRIMARY KEY silently defeats ON CONFLICT. Measured
    // before the fix: NULL gave 2 rows where a real member gave 1. The
    // original test recorded ONE unattributed event and passed.
    const h = store({ detailMs: HOUR });
    h.at(T0);
    h.s.record({ cause: 'rawstore.blob_gunzip_failed' });
    h.s.record({ cause: 'rawstore.blob_gunzip_failed' });
    h.at(T0 + 5 * HOUR);
    h.s.sweep();

    const rows = h.db.prepare(`SELECT COUNT(*) AS r, SUM(n) AS n FROM diagnostic_bucket`).get() as {
      r: number;
      n: number;
    };
    expect(Number(rows.r)).toBe(1);
    expect(Number(rows.n)).toBe(2);
  });

  it('unresolved state for the same unattributed cause is one row, not two', () => {
    const h = store();
    h.s.record({ cause: 'otlp.logs_store_failed' });
    h.s.record({ cause: 'otlp.logs_store_failed' });
    expect(h.s.unresolved(null)).toHaveLength(1);
  });

  it('a narrow window does not count evidence from a neighbouring bucket', () => {
    // The overlap predicate was `bucket_start >= from - DAY`, which
    // admitted every bucket in the preceding 24h. A Wednesday query
    // could count Tuesday.
    const h = store({ detailMs: HOUR });
    h.at(T0);
    h.s.record({ cause: 'otlp.logs_store_failed', members: ['lea'] });
    h.at(T0 + 10 * HOUR);
    h.s.sweep();

    // A window three hours AFTER the recorded hour must see nothing.
    const r = h.s.query({ member: 'lea', from: T0 + 3 * HOUR, to: T0 + 4 * HOUR });
    expect(r.count).toBe(0);
  });

  it('a query starting exactly AT the coverage floor is indeterminate', () => {
    // The floor was the last timestamp REMOVED, and the guard was
    // `from < floor` — so a query starting on that exact instant passed
    // and answered confidently from survivors. The floor is now the
    // first fully covered instant.
    const h = store({ maxDetailRows: 2 });
    h.at(T0);
    for (let i = 0; i < 10; i++) {
      h.at(T0 + i * 1000);
      h.s.record({ cause: 'activity.append_failed', members: ['m'] });
    }
    // The DISCRIMINATING instant is the newest one destroyed, not
    // `floor - 1`. Ten records at T0..T0+9000 with a cap of 2 destroys
    // T0..T0+7000, so T0+7000 is the last instant whose evidence is
    // gone. With the floor defined inclusively that query passed the
    // `from < floor` guard and answered confidently from survivors;
    // with the floor as the first COVERED instant it cannot.
    const destroyed = T0 + 7000;
    expect(h.s.query({ member: 'm', from: destroyed, to: T0 + 9000 }).coverage).toBe(
      'indeterminate',
    );
    expect(h.s.coverageFloor()).toBeGreaterThan(destroyed);
  });

  it('an overflow is a queryable event, not only a counter', () => {
    // "Record an overflow fact" is not met by a number no query surface
    // returns. A caller asking what happened to a window has to be able
    // to see that evidence was shed.
    const h = store({ maxDetailRows: 2 });
    h.at(T0);
    for (let i = 0; i < 10; i++) {
      h.at(T0 + i * 1000);
      h.s.record({ cause: 'activity.append_failed', members: ['m'] });
    }
    // Queried from the coverage floor, not below it: a window reaching
    // below the floor is correctly `indeterminate`, and asking for one
    // proves nothing about whether the fact was recorded. That was this
    // test's own first mistake.
    // Keep going AFTER the first overflows. Written as detail events
    // the overflow facts are themselves evicted by the cap that
    // produced them — destroyed by the mechanism they report — and only
    // survive a query that stops before later events push them out.
    // Folded to a bucket they persist and stay bounded.
    for (let i = 10; i < 40; i++) {
      h.at(T0 + i * 1000);
      h.s.record({ cause: 'activity.append_failed', members: ['m'] });
    }
    const r = h.s.query({
      cause: 'retention.overflow',
      from: h.s.coverageFloor(),
      to: T0 + 60_000,
    });
    expect(r.count).toBeGreaterThan(0);
    expect(r.coverage).not.toBe('indeterminate');

    // AND it must not live in the capped table at all. Written as a
    // detail event the fact is subject to the very cap that produced
    // it; a fixture where overflow keeps recurring hides that, because
    // a fresh one is always present. This asserts the design rather
    // than the symptom.
    const inDetail = h.db
      .prepare(`SELECT COUNT(*) AS n FROM diagnostic_event WHERE cause = 'retention.overflow'`)
      .get() as { n: number };
    expect(Number(inDetail.n)).toBe(0);
  });

  it('unresolved state is capped — it was the last unbounded axis', () => {
    // Events and buckets had caps; (cause, member) did not, and member
    // cardinality is exactly the axis the contract named.
    const h = store({ maxStateRows: 5 });
    for (let i = 0; i < 50; i++) {
      h.at(T0 + i);
      h.s.record({ cause: 'activity.append_failed', members: [`m${i}`] });
    }
    const n = h.db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_state`).get() as { n: number };
    expect(Number(n.n)).toBeLessThanOrEqual(5);
  });

  it('a POINT cause creates no unresolved state', () => {
    // Wiring all 21 sites with unconditional state would mark every
    // member permanently sick from their first malformed record — the
    // mirror of permanent false health, shipped as its fix.
    const h = store();
    h.s.record({
      cause: 'genaistore.malformed_row_skipped',
      members: ['lea'],
    });
    expect(h.s.unresolved('lea')).toHaveLength(0);
    // …but it is still history.
    expect(h.s.query({ member: 'lea', from: T0 - HOUR, to: T0 + HOUR }).count).toBe(1);
  });

  it('an INCIDENT cause does create unresolved state', () => {
    const h = store();
    h.s.record({ cause: 'activity.append_failed', members: ['lea'] });
    expect(h.s.unresolved('lea')).toHaveLength(1);
  });

  it('the affected-member fanout is bounded', () => {
    const h = store();
    h.s.record({
      cause: 'rawstore.blob_hash_mismatch',
      members: Array.from({ length: 5000 }, (_, i) => `m${i}`),
    });
    const n = h.db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_event`).get() as { n: number };
    expect(Number(n.n)).toBeLessThanOrEqual(256);
  });
});

/**
 * Rune's four checkpoint failures, reproduced with his fixtures.
 *
 * These four passed my suite at `767b6d0` while I claimed all seven
 * findings were repaired. Three of them are defects my own repairs
 * INTRODUCED — the caps and the fanout bound each created a new silent
 * loss while closing an older one. The fourth is a finding I
 * acknowledged and did not implement.
 *
 * Kept with his parameter values rather than re-derived, so the record
 * shows the exact shapes that discriminated.
 */
describe('checkpoint regressions', () => {
  it('an evicted unresolved member does not read clean — health latches to unknown', () => {
    // maxStateRows: 1, his fixture. The cap added to satisfy "never
    // evict evidence and return clean" was itself evicting evidence and
    // returning clean, and `health()` then aged back to healthy after
    // detailMs although the lost state can never be reconstructed.
    const h = store({ maxStateRows: 1 });
    h.at(T0);
    h.s.record({ cause: 'activity.append_failed', members: ['evicted'] });
    h.at(T0 + 1000);
    h.s.record({ cause: 'activity.append_failed', members: ['kept'] });

    expect(h.s.unresolved('evicted')).toHaveLength(0); // the state is genuinely gone
    expect(h.s.health()).toBe('unknown'); // …and the store says so

    // It must NOT age back to healthy. Time does not reconstruct it.
    h.at(T0 + 400 * DAY);
    expect(h.s.health()).toBe('unknown');
  });

  it('the bucket cap does not break its own bound by recording its overflow', () => {
    // maxBucketRows: 1, his fixture. Deleting exactly to the cap and
    // then inserting the overflow fact left the table at max + 1: a
    // bound that breaks itself by reporting that it was reached. He
    // measured 2 rows under a cap of 1.
    const h = store({ detailMs: 1, maxBucketRows: 1 });
    h.at(T0);
    h.s.record({ cause: 'otlp.logs_store_failed', members: ['a'] });
    h.at(T0 + HOUR);
    h.s.record({ cause: 'otlp.genai_ingest_failed', members: ['b'] });
    h.at(T0 + 2 * HOUR);
    h.s.sweep();

    const n = h.db.prepare('SELECT COUNT(*) AS n FROM diagnostic_bucket').get() as { n: number };
    expect(Number(n.n)).toBeLessThanOrEqual(1);
  });

  it('an omitted member reads INDETERMINATE, not an exact zero', () => {
    // Rune's fixture: 300 affected members, then query m299. A global
    // loss fact made the loss visible in aggregate but left the
    // per-member answer confidently wrong — the retained prefix read as
    // the complete affected set. Keeping the first 256 is selection
    // masquerading as completeness, so the per-member attribution is
    // now refused wholesale rather than truncated.
    const h = store();
    h.at(T0);
    h.s.record({
      cause: 'rawstore.blob_hash_mismatch',
      members: Array.from({ length: 300 }, (_, i) => `m${i}`),
    });

    const omitted = h.s.query({ member: 'm299', from: T0 - HOUR, to: T0 + HOUR });
    expect(omitted.coverage).toBe('indeterminate');
    // And a member that WOULD have been in the retained prefix is
    // equally unknown — the prefix is not a partial answer, it is no
    // answer.
    expect(h.s.query({ member: 'm0', from: T0 - HOUR, to: T0 + HOUR }).coverage).toBe(
      'indeterminate',
    );
  });

  it('an unrelated row does not restore exactness across a refusal', () => {
    // Rune's mixed-window fixture. The refusal check was gated on the
    // member's own result count, so ONE unrelated row made the window
    // read `exact` again — asserting completeness while a refused
    // affected set from the same window might also contain them.
    //
    // Retained rows are partial evidence and are still returned. They
    // cannot restore exactness, because the refused set is precisely
    // the thing nobody can consult.
    const h = store();
    h.at(T0);
    h.s.record({ cause: 'activity.append_failed', members: ['m299'] });
    h.s.record({
      cause: 'rawstore.blob_hash_mismatch',
      members: Array.from({ length: 300 }, (_, i) => `m${i}`),
    });

    const r = h.s.query({ member: 'm299', from: T0 - HOUR, to: T0 + HOUR });
    expect(r.coverage).toBe('indeterminate');
    expect(r.count).toBeGreaterThan(0); // the retained row is still returned
  });

  it('an unfiltered query stays exact across a refusal', () => {
    // Positive control for the predicate above: the global loss fact is
    // exact, and a rule that made every query indeterminate after any
    // refusal would satisfy the test above while destroying the surface.
    const h = store();
    h.at(T0);
    h.s.record({ cause: 'activity.append_failed', members: ['m299'] });
    h.s.record({
      cause: 'rawstore.blob_hash_mismatch',
      members: Array.from({ length: 300 }, (_, i) => `m${i}`),
    });

    // `bucket` is the right answer here — the loss fact IS a bucket —
    // and the property being controlled for is that it is not
    // INDETERMINATE. A rule that made every query indeterminate after
    // any refusal would satisfy the mixed-window test above while
    // destroying the surface for everyone else.
    expect(h.s.query({ from: T0 - HOUR, to: T0 + HOUR }).coverage).not.toBe('indeterminate');
  });

  it('a forged safe field cannot be constructed OR persisted', () => {
    // The brand makes the literal fail to compile; validShape catches a
    // cast, because a brand is compile-time only and a forged value is
    // indistinguishable from a real one once written.
    const { s, db } = store();
    s.record({
      cause: 'correlator.body_ref_unreadable',
      members: ['m'],
      // biome-ignore lint/suspicious/noExplicitAny: simulates a cast past the brand
      fields: { pathDigest: 'secret-path-fragment', pathLength: 20 } as any,
    });
    const row = db.prepare('SELECT fields FROM diagnostic_event').get() as { fields: string };
    expect(row.fields).not.toContain('secret-path-fragment');
    expect(row.fields).toBe('{}');
  });

  it('a real digest from the constructor IS persisted', () => {
    // The other direction: validation must not reject legitimate values.
    const { s, db } = store();
    s.record({ cause: 'correlator.body_ref_unreadable', members: ['m'], fields: digestPath('/x') });
    const row = db.prepare('SELECT fields FROM diagnostic_event').get() as { fields: string };
    expect(row.fields).toContain('pathDigest');
  });

  it('fanout truncation records a queryable loss instead of dropping members silently', () => {
    // 300 affected members, his fixture. `slice(0, 256)` kept the first
    // 256 and dropped 44 with no fact, so the stored set looked like
    // the complete affected set.
    const h = store();
    h.at(T0);
    h.s.record({
      cause: 'rawstore.blob_hash_mismatch',
      members: Array.from({ length: 300 }, (_, i) => `m${i}`),
    });

    const loss = h.s.query({
      cause: 'retention.fanout_truncated',
      from: T0 - HOUR,
      to: T0 + HOUR,
    });
    expect(loss.count).toBeGreaterThan(0);
  });

  it('a new cause cannot silently default to point', () => {
    // `Record<string, HealthMode>` let an unregistered cause default,
    // which is the quiet-failure shape this module exists to remove,
    // inside the module. `Record<DiagnosticCause, CauseSpec>` makes it
    // a compile error; this asserts every cause has a policy at runtime
    // too, so the table cannot be widened with a cast.
    for (const c of DIAGNOSTIC_CAUSES) {
      expect(causeSpec(c), c).toBeDefined();
      expect(['point', 'incident']).toContain(causeSpec(c).mode);
    }
  });
});

/**
 * The typed emitter — criterion 9's other half.
 *
 * Each method takes RAW inputs and owns the conversion. These assert
 * that ownership: a call site hands over a path and an error and gets
 * a digest and a finite code, without ever being able to supply either.
 */
describe('typed emitter', () => {
  it('turns a raw path into a digest and never stores the path', () => {
    const { s, db } = store();
    s.emit.correlatorBodyRefUnreadable(
      'turner',
      '/tmp/csuite-otel-bodies-Turner-1495904/req.json',
      Object.assign(new Error('x'), { code: 'ENOENT' }),
    );
    const row = db.prepare('SELECT fields, member_name FROM diagnostic_event').get() as {
      fields: string;
      member_name: string;
    };
    expect(row.member_name).toBe('turner');
    expect(row.fields).toContain('pathDigest');
    expect(row.fields).not.toContain('Turner-1495904');
    expect(row.fields).not.toContain('/tmp');
  });

  it('classifies a raw thrown value and never stores its message', () => {
    const { s, db } = store();
    s.emit.correlatorRawCaptureFailed('lea', new Error('token=sk-live-9f3 at /home/x/.secret'));
    const row = db.prepare('SELECT fields FROM diagnostic_event').get() as { fields: string };
    expect(row.fields).toContain('unclassified');
    expect(row.fields).not.toContain('sk-live');
  });

  it('resolves blob attribution from raw_exchange, not from a caller', () => {
    // getBlob(hash) has no member and the blob may have several. The
    // emitter looks the affected set up rather than accepting one —
    // taking the caller's member would blame whoever read it.
    const { s, db } = store();
    db.exec(`CREATE TABLE raw_exchange (member_name TEXT NOT NULL, kind TEXT, hash TEXT NOT NULL)`);
    const h = 'c'.repeat(64);
    db.prepare(`INSERT INTO raw_exchange (member_name, kind, hash) VALUES (?,?,?)`).run(
      'turner',
      'request',
      h,
    );
    db.prepare(`INSERT INTO raw_exchange (member_name, kind, hash) VALUES (?,?,?)`).run(
      'lea',
      'response',
      h,
    );

    s.emit.rawstoreBlobHashMismatch(h);

    const rows = db
      .prepare(`SELECT member_name FROM diagnostic_event ORDER BY member_name`)
      .all() as Array<{ member_name: string }>;
    expect(rows.map((r) => r.member_name)).toEqual(['lea', 'turner']);
  });

  it('records a corrupt blob with no known referents as unattributed', () => {
    // Not dropped. A corruption nobody can be attributed for is still a
    // corruption, and omitting it would make the store silent about
    // exactly what it exists to surface.
    const { s, db } = store();
    db.exec(`CREATE TABLE raw_exchange (member_name TEXT NOT NULL, kind TEXT, hash TEXT NOT NULL)`);
    s.emit.rawstoreBlobGunzipFailed('d'.repeat(64));
    const row = db.prepare('SELECT member_name, attribution FROM diagnostic_event').get() as {
      member_name: string;
      attribution: string;
    };
    expect(row.member_name).toBe('');
    expect(row.attribution).toBe('unattributed');
  });

  it('an incident clears only on an observed recovery', () => {
    const { s } = store();
    s.emit.activityAppendFailed('turner', 12);
    expect(s.unresolved('turner')).toHaveLength(1);
    s.emit.recovered('activity.append_failed', 'turner');
    expect(s.unresolved('turner')).toHaveLength(0);
  });

  it('every emitter method is covered by the cause enum', () => {
    // The emitter and the enum must not drift: a method whose cause is
    // unregistered would write a row the census guard never sees.
    const { s, db } = store();
    db.exec(`CREATE TABLE raw_exchange (member_name TEXT NOT NULL, kind TEXT, hash TEXT NOT NULL)`);
    const e = s.emit;
    e.correlatorBodyRefUnreadable('m', '/p', new Error('x'));
    e.correlatorBodyLengthMismatch('m', 10, 4);
    e.correlatorUnlinkAfterCaptureFailed('m', '/p', new Error('x'));
    e.correlatorRawCaptureFailed('m', new Error('x'));
    e.correlatorBodyJsonParseFailed('m', 12);
    e.correlatorInferenceBuildFailed('m', new Error('x'));
    e.correlatorRequestIdAssignFailed('m', new Error('x'));
    e.correlatorMalformedRecordSkipped('m');
    e.rawstoreBlobGunzipFailed('a'.repeat(64));
    e.rawstoreBlobHashMismatch('b'.repeat(64));
    e.genaistoreUnserializableRecordSkipped('m');
    e.genaistoreMalformedRowSkipped(1);
    e.telemetrystoreUnserializableRecordSkipped('m');
    e.telemetrystoreMalformedRowSkipped(1);
    e.otlpLogsStoreFailed('m', 3);
    e.otlpGenaiIngestFailed('m', 3);
    e.otlpMetricsStoreFailed('m', 3);
    e.codexGenaiIngestEntryFailed('m');
    e.activityAppendFailed('m', 3);
    e.toolinvokeAuditAppendFailed('m');
    e.enrollmentSourceLabelTruncated('sourceUa', 40);

    const causes = (
      db.prepare('SELECT DISTINCT cause FROM diagnostic_event').all() as Array<{ cause: string }>
    ).map((r) => r.cause);
    expect(causes).toHaveLength(21);
    for (const c of causes) expect(DIAGNOSTIC_CAUSES).toContain(c);
  });
});
