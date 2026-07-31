/**
 * The broker half of the trace-join conformance corpus.
 *
 * `fixtures/trace-join-conformance.json` is shared with
 * `packages/web-ui/test/trace-join-conformance.test.ts`. Both run the
 * same cases; this file asserts what the capture-health predicate does
 * with them.
 *
 * WHY THIS EXISTS RATHER THAN ONE SHARED JOIN
 * -------------------------------------------
 * The original contract said reuse `trace-join.ts` instead of writing a
 * second join that can drift. Raised rather than diverged from: the two
 * run in different execution contexts — TypeScript over fetched arrays
 * in a browser, SQL over three tables in the broker — and "load the rows
 * into memory and call the UI's function" trades a drift risk for a
 * package-boundary problem and a cost profile nobody measured.
 *
 * The criterion was narrowed to the property behind it: the health check
 * and the UI must never disagree about what counts as matched. This
 * corpus enforces that. Two joins with a shared conformance suite is a
 * stronger guarantee than one join two callers reach awkwardly, because
 * the fixture is executable and the coupling isn't.
 *
 * Every call in the corpus gets a complete stored body chain here. Body
 * presence is tested exhaustively in capture-health.test.ts; isolating
 * it keeps a failure in this file pointing at the JOIN.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCaptureHealthStore } from '../src/capture-health.js';
import { openDatabase } from '../src/db.js';

const CORPUS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/trace-join-conformance.json',
);

interface Case {
  name: string;
  why: string;
  markers: Array<{
    responseId: string | null;
    startedAt: number;
    endedAt: number;
    model: string | null;
    querySource: string | null;
  }>;
  calls: Array<{
    id: number;
    ts: number;
    model: string | null;
    responseId: string | null;
    querySource: string | null;
  }>;
  expect: {
    ui: { matched: number[] };
    broker: { matched: number[]; evaluated: boolean };
  };
  divergence?: string;
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { cases: Case[] };

const NOW = 1_800_000_000_000;
const SESSION_AT = NOW - 3_600_000;
/** Comfortably past the 15s grace, so no marker is merely `pending`. */
const AGED = NOW - 600_000;

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function buildDb(c: Case) {
  const db = openDatabase(':memory:');
  dbs.push(db);
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
  db.prepare(
    `INSERT INTO member_activity (member_name, ts, kind, event_json, created_at)
     VALUES ('m', ?, 'session_start', '{}', ?)`,
  ).run(SESSION_AT, SESSION_AT);

  // Markers keep their corpus order; created_at is broker-receipt, which
  // is the clock the predicate uses. The corpus's startedAt/endedAt are
  // agent-side and drive the UI's containment pass, not this one.
  c.markers.forEach((m, i) => {
    const payload = JSON.stringify({
      entry: {
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        request: { model: m.model },
        response: { responseId: m.responseId },
      },
    });
    db.prepare(
      `INSERT INTO member_activity (member_name, ts, kind, event_json, created_at)
       VALUES ('m', ?, 'llm_exchange', ?, ?)`,
    ).run(m.startedAt, payload, AGED + i);
  });

  // Each call gets a full healthy chain, so only the JOIN can fail.
  for (const call of c.calls) {
    const req = `req_${call.id}`;
    const res = `res_${call.id}`;
    db.prepare(
      `INSERT INTO gen_ai_inference (member_name, response_id, request_sha256, response_sha256, received_at)
       VALUES ('m', ?, ?, ?, ?)`,
    ).run(call.responseId, req, res, AGED);
    for (const [kind, hash] of [
      ['request', req],
      ['response', res],
    ] as const) {
      db.prepare(
        `INSERT INTO raw_exchange (member_name, kind, hash, received_at) VALUES ('m', ?, ?, ?)`,
      ).run(kind, hash, AGED);
      db.prepare(`INSERT OR IGNORE INTO raw_blob (hash, bytes) VALUES (?, x'00')`).run(hash);
    }
  }
  return db;
}

describe('trace-join conformance corpus (broker side)', () => {
  it('the corpus is non-empty and every case declares both expectations', () => {
    // Guard against a corpus that silently emptied — every per-case test
    // below would vacuously pass and the suite would still be green.
    expect(corpus.cases.length).toBeGreaterThan(0);
    for (const c of corpus.cases) {
      expect(c.expect.ui, c.name).toBeDefined();
      expect(c.expect.broker, c.name).toBeDefined();
    }
  });

  for (const c of corpus.cases) {
    it(`${c.name}: ${c.why}`, () => {
      const db = buildDb(c);
      const health = createCaptureHealthStore(db, { now: () => NOW }).forMember('m');

      if (!c.expect.broker.evaluated) {
        // The broker declines rather than claiming health it never
        // measured. `ok` here would be the defect this surface exists
        // to remove, one layer up.
        expect(health.state, c.name).toBe('unevaluated');
        return;
      }

      // Eligible markers are the exact-match domain; the corpus records
      // which of them the broker considers matched.
      const eligible = c.markers
        .map((m, i) => (m.responseId !== null ? i : -1))
        .filter((i) => i >= 0);
      const expectedUnmatched = eligible.filter((i) => !c.expect.broker.matched.includes(i)).length;

      if (expectedUnmatched === 0) {
        expect(health.state, c.name).toBe('ok');
      } else {
        expect(health.state, c.name).toBe('gap');
        expect(health.state === 'gap' && health.unmatchedMarkers, c.name).toBe(expectedUnmatched);
      }
    });
  }

  it('every divergence between the two joins is declared with a reason', () => {
    // An UNdeclared divergence is the drift this corpus exists to catch.
    // A declared one is a decision — or, in one case, a defect someone
    // wrote down rather than accommodated silently.
    for (const c of corpus.cases) {
      const agrees =
        c.expect.broker.evaluated &&
        JSON.stringify(c.expect.ui.matched) === JSON.stringify(c.expect.broker.matched);
      if (!agrees) {
        expect(c.divergence, `${c.name} diverges but declares no reason`).toBeTruthy();
      }
    }
  });
});
