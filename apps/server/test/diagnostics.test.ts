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
  classifyError,
  createDiagnosticStore,
  DIAGNOSTIC_CAUSES,
  digestPath,
} from '../src/diagnostics.js';

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

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

  it('drops unknown fields rather than storing them', () => {
    const { s, db } = store();
    s.record({
      cause: 'correlator.body_ref_unreadable',
      members: ['turner'],
      attribution: 'producer',
      // biome-ignore lint/suspicious/noExplicitAny: deliberately hostile input
      fields: { hash: 'abc', secret: '/etc/shadow' } as any,
    });
    const row = db.prepare('SELECT fields FROM diagnostic_event').get() as { fields: string };
    expect(row.fields).toContain('abc');
    expect(row.fields).not.toContain('shadow');
  });
});

describe('attribution', () => {
  it('records unattributed explicitly rather than omitting the row', () => {
    // `getBlob(hash)` has no member. Dropping the event would make the
    // store silent about exactly the corruption it exists to surface.
    const { s } = store();
    s.record({ cause: 'rawstore.blob_gunzip_failed', attribution: 'unattributed' });

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
      attribution: 'affected',
      fields: { hash: 'deadbeef' },
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
      attribution: 'producer',
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
      attribution: 'producer',
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
      h.s.record({ cause: 'otlp.genai_ingest_failed', members: ['lea'], attribution: 'producer' });
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
    h.s.record({ cause: 'otlp.logs_store_failed', members: ['lea'], attribution: 'producer' });
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
      attribution: 'producer',
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
    h.s.record({ cause: 'rawstore.blob_gunzip_failed', attribution: 'unattributed' });

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
      h.s.record({ cause: 'activity.append_failed', members: ['m'], attribution: 'producer' });
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
      h.s.record({ cause: 'activity.append_failed', members: ['m'], attribution: 'producer' });
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
    expect(DIAGNOSTIC_CAUSES.length).toBe(22); // 21 sites + retention.overflow
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
    h.s.record({ cause: 'rawstore.blob_gunzip_failed', attribution: 'unattributed' });
    h.s.record({ cause: 'rawstore.blob_gunzip_failed', attribution: 'unattributed' });
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
    h.s.record({ cause: 'otlp.logs_store_failed', attribution: 'unattributed' });
    h.s.record({ cause: 'otlp.logs_store_failed', attribution: 'unattributed' });
    expect(h.s.unresolved(null)).toHaveLength(1);
  });

  it('a narrow window does not count evidence from a neighbouring bucket', () => {
    // The overlap predicate was `bucket_start >= from - DAY`, which
    // admitted every bucket in the preceding 24h. A Wednesday query
    // could count Tuesday.
    const h = store({ detailMs: HOUR });
    h.at(T0);
    h.s.record({ cause: 'otlp.logs_store_failed', members: ['lea'], attribution: 'producer' });
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
      h.s.record({ cause: 'activity.append_failed', members: ['m'], attribution: 'producer' });
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
      h.s.record({ cause: 'activity.append_failed', members: ['m'], attribution: 'producer' });
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
      h.s.record({ cause: 'activity.append_failed', members: ['m'], attribution: 'producer' });
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
      h.s.record({ cause: 'activity.append_failed', members: [`m${i}`], attribution: 'producer' });
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
      attribution: 'affected',
    });
    expect(h.s.unresolved('lea')).toHaveLength(0);
    // …but it is still history.
    expect(h.s.query({ member: 'lea', from: T0 - HOUR, to: T0 + HOUR }).count).toBe(1);
  });

  it('an INCIDENT cause does create unresolved state', () => {
    const h = store();
    h.s.record({ cause: 'activity.append_failed', members: ['lea'], attribution: 'producer' });
    expect(h.s.unresolved('lea')).toHaveLength(1);
  });

  it('the affected-member fanout is bounded', () => {
    const h = store();
    h.s.record({
      cause: 'rawstore.blob_hash_mismatch',
      members: Array.from({ length: 5000 }, (_, i) => `m${i}`),
      attribution: 'affected',
    });
    const n = h.db.prepare(`SELECT COUNT(*) AS n FROM diagnostic_event`).get() as { n: number };
    expect(Number(n.n)).toBeLessThanOrEqual(256);
  });
});
