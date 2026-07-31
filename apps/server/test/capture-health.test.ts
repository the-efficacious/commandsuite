/**
 * Capture-health detector.
 *
 * WHY EACH TEST IS HERE
 * ---------------------
 * The detector answers "is this member's verbatim capture arriving?"
 * and every wrong answer it could give is cheap and plausible:
 *
 *   - measure over gen_ai rows instead of markers, and the denominator
 *     structurally excludes the failure being detected (that mistake
 *     was made during design and caught by re-running over markers)
 *   - invert the adapter polarity, and it flags every healthy Claude
 *     member while clearing every real Codex gap
 *   - clear on ANY body in the session, and a mid-session outage is
 *     invisible forever after the first success
 *   - check one hash, and a missing response body passes
 *   - skip member/kind scoping, and another member's identical bytes
 *     satisfy the check
 *
 * Each of those has a test below, because each of them passes its own
 * naive test suite.
 *
 * The fixtures build rows directly rather than driving the ingest path:
 * the thing under test is a query over three tables, and constructing
 * the exact table states — including ones the writers would not
 * normally produce, like a purged blob — is the point.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createCaptureHealthStore } from '../src/capture-health.js';
import { openDatabase } from '../src/db.js';

const NOW = 1_800_000_000_000;
const AGED = NOW - 60_000; // comfortably past the 15s grace
const FRESH = NOW - 1_000; // inside it

function makeDb() {
  const db = openDatabase(':memory:');
  db.exec(`
    CREATE TABLE member_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, member_name TEXT NOT NULL,
      ts INTEGER NOT NULL, kind TEXT NOT NULL, event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE TABLE gen_ai_inference (
      id INTEGER PRIMARY KEY AUTOINCREMENT, member_name TEXT NOT NULL,
      response_id TEXT, request_sha256 TEXT, response_sha256 TEXT,
      received_at INTEGER NOT NULL);
    CREATE TABLE raw_exchange (
      id INTEGER PRIMARY KEY AUTOINCREMENT, member_name TEXT NOT NULL,
      kind TEXT NOT NULL, hash TEXT NOT NULL, received_at INTEGER NOT NULL);
    CREATE TABLE raw_blob (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
  `);
  return db;
}

const dbs: ReturnType<typeof makeDb>[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function fixture() {
  const db = makeDb();
  dbs.push(db);
  return {
    db,
    sessionStart(member: string, at = NOW - 3_600_000) {
      db.prepare(
        `INSERT INTO member_activity (member_name, ts, kind, event_json, created_at)
         VALUES (?, ?, 'session_start', '{}', ?)`,
      ).run(member, at, at);
    },
    /** A completed exchange marker. `responseId: null` is a Codex turn. */
    marker(member: string, responseId: string | null, createdAt = AGED) {
      const payload = JSON.stringify({ entry: { response: { responseId } } });
      db.prepare(
        `INSERT INTO member_activity (member_name, ts, kind, event_json, created_at)
         VALUES (?, ?, 'llm_exchange', ?, ?)`,
      ).run(member, createdAt, payload, createdAt);
    },
    /** The full healthy chain for one turn: gen_ai + both raws + both blobs. */
    captured(member: string, responseId: string, reqHash: string, resHash: string) {
      db.prepare(
        `INSERT INTO gen_ai_inference (member_name, response_id, request_sha256, response_sha256, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(member, responseId, reqHash, resHash, AGED);
      this.rawRow(member, 'request', reqHash);
      this.rawRow(member, 'response', resHash);
      this.blob(reqHash);
      this.blob(resHash);
    },
    rawRow(member: string, kind: 'request' | 'response', hash: string) {
      db.prepare(
        `INSERT INTO raw_exchange (member_name, kind, hash, received_at) VALUES (?, ?, ?, ?)`,
      ).run(member, kind, hash, AGED);
    },
    blob(hash: string) {
      db.prepare(`INSERT OR IGNORE INTO raw_blob (hash, bytes) VALUES (?, x'00')`).run(hash);
    },
    health(member: string) {
      return createCaptureHealthStore(db, { now: () => NOW }).forMember(member);
    },
  };
}

describe('capture-health detector', () => {
  it('fires when a member has aged markers and no bodies — the known positive', () => {
    // Turner's shape: markers flowing, zero capture. This is the case
    // that ran for a full day unnoticed.
    const f = fixture();
    f.sessionStart('turner');
    f.marker('turner', 'msg_a');
    f.marker('turner', 'msg_b');

    const h = f.health('turner');
    expect(h.state).toBe('gap');
    expect(h.state === 'gap' && h.unmatchedMarkers).toBe(2);
  });

  it('stays ok when every marker has its full chain', () => {
    const f = fixture();
    f.sessionStart('cora');
    f.marker('cora', 'msg_a');
    f.captured('cora', 'msg_a', 'req_a', 'res_a');

    expect(f.health('cora').state).toBe('ok');
  });

  it('makes NO gap claim for a healthy Codex member', () => {
    // Codex markers carry responseId: null BY DESIGN — a codex
    // exchange aggregates a whole turn across several API calls, so
    // there is no single id to carry. Inverted polarity here would
    // report a permanently-gapped member whose capture is perfect.
    const f = fixture();
    f.sessionStart('seamus');
    f.marker('seamus', null);
    f.marker('seamus', null);
    // Capture IS working — gen_ai rows exist, they just don't join by id.
    f.captured('seamus', 'resp_x', 'req_x', 'res_x');

    expect(f.health('seamus').state).not.toBe('gap');
  });

  it('reports a Codex member UNEVALUATED, not ok — it was never assessed', () => {
    // The containment join is not built, so nothing above examined this
    // member at all. `ok` would be the detector asserting a property it
    // never evaluated — the same conflation it exists to remove, one
    // layer up. This must stay distinct from a healthy Claude member
    // AND from an absent field (a broker with no opinion).
    const f = fixture();
    f.sessionStart('seamus');
    f.marker('seamus', null);
    f.captured('seamus', 'resp_x', 'req_x', 'res_x');

    const h = f.health('seamus');
    expect(h.state).toBe('unevaluated');
    expect(h.state === 'unevaluated' && h.reason).toBe('no-exact-match-adapter');
  });

  it('a Codex member with NO capture at all is also unevaluated, not gap', () => {
    // The honest answer for a genuinely-broken Codex member is still
    // "not assessed" until containment lands — claiming `gap` here
    // would be right by accident, from a predicate that cannot tell
    // this case from the healthy one above.
    const f = fixture();
    f.sessionStart('seamus');
    f.marker('seamus', null);

    expect(f.health('seamus').state).toBe('unevaluated');
  });

  it('a member with BOTH eligible and ineligible markers is still evaluated', () => {
    // Only a member with zero eligible markers is unassessable. One
    // eligible marker means the exact join has something to say, and a
    // gap in it must not be downgraded to `unevaluated`.
    const f = fixture();
    f.sessionStart('mixed');
    f.marker('mixed', null);
    f.marker('mixed', 'msg_broken');

    expect(f.health('mixed').state).toBe('gap');
  });

  it('does not surface a claim for a marker still inside the grace window', () => {
    // Healthy correlation lag is ~4s at p50, so every normal turn is
    // briefly unmatched. A user-visible warning here would flicker
    // continuously on healthy traffic.
    const f = fixture();
    f.sessionStart('cora');
    f.marker('cora', 'msg_fresh', FRESH);

    expect(f.health('cora').state).toBe('pending');
  });

  it('a fully matched fresh marker clears pending immediately', () => {
    const f = fixture();
    f.sessionStart('cora');
    f.marker('cora', 'msg_fresh', FRESH);
    f.captured('cora', 'msg_fresh', 'req_fresh', 'res_fresh');

    expect(f.health('cora').state).toBe('ok');
  });

  it('a fresh marker before the latest session boundary cannot make the new session pending', () => {
    const f = fixture();
    f.sessionStart('cora', NOW - 10_000);
    f.marker('cora', 'msg_old_fresh', NOW - 9_000);
    f.sessionStart('cora', NOW - 5_000);

    expect(f.health('cora').state).toBe('ok');
  });

  it('a healthy body earlier in the session does NOT clear a later unmatched marker', () => {
    // The latch. A session that captures once and then breaks must not
    // read as healthy for the rest of its life — Turner's ran 18 hours.
    const f = fixture();
    f.sessionStart('cora');
    f.marker('cora', 'msg_ok');
    f.captured('cora', 'msg_ok', 'req_ok', 'res_ok');
    f.marker('cora', 'msg_broken'); // later turn, nothing captured

    const h = f.health('cora');
    expect(h.state).toBe('gap');
    expect(h.state === 'gap' && h.unmatchedMarkers).toBe(1);
  });

  it('fires when the REQUEST raw row is missing but the response is present', () => {
    // Checking one hash would pass this.
    const f = fixture();
    f.sessionStart('cora');
    f.marker('cora', 'msg_a');
    f.db
      .prepare(
        `INSERT INTO gen_ai_inference (member_name, response_id, request_sha256, response_sha256, received_at)
         VALUES ('cora','msg_a','req_a','res_a',?)`,
      )
      .run(AGED);
    f.rawRow('cora', 'response', 'res_a');
    f.blob('req_a');
    f.blob('res_a');

    expect(f.health('cora').state).toBe('gap');
  });

  it('fires when the RESPONSE raw row is missing but the request is present', () => {
    const f = fixture();
    f.sessionStart('cora');
    f.marker('cora', 'msg_a');
    f.db
      .prepare(
        `INSERT INTO gen_ai_inference (member_name, response_id, request_sha256, response_sha256, received_at)
         VALUES ('cora','msg_a','req_a','res_a',?)`,
      )
      .run(AGED);
    f.rawRow('cora', 'request', 'req_a');
    f.blob('req_a');
    f.blob('res_a');

    expect(f.health('cora').state).toBe('gap');
  });

  it('fires when the exchange rows exist but the blob was purged', () => {
    // An exchange row can outlive its bytes under refcount deletion.
    // Without the blob check the detector would claim capture that
    // cannot be read back.
    const f = fixture();
    f.sessionStart('cora');
    f.marker('cora', 'msg_a');
    f.db
      .prepare(
        `INSERT INTO gen_ai_inference (member_name, response_id, request_sha256, response_sha256, received_at)
         VALUES ('cora','msg_a','req_a','res_a',?)`,
      )
      .run(AGED);
    f.rawRow('cora', 'request', 'req_a');
    f.rawRow('cora', 'response', 'res_a');
    f.blob('req_a'); // res_a blob deliberately absent

    expect(f.health('cora').state).toBe('gap');
  });

  it("another member's identical bytes do not clear the gap", () => {
    // Content addressing is many-to-one. Without member scoping, a
    // different member's identical body satisfies the EXISTS.
    const f = fixture();
    f.sessionStart('cora');
    f.marker('cora', 'msg_a');
    f.db
      .prepare(
        `INSERT INTO gen_ai_inference (member_name, response_id, request_sha256, response_sha256, received_at)
         VALUES ('cora','msg_a','shared_req','shared_res',?)`,
      )
      .run(AGED);
    // The rows exist — but they belong to someone else.
    f.rawRow('lea', 'request', 'shared_req');
    f.rawRow('lea', 'response', 'shared_res');
    f.blob('shared_req');
    f.blob('shared_res');

    expect(f.health('cora').state).toBe('gap');
  });

  it('a request-kind row carrying the response hash does not clear the gap', () => {
    // Without kind scoping, one row could satisfy both EXISTS clauses.
    const f = fixture();
    f.sessionStart('cora');
    f.marker('cora', 'msg_a');
    f.db
      .prepare(
        `INSERT INTO gen_ai_inference (member_name, response_id, request_sha256, response_sha256, received_at)
         VALUES ('cora','msg_a','req_a','res_a',?)`,
      )
      .run(AGED);
    f.rawRow('cora', 'request', 'req_a');
    f.rawRow('cora', 'request', 'res_a'); // wrong kind
    f.blob('req_a');
    f.blob('res_a');

    expect(f.health('cora').state).toBe('gap');
  });

  it('is scoped to the current session — an OLD outage does not mark a healthy new one', () => {
    // The discriminating fixture is old-BROKEN + new-HEALTHY. The
    // reverse (old-healthy, new-broken) passes whether or not the
    // boundary is applied, because the old marker is matched either
    // way — an earlier version of this test did exactly that and
    // survived a mutation removing the session boundary entirely.
    const f = fixture();
    f.sessionStart('cora', NOW - 7_200_000);
    f.marker('cora', 'msg_old_broken', NOW - 7_000_000); // never captured
    // A NEW session, fully healthy.
    f.sessionStart('cora', NOW - 600_000);
    f.marker('cora', 'msg_new', NOW - 300_000);
    f.captured('cora', 'msg_new', 'req_new', 'res_new');

    // Session-scoped: the old failure is history, this session is fine.
    expect(f.health('cora').state).toBe('ok');
  });

  it('a fresh outage is not masked by an earlier healthy session', () => {
    // The other direction, kept because it is the operationally
    // likely one even though it does not discriminate the boundary.
    const f = fixture();
    f.sessionStart('cora', NOW - 7_200_000);
    f.marker('cora', 'msg_old', NOW - 7_000_000);
    f.captured('cora', 'msg_old', 'req_old', 'res_old');
    f.sessionStart('cora', NOW - 600_000);
    f.marker('cora', 'msg_new', NOW - 300_000);

    const h = f.health('cora');
    expect(h.state).toBe('gap');
    expect(h.state === 'gap' && h.unmatchedMarkers).toBe(1);
  });

  it('makes no claim for a member with no session on record', () => {
    const f = fixture();
    expect(f.health('nobody').state).toBe('ok');
  });

  it('a session with no exchanges at all is ok, NOT unevaluated', () => {
    // Zero eligible markers is only "unassessable" when there were
    // markers to assess. A member who has produced no exchanges has
    // nothing that failed to be captured — markers failing to ARRIVE is
    // the activity path, a different detector.
    //
    // Without the total > 0 guard this returns `unevaluated`, and every
    // freshly-started member on the roster would carry a caveat that
    // says nothing. That mutation survived until this test existed.
    const f = fixture();
    f.sessionStart('quiet');

    expect(f.health('quiet').state).toBe('ok');
  });
});
