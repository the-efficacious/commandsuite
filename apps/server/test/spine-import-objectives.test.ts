/**
 * THE GATE ON THE RIP-OUT. Nothing may be deleted until this is green,
 * because the legacy store is the only readable source for the import
 * and deleting first is unrecoverable.
 *
 * WHAT THIS SUITE IS SHAPED AGAINST. #155 names the migration as the
 * highest-risk step in the design and names the failure: backfilling a
 * TYPED field from an UNTYPED source. So most of these assertions are
 * NEGATIVE — no revision, no verdict, no watcher, no decomposed
 * criteria — and a suite of negatives passes happily against an
 * importer that imports NOTHING. Every negative here is therefore
 * paired with the positive it must still produce, and the two explicit
 * positive controls at the bottom prove the negative checks can fail:
 * the same query that reports "no imported event has a revision" is run
 * against an annex that does have one.
 *
 * The fixture is a REAL legacy database — the actual `objectives`,
 * `objective_events` and `events` DDL, not a mock — so the importer is
 * exercised through the same SQL it will meet in production.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpineContract, SpineEvent } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';
import type { AnnexWritePath } from '../src/spine/append.js';
import {
  formatImportSummary,
  IMPORT_NOTE,
  importObjectives,
  LEGACY_SUBJECT_ID,
  type ObjectivesImportSummary,
} from '../src/spine/import-objectives.js';
import { createAnnexWritePath } from '../src/spine/index.js';

const T0 = Date.UTC(2026, 0, 12, 9, 0, 0);
const SECOND = 1000;
const DAY = 24 * 60 * 60 * 1000;

const LEGACY_SCHEMA = `
  CREATE TABLE objectives (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','blocked','done','cancelled')),
    assignee TEXT NOT NULL,
    originator TEXT NOT NULL,
    watchers TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    result TEXT,
    block_reason TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    outcome_version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE objective_events (
    event_id TEXT,
    objective_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    to_name TEXT,
    from_name TEXT,
    title TEXT,
    body TEXT NOT NULL,
    level TEXT NOT NULL,
    data TEXT NOT NULL,
    attachments TEXT
  );
`;

let db: DatabaseSyncInstance;
let spine: AnnexWritePath;

function objective(row: {
  id: string;
  title: string;
  outcome: string;
  body?: string;
  status: string;
  assignee: string;
  originator: string;
  watchers?: string[];
  createdAt: number;
  result?: string;
  outcomeVersion?: number;
}): void {
  db.prepare(
    `INSERT INTO objectives
       (id, title, body, outcome, status, assignee, originator, watchers,
        created_at, updated_at, completed_at, result, block_reason, attachments, outcome_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, '[]', ?)`,
  ).run(
    row.id,
    row.title,
    row.body ?? '',
    row.outcome,
    row.status,
    row.assignee,
    row.originator,
    JSON.stringify(row.watchers ?? []),
    row.createdAt,
    row.createdAt,
    row.result ?? null,
    row.outcomeVersion ?? 1,
  );
}

function legacyEvent(
  eventId: string | null,
  objectiveId: string,
  ts: number,
  actor: string,
  kind: string,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    'INSERT INTO objective_events (event_id, objective_id, ts, actor, kind, payload) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(eventId, objectiveId, ts, actor, kind, JSON.stringify(payload));
}

function discussPost(
  id: string,
  objectiveId: string,
  ts: number,
  from: string | null,
  body: string,
): void {
  db.prepare(
    'INSERT INTO events (id, ts, to_name, from_name, title, body, level, data) VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)',
  ).run(
    id,
    ts,
    from,
    body,
    'info',
    JSON.stringify({
      kind: 'objective_discuss',
      objective_id: objectiveId,
      thread: `obj:${objectiveId}`,
    }),
  );
}

/** Every event in the annex, in stream order. */
function allEvents(): SpineEvent[] {
  return spine.store.events({ limit: 500 }).events;
}

function contractsByTitle(): Map<string, SpineContract> {
  return new Map(spine.store.contracts().map((c) => [c.title, c]));
}

function eventsOn(contract: string): SpineEvent[] {
  return spine.store.events({ contract, limit: 500 }).events;
}

const bodiesOn = (contract: string) =>
  eventsOn(contract)
    .filter((e) => e.kind === 'discussion')
    .map((e) => (e.body as { body: string }).body);

// ─────────────────────────────────────────────────────────────────────
// The fixture. Four objectives, each carrying one shape the import has
// to get right, plus the instance #155 names by hand.
// ─────────────────────────────────────────────────────────────────────

function seedLegacyRecord(): void {
  // 1 — A COMPLETED objective with a discussion thread.
  objective({
    id: 'obj-1',
    title: 'Ship the rate limiter',
    outcome: 'requests over 100/min get a 429 with a Retry-After header',
    body: 'the gateway is the only place this can live',
    status: 'done',
    assignee: 'rune',
    originator: 'lea',
    createdAt: T0,
    result: 'shipped in 0.4.2, behind the gateway flag',
  });
  legacyEvent('ev-1-a', 'obj-1', T0, 'lea', 'assigned', {
    title: 'Ship the rate limiter',
    outcome: 'requests over 100/min get a 429 with a Retry-After header',
    assignee: 'rune',
    contractVersion: 1,
  });
  discussPost(
    'msg-1-a',
    'obj-1',
    T0 + 2 * DAY,
    'rune',
    'the header name is Retry-After, not X-Retry',
  );
  discussPost('msg-1-b', 'obj-1', T0 + 3 * DAY, 'lea', 'agreed, use the standard one');
  legacyEvent('ev-1-b', 'obj-1', T0 + 4 * DAY, 'rune', 'completed', {
    result: 'shipped in 0.4.2, behind the gateway flag',
    contractVersion: 1,
  });

  // 2 — THE INSTANCE #155 NAMES. A verdict that found a real defect
  // class in three files, sitting inside a CANCELLED objective whose
  // cancellation reason says its author never started — because the
  // cancellation raced the verdict by seven seconds.
  objective({
    id: 'obj-race',
    title: 'Audit the session middleware',
    outcome: 'every session path is checked for the unvalidated-cookie defect',
    status: 'cancelled',
    assignee: 'cora',
    originator: 'turner',
    createdAt: T0 + DAY,
  });
  legacyEvent('ev-race-a', 'obj-race', T0 + DAY, 'turner', 'assigned', {
    title: 'Audit the session middleware',
    outcome: 'every session path is checked for the unvalidated-cookie defect',
    assignee: 'cora',
    contractVersion: 1,
  });
  discussPost(
    'msg-race',
    'obj-race',
    T0 + 5 * DAY,
    'cora',
    'done — and it is not a one-off. The same unvalidated cookie read is in ' +
      'session.ts, refresh.ts and impersonate.ts. Three files, one defect class.',
  );
  legacyEvent('ev-race-b', 'obj-race', T0 + 5 * DAY + 7 * SECOND, 'turner', 'cancelled', {
    reason: 'cora never started this one — closing it out in the sweep',
    contractVersion: 1,
  });

  // 3 — An AMENDED objective. Two amendments, one of which also moved
  // the body, and a correction stapled to a lifecycle event.
  objective({
    id: 'obj-amend',
    title: 'Document the webhook inbox',
    body: 'the third body',
    outcome: 'the reference page documents every field and the retry policy',
    status: 'done',
    assignee: 'seamus',
    originator: 'lea',
    createdAt: T0 + 2 * DAY,
    result: 'reference page published',
    outcomeVersion: 3,
  });
  legacyEvent('ev-am-a', 'obj-amend', T0 + 2 * DAY, 'lea', 'assigned', {
    title: 'Document the inbox',
    outcome: 'the docs say so',
    assignee: 'seamus',
    contractVersion: 1,
  });
  legacyEvent('ev-am-b', 'obj-amend', T0 + 3 * DAY, 'lea', 'amended', {
    target: 'contract',
    version: 2,
    ts: T0 + 3 * DAY,
    actor: 'lea',
    disposition: 'correction',
    reason: 'the original wording was ambiguous about which page',
    fields: ['outcome'],
    previous: { outcome: 'the docs say so' },
  });
  legacyEvent('ev-am-c', 'obj-amend', T0 + 4 * DAY, 'lea', 'amended', {
    target: 'contract',
    version: 3,
    ts: T0 + 4 * DAY,
    actor: 'lea',
    disposition: 'scope_change',
    reason: 'the retry policy has to be in scope, it is the part people get wrong',
    fields: ['title', 'outcome', 'body'],
    previous: {
      title: 'Document the inbox',
      outcome: 'the reference page documents every field',
      body: 'the second body',
    },
  });
  legacyEvent('ev-am-d', 'obj-amend', T0 + 6 * DAY, 'seamus', 'completed', {
    result: 'reference page published',
    contractVersion: 3,
  });
  legacyEvent('ev-am-e', 'obj-amend', T0 + 7 * DAY, 'lea', 'event_corrected', {
    target: 'event',
    ts: T0 + 7 * DAY,
    actor: 'lea',
    reason: 'the result named the wrong page',
    eventId: 'ev-am-d',
    eventKind: 'completed',
    eventTs: T0 + 6 * DAY,
    correction: 'it was published to /reference/webhooks, not /reference/inbox',
  });

  // 4 — An OPEN objective with WATCHERS, a block and an unblock, a
  // reassignment, and a legacy row predating the `event_id` column.
  objective({
    id: 'obj-open',
    title: 'Replace the polling loop',
    outcome: 'the poller is gone and the webhook is the only trigger',
    status: 'blocked',
    assignee: 'rune',
    originator: 'andrewjon',
    watchers: ['lea', 'cora'],
    createdAt: T0 + 3 * DAY,
  });
  legacyEvent('ev-open-a', 'obj-open', T0 + 3 * DAY, 'andrewjon', 'assigned', {
    title: 'Replace the polling loop',
    outcome: 'the poller is gone and the webhook is the only trigger',
    assignee: 'seamus',
    watchers: ['lea', 'cora'],
    contractVersion: 1,
  });
  legacyEvent('ev-open-b', 'obj-open', T0 + 3 * DAY, 'andrewjon', 'watcher_added', {
    name: 'lea',
    contractVersion: 1,
  });
  legacyEvent('ev-open-c', 'obj-open', T0 + 3 * DAY, 'andrewjon', 'watcher_added', {
    name: 'cora',
    contractVersion: 1,
  });
  legacyEvent('ev-open-d', 'obj-open', T0 + 4 * DAY, 'andrewjon', 'reassigned', {
    from: 'seamus',
    to: 'rune',
    note: 'seamus is on the docs sprint',
    contractVersion: 1,
  });
  // NO event_id: this row predates the column.
  legacyEvent(null, 'obj-open', T0 + 5 * DAY, 'rune', 'blocked', {
    reason: 'waiting on the platform team to enable the webhook scope',
    contractVersion: 1,
  });
}

async function runImport(): Promise<ObjectivesImportSummary> {
  return importObjectives({ db, spine, registeredBy: 'andrewjon', now: T0 });
}

const rawDirs: string[] = [];
afterEach(() => {
  for (const d of rawDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  db = openDatabase(':memory:');
  db.exec(LEGACY_SCHEMA);
  spine = createAnnexWritePath({
    db,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  seedLegacyRecord();
});

// ─────────────────────────────────────────────────────────────────────

describe('what the import carries, and what it refuses to invent', () => {
  it('registers ONE synthetic subject and binds every contract to it', async () => {
    await runImport();
    const subjects = spine.store.subjects();
    // Exactly one. Per-objective subjects would be guessed, and a
    // subject is registered rather than guessed.
    expect(subjects.map((s) => s.id)).toEqual([LEGACY_SUBJECT_ID]);
    expect(subjects[0]?.type).toBe('doc');
    const contracts = spine.store.contracts();
    expect(contracts).toHaveLength(4);
    expect(new Set(contracts.map((c) => c.subject))).toEqual(new Set([LEGACY_SUBJECT_ID]));
  });

  it('stamps EVERY imported event legacy_projection, without exception', async () => {
    await runImport();
    const events = allEvents();
    expect(events.length).toBeGreaterThan(15);
    // The whole set, not a sample: one native event in a legacy import
    // is a photograph nobody took wearing a caption that says they did.
    expect(events.filter((e) => e.provenance !== 'legacy_projection')).toEqual([]);
  });

  it('carries a completed objective whole, with no verdict and no revision', async () => {
    await runImport();
    const shipped = contractsByTitle().get('Ship the rate limiter') as SpineContract;
    expect(shipped.state).toBe('done');
    expect(shipped.assignee).toBe('rune');
    expect(shipped.result).toBe('shipped in 0.4.2, behind the gateway flag');
    // The outcome is ONE criterion carrying the outcome verbatim —
    // never parsed into several, which would be derivation.
    expect(shipped.criteria).toEqual([
      { id: 'outcome', text: 'requests over 100/min get a 429 with a Retry-After header' },
    ]);
    // NO verifier, because nobody was named one. This is also what
    // lets the completion land without a verdict: the store's coverage
    // gate asks nothing of a contract with no verifier.
    expect(shipped.verifier).toBeNull();
    expect(shipped.revision).toBeNull();
    // The thread came with it — both posts, in the order they were
    // written, as their authors wrote them.
    expect(bodiesOn(shipped.id)).toEqual([
      `${IMPORT_NOTE} the objective's body, as recorded:\n\nthe gateway is the only place this can live`,
      'the header name is Retry-After, not X-Retry',
      'agreed, use the standard one',
    ]);
  });

  it('replays an amendment chain onto the text the row actually holds', async () => {
    await runImport();
    const doc = contractsByTitle().get('Document the webhook inbox') as SpineContract;
    // THE PROJECTION LANDS ON THE ROW'S CURRENT TEXT — and this pair
    // alone does NOT constrain the unroll, which is worth saying
    // plainly because the comment here used to claim it did.
    //
    // The unroll walks backwards from the current row and the replay
    // walks forwards from the original; they are inverses, so an error
    // in one is cancelled by the same error in the other and the round
    // trip closes anyway. Measured: dropping `prev.title ??` from the
    // fold leaves these two assertions GREEN. What actually catches it
    // is the ORIGINAL-text check below — the only assertion here that
    // reads a point the fold had to reconstruct rather than a point
    // both directions pass through.
    expect(doc.title).toBe('Document the webhook inbox');
    expect(doc.criteria).toEqual([
      { id: 'outcome', text: 'the reference page documents every field and the retry policy' },
    ]);

    const events = eventsOn(doc.id);
    const spec = events.find((e) => e.kind === 'specification') as SpineEvent;
    expect((spec.body as { title: string }).title, 'the spec is the ORIGINAL text').toBe(
      'Document the inbox',
    );
    expect((spec.body as { criteria: { text: string }[] }).criteria[0]?.text).toBe(
      'the docs say so',
    );

    const amendments = events.filter((e) => e.kind === 'amendment');
    expect(amendments).toHaveLength(2);
    const first = amendments[0]?.body as {
      reason: string;
      disposition: string;
      disclosure: string;
    };
    expect(first.reason, 'the reason verbatim').toBe(
      'the original wording was ambiguous about which page',
    );
    expect(first.disposition, 'the disposition verbatim').toBe('correction');
    // THE PRIOR TEXT, PRESERVED AS RECORDED — §10: contamination is
    // disclosed, never erased.
    expect(first.disclosure).toContain('outcome: the docs say so');
    const second = amendments[1]?.body as { disposition: string; disclosure: string };
    expect(second.disposition).toBe('scope_change');
    expect(second.disclosure).toContain('title: Document the inbox');
    expect(second.disclosure).toContain('body: the second body');
  });

  it('staples a correction to the event it corrects, and keeps both', async () => {
    await runImport();
    const doc = contractsByTitle().get('Document the webhook inbox') as SpineContract;
    const events = eventsOn(doc.id);
    const done = events.find(
      (e) => e.kind === 'lifecycle' && (e.body as { state: string }).state === 'done',
    ) as SpineEvent;
    const correction = events.find((e) => e.kind === 'correction') as SpineEvent;
    expect(correction, 'the correction landed').toBeDefined();
    expect(correction.staplesTo, 'stapled to the completion it corrects').toBe(done.id);
    // NEVER REMOVE A PHOTO: the corrected result is still readable in
    // full, and the correction sits beside it rather than over it.
    expect((done.body as { result: string }).result).toBe('reference page published');
    expect((correction.body as { correction: string }).correction).toContain(
      'it was published to /reference/webhooks, not /reference/inbox',
    );
  });

  it('imports an open objective as active — never parked, never waiting_for', async () => {
    await runImport();
    const open = contractsByTitle().get('Replace the polling loop') as SpineContract;
    // `blocked` is an OPEN legacy state. `waiting_for` needs an event
    // and a check nobody authored; `parked` needs a preemption nobody
    // named; `waiting_on` needs the MEMBER being waited on, and the
    // legacy record names none — reading one out of the block reason
    // is the sentence-scrape the whole design exists to refuse.
    expect(open.state).toBe('active');
    expect(open.waitingOn).toBeNull();
    expect(open.waitingFor).toBeNull();
    expect(open.preemptedBy).toBeNull();
    // The reason is not lost. It is carried whole, as the prose it is.
    const bodies = bodiesOn(open.id);
    expect(
      bodies.some((b) => b.includes('waiting on the platform team to enable the webhook scope')),
    ).toBe(true);
  });

  it('carries a reassignment as recorded prose, and binds the live assignee', async () => {
    await runImport();
    const open = contractsByTitle().get('Replace the polling loop') as SpineContract;
    // The spine has no reassignment act, so the CURRENT binding goes on
    // the contract — it decides whose `orient` this lands in — and the
    // move itself is carried whole beside it. Both readings available,
    // neither invented.
    expect(open.assignee).toBe('rune');
    const bodies = bodiesOn(open.id);
    const move = bodies.find((b) => b.includes('reassignment'));
    expect(move).toBeDefined();
    expect(move).toContain('from seamus to rune');
    expect(move).toContain('seamus is on the docs sprint');
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('the instance #155 names, imported so a member can read it', () => {
  it('keeps the false cancellation reason AND the verdict it talked past', async () => {
    await runImport();
    const race = contractsByTitle().get('Audit the session middleware') as SpineContract;

    // THE STATE gives the wrong answer, and it is imported anyway,
    // exactly as recorded. A migration that "fixed" this would be
    // deciding which of two recorded facts is true.
    expect(race.state).toBe('cancelled');
    expect(race.reason).toBe('cora never started this one — closing it out in the sweep');

    // THE THREAD gives the right one, from an untyped source, whole.
    const finding = bodiesOn(race.id).find((b) => b.includes('Three files'));
    expect(finding, 'the finding survived the import').toBeDefined();
    expect(finding).toContain('session.ts, refresh.ts and impersonate.ts');

    // …AND NEITHER BECAME A FIELD. No verdict was synthesised out of
    // the post, and no revision was scraped out of it.
    const events = eventsOn(race.id);
    expect(events.filter((e) => e.kind === 'criterion_verdict')).toEqual([]);
    expect(events.filter((e) => e.revision !== null)).toEqual([]);
  });

  it('puts the post BEFORE the cancellation, because that is when it was written', async () => {
    await runImport();
    const race = contractsByTitle().get('Audit the session middleware') as SpineContract;
    const events = eventsOn(race.id);
    const post = events.find((e) => e.kind === 'discussion') as SpineEvent;
    const cancel = events.find((e) => e.kind === 'lifecycle') as SpineEvent;

    // The race is the fact. Legacy discussion lives in a DIFFERENT
    // TABLE from the lifecycle events, so an importer that walked the
    // typed rows and then the thread would give every post a higher
    // `seq` — and `seq` is the order a reader pages in. The record
    // would then read as though cora answered a decision already
    // taken, when she was seven seconds ahead of it.
    expect(post.seq, 'the post was written first, so it reads first').toBeLessThan(cancel.seq);
    expect(new Date(cancel.at).getTime() - new Date(post.at).getTime()).toBe(7 * SECOND);
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('the negatives, asserted explicitly', () => {
  it('imports no revision, anywhere, of any kind', async () => {
    await runImport();
    const withRevision = allEvents().filter((e) => e.revision !== null);
    expect(withRevision, 'the spine has no revision for legacy work').toEqual([]);
    expect(spine.store.contracts().filter((c) => c.revision !== null)).toEqual([]);
  });

  it('imports no criterion_verdict, and no contract carries a verdict', async () => {
    await runImport();
    expect(allEvents().filter((e) => e.kind === 'criterion_verdict')).toEqual([]);
    // The completed ones completed on their result alone, and say so.
    for (const contract of spine.store.contracts()) {
      expect(contract.verifier, `${contract.title} names no verifier`).toBeNull();
    }
  });

  it('imports no watcher, and says so rather than silently dropping them', async () => {
    const summary = await runImport();
    const watcherRows = summary.unimported.filter((r) => r.kind.startsWith('watcher_'));
    expect(watcherRows, 'both watcher rows are accounted for').toHaveLength(2);
    for (const row of watcherRows) {
      expect(row.reason).toContain('the spine has no watchers');
    }
    // …and nothing anywhere in the annex mentions them as a binding.
    const text = JSON.stringify(allEvents());
    expect(text).not.toContain('watcher_added');
    // The report a person reads names the omission too — an omission
    // recorded only in a field nobody prints has not been said.
    expect(formatImportSummary(summary)).toContain('the spine has no watchers');
  });

  it('never decomposes an outcome into more than one criterion', async () => {
    await runImport();
    for (const contract of spine.store.contracts()) {
      expect(contract.criteria, `${contract.title} has exactly one criterion`).toHaveLength(1);
      expect(contract.criteria[0]?.id).toBe('outcome');
    }
  });

  it('reports the rows whose op ids fall back to a rowid', async () => {
    const summary = await runImport();
    // One legacy row in the fixture predates the `event_id` column.
    // Idempotency for it rests on the rowid, which a VACUUM can move,
    // and a bound that is not stated is not a bound.
    expect(summary.rowidFallbacks).toBe(1);
    expect(formatImportSummary(summary)).toContain('no event_id');
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('adds nothing on a second run, and changes no contract', async () => {
    const first = await runImport();
    const eventsAfterFirst = allEvents();
    const contractsAfterFirst = spine.store.contracts();
    expect(first.objectivesImported).toBe(4);

    const second = await runImport();

    expect(second.objectivesImported, 'nothing was imported twice').toBe(0);
    expect(second.objectivesAlreadyImported).toBe(4);
    expect(second.appended, 'no event of any kind was appended').toEqual({});
    // The whole stream, not its length: a second run that replaced an
    // event with an identical-looking one would keep the count.
    expect(allEvents()).toEqual(eventsAfterFirst);
    expect(spine.store.contracts()).toEqual(contractsAfterFirst);
  });

  it('imports an objective added between runs, and only that one', async () => {
    await runImport();
    const before = allEvents().length;
    objective({
      id: 'obj-late',
      title: 'Retire the old queue',
      outcome: 'no code path reads the queue table',
      status: 'active',
      assignee: 'cora',
      originator: 'lea',
      createdAt: T0 + 30 * DAY,
    });

    const second = await runImport();

    // THE POSITIVE CONTROL ON IDEMPOTENCY. Every assertion above is
    // "nothing happened", which an importer that has quietly stopped
    // importing satisfies perfectly. This one proves the mechanism
    // still admits what it should.
    expect(second.objectivesImported).toBe(1);
    expect(second.objectivesAlreadyImported).toBe(4);
    expect(allEvents().length).toBe(before + 1);
    expect(contractsByTitle().get('Retire the old queue')?.state).toBe('active');
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('positive controls — the negative checks can fail', () => {
  it('the no-revision check sees a revision when one is there', async () => {
    await runImport();
    // The same query the negative test runs, against an annex that DOES
    // have a revision on it. Without this, "no imported event has a
    // revision" is equally satisfied by a reader that cannot see one.
    spine.store.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea', T0);
    await spine.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        revision: {
          subject: 'repo:acme',
          value: 'sha-planted',
          how: 'observed',
          source: 'integration:github',
        },
        body: { what: 'push webhook', output: 'main moved' },
      },
      { actor: 'integration:github', now: T0 + 40 * DAY },
    );
    const withRevision = allEvents().filter((e) => e.revision !== null);
    expect(withRevision, 'the check is not blind').toHaveLength(1);
    expect(withRevision[0]?.revision?.value).toBe('sha-planted');
  });

  it('the no-verdict check sees a verdict when one is there', async () => {
    await runImport();
    spine.store.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea', T0);
    const spec = await spine.append(
      {
        kind: 'specification',
        subject: 'repo:acme',
        opId: 'native-spec',
        body: {
          title: 'a native contract',
          criteria: [{ id: 'c1', text: 'the endpoint returns 200' }],
          assignee: 'rune',
          verifier: 'lea',
        },
      },
      { actor: 'lea', now: T0 + 41 * DAY },
    );
    await spine.append(
      {
        kind: 'criterion_verdict',
        opId: 'native-verdict',
        expectedStateRev: 1,
        revision: {
          subject: 'repo:acme',
          value: 'sha-a',
          how: 'observed',
          source: 'integration:github',
        },
        body: {
          contract: spec.event.id,
          criterion: 'c1',
          decision: 'met',
          evidence: 'ran the suite',
        },
      },
      { actor: 'lea', now: T0 + 41 * DAY },
    );
    expect(
      allEvents().filter((e) => e.kind === 'criterion_verdict'),
      'not blind',
    ).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('an import that cannot be made honest says so', () => {
  it('records the store refusal rather than dropping the row silently', async () => {
    // Legacy `amend` had NO terminal guard: an objective could be
    // amended after it was cancelled, and some were. The spine refuses
    // an authoritative write to a terminal contract, correctly. The
    // importer must not die on it and must not hide it.
    legacyEvent('ev-race-c', 'obj-race', T0 + 6 * DAY, 'turner', 'amended', {
      target: 'contract',
      version: 2,
      ts: T0 + 6 * DAY,
      actor: 'turner',
      disposition: 'scope_change',
      reason: 'narrowing it after the fact',
      fields: ['title'],
      previous: { title: 'Audit the session middleware' },
    });

    const summary = await runImport();

    const refused = summary.unimported.find((r) => r.id === 'ev-race-c');
    expect(refused, 'the refusal is reported, not swallowed').toBeDefined();
    // The SPECIFIC refusal, by identity — a bare "something failed"
    // would be satisfied by a typo or a missing subject just as
    // happily as by the rule under test.
    expect(refused?.reason).toContain('invalid_transition');
    expect(refused?.reason).toContain('terminal');
    // …and the rest of the import completed regardless.
    expect(summary.objectivesImported).toBe(4);
    expect(formatImportSummary(summary)).toContain('ev-race-c');
  });

  it('refuses to attribute an unauthored post to anybody', async () => {
    discussPost('msg-anon', 'obj-1', T0 + 2 * DAY, null, 'a post with no author on it');
    const summary = await runImport();
    const dropped = summary.unimported.find((r) => r.id === 'msg-anon');
    expect(dropped?.reason).toContain('records no author');
    expect(JSON.stringify(allEvents())).not.toContain('a post with no author on it');
  });

  it('marks the absence when a required prose field was never recorded', async () => {
    db.prepare('DELETE FROM objective_events WHERE event_id = ?').run('ev-race-b');
    legacyEvent('ev-race-b2', 'obj-race', T0 + 5 * DAY + 7 * SECOND, 'turner', 'cancelled', {
      contractVersion: 1,
    });

    await runImport();

    const race = contractsByTitle().get('Audit the session middleware') as SpineContract;
    // The spine requires a reason to cancel; the legacy record did not.
    // The sentinel is a statement about THE RECORD, marked as the
    // importer's own, and it is a different object from a manufactured
    // claim about the world. The alternative — dropping the event —
    // would render a cancelled objective as `active`, which is the
    // falsehood that costs a member their attention.
    expect(race.state).toBe('cancelled');
    expect(race.reason).toBe(`${IMPORT_NOTE} the cancellation recorded no reason`);
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('the annex is append-only, on every write route', () => {
  /**
   * §13 (a legacy projection never acquires native status) and §10 (a
   * photo is never removed and never rewritten), as constraints.
   *
   * THE SHAPE OF THIS SUITE WAS FOUND BY ENUMERATION. Three earlier
   * versions of the guard each looked complete and each left a route
   * open — and every one preserved the row's identity, so nothing
   * downstream could tell afterwards. What kept being missed was not
   * cleverness but ARITY: `spine_events` has THREE unique keys and
   * REPLACE resolves a conflict on any of them by deleting the row it
   * hit, and an `UPDATE OF provenance` trigger does not fire for an
   * update that simply omits provenance from its SET list.
   *
   * So these cases are organised by ROUTE rather than by the message
   * they expect, and each names the guard that should answer it. A
   * route answered by a different guard is a signal worth reading, not
   * noise to loosen the regex over.
   */
  const COLS =
    'seq,id,kind,class,subject_id,revision_id,actor,authored_by,at,provenance,op_id,cites,staples_to,body';
  const snapshot = () =>
    JSON.stringify(db.prepare(`SELECT ${COLS} FROM spine_events ORDER BY seq`).all());
  const bind = (o: Record<string, unknown>) => [
    o.seq as number,
    o.id as string,
    o.kind as string,
    o.class as string,
    o.subject_id as string | null,
    o.revision_id as string | null,
    o.actor as string,
    o.authored_by as string | null,
    o.at as string,
    o.provenance as string,
    o.op_id as string | null,
    o.cites as string,
    o.staples_to as string | null,
    o.body as string,
  ];

  it('refuses EVERY update, not only ones that name provenance', async () => {
    await runImport();
    const before = snapshot();

    // The route that got through three successive guards: `UPDATE OF
    // provenance` fires only when provenance is in the SET list. The
    // first two below forge the BODY — the photograph itself — and
    // leave id, seq and provenance untouched, so the caption still
    // reads `legacy_projection` while the content is somebody else's.
    // Not a provenance flip; a rewrite of a truth row, which §10
    // forbids at least as hard.
    for (const sql of [
      `UPDATE spine_events SET body = '{"body":"forged"}', actor = 'mallory' WHERE seq = 1`,
      `UPDATE spine_events SET body = '{"body":"forged"}' WHERE seq = 1`,
      `UPDATE spine_events SET actor = 'mallory'`,
      `UPDATE spine_events SET at = '1999-01-01T00:00:00.000Z' WHERE seq = 1`,
      `UPDATE spine_events SET kind = 'ruling' WHERE seq = 1`,
      `UPDATE spine_events SET cites = '["evt_x"]' WHERE seq = 1`,
      `UPDATE spine_events SET staples_to = 'evt_x' WHERE seq = 1`,
      `UPDATE spine_events SET provenance = 'native' WHERE seq = 1`,
      `UPDATE spine_events SET provenance = 'native'`,
    ]) {
      expect(() => db.prepare(sql).run(), sql).toThrow(/no column of a committed event/);
    }
    expect(snapshot(), 'the whole table, byte for byte').toBe(before);
  });

  it('refuses a REPLACE colliding on ANY of the three unique keys', async () => {
    await runImport();
    const before = snapshot();
    const row = db.prepare('SELECT * FROM spine_events WHERE seq = 1').get() as Record<
      string,
      unknown
    >;
    const withOp = db
      .prepare('SELECT * FROM spine_events WHERE op_id IS NOT NULL LIMIT 1')
      .get() as Record<string, unknown>;
    const ambient = db
      .prepare('SELECT * FROM spine_events WHERE op_id IS NULL LIMIT 1')
      .get() as Record<string, unknown>;
    const replace = (r: Record<string, unknown>, over: Record<string, unknown>) => () =>
      db
        .prepare(`INSERT OR REPLACE INTO spine_events (${COLS}) VALUES (${'?,'.repeat(13)}?)`)
        .run(...bind({ ...r, provenance: 'native', ...over }));

    // id — the key the first version of this guard covered.
    expect(replace(row, {}), 'collide on id').toThrow(/never reuses a key/);
    expect(replace(row, { seq: 9001 }), 'collide on id, new seq').toThrow(/never reuses a key/);
    // seq — the MORE CAPABLE route, and the one the suite could not
    // see: `op_id` is NULL on every ambient event, so an op_id
    // collision cannot reach a discussion post at all, while a seq
    // collision reaches every row and needs no knowledge of anything.
    expect(replace(row, { id: 'evt_forged_seq', op_id: null }), 'collide on seq').toThrow(
      /never reuses a key/,
    );
    expect(
      replace(ambient, { id: 'evt_forged_amb' }),
      'collide on seq, against an AMBIENT row',
    ).toThrow(/never reuses a key/);
    // op_id — previously guarded only by the delete trigger, and so
    // only on a connection that happened to have the pragma set.
    expect(replace(withOp, { id: 'evt_forged_op', seq: 9002 }), 'collide on op_id').toThrow(
      /never reuses a key/,
    );
    expect(replace(withOp, { id: 'evt_forged_both' }), 'collide on seq+op_id').toThrow(
      /never reuses a key/,
    );
    expect(snapshot()).toBe(before);
  });

  it('refuses a DELETE, and the conflict resolutions that hide one', async () => {
    await runImport();
    const before = snapshot();
    const row = db.prepare('SELECT * FROM spine_events WHERE seq = 1').get() as Record<
      string,
      unknown
    >;
    expect(() => db.prepare('DELETE FROM spine_events WHERE seq = 1').run()).toThrow(
      /the stream is gapless/,
    );
    expect(() => db.prepare('DELETE FROM spine_events').run()).toThrow(/the stream is gapless/);
    // An upsert reaches an UPDATE through an INSERT.
    expect(() =>
      db
        .prepare(
          `INSERT INTO spine_events (${COLS}) VALUES (${'?,'.repeat(13)}?)
             ON CONFLICT(id) DO UPDATE SET provenance = 'native'`,
        )
        .run(...bind({ ...row, seq: 9004, provenance: 'native' })),
    ).toThrow();
    expect(snapshot()).toBe(before);
  });

  it('holds on a RAW handle, where the pragma is off — the caller the rule names', async () => {
    // THE PROPERTY IS FILE-SCOPED; A PRAGMA IS CONNECTION-SCOPED.
    //
    // Every other case here runs through `openDatabase`, which sets
    // `recursive_triggers`. The caller this rule names is a migration
    // holding a raw handle, and a raw `new DatabaseSync(path)` has the
    // pragma at its default of 0. While the delete trigger was the only
    // thing standing behind REPLACE, that difference WAS the security
    // boundary; the key guard is an INSERT trigger and fires either
    // way, which is what moved the property into the file.
    const dir = mkdtempSync(join(tmpdir(), 'spine-raw-'));
    rawDirs.push(dir);
    const file = join(dir, 'csuite.db');
    const seeded = openDatabase(file);
    const seededSpine = createAnnexWritePath({
      db: seeded,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    seededSpine.store.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea', T0);
    const evt = await seededSpine.append(
      { kind: 'discussion', body: { body: 'a fact somebody would rather rewrite' } },
      { actor: 'lea', provenance: 'legacy_projection', now: T0 },
    );
    seeded.close();

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => DatabaseSyncInstance;
    };
    const raw = new DatabaseSync(file);
    const pragma = raw.prepare('PRAGMA recursive_triggers').get() as {
      recursive_triggers: number;
    };
    // Assert the HOSTILE CONDITION before reading any verdict — a raw
    // handle that happened to have the pragma on would pass this for
    // the wrong reason.
    expect(pragma.recursive_triggers, 'a raw handle must have the pragma OFF').toBe(0);

    const row = raw.prepare('SELECT * FROM spine_events WHERE id = ?').get(evt.event.id) as Record<
      string,
      unknown
    >;
    const replace = (over: Record<string, unknown>) => () =>
      raw
        .prepare(`INSERT OR REPLACE INTO spine_events (${COLS}) VALUES (${'?,'.repeat(13)}?)`)
        .run(...bind({ ...row, provenance: 'native', ...over }));

    expect(replace({}), 'collide on id, raw').toThrow(/never reuses a key/);
    // The seq route on the handle where it used to work — and this row
    // is AMBIENT (op_id NULL), exactly what an op_id guard can never
    // reach.
    expect(replace({ id: 'evt_forged_seq_raw' }), 'collide on seq, raw').toThrow(
      /never reuses a key/,
    );
    expect(
      () => raw.prepare(`UPDATE spine_events SET body = '{"body":"forged"}'`).run(),
      'body rewrite, raw',
    ).toThrow(/no column of a committed event/);
    expect(() => raw.prepare('DELETE FROM spine_events').run(), 'delete, raw').toThrow(
      /the stream is gapless/,
    );

    const after = raw
      .prepare('SELECT provenance, body FROM spine_events WHERE id = ?')
      .get(evt.event.id) as { provenance: string; body: string };
    expect(after.provenance, 'the row did not move').toBe('legacy_projection');
    expect(after.body).toContain('a fact somebody would rather rewrite');

    // THE POSITIVE CONTROL, on the same raw handle: a genuinely new
    // event still inserts. Guards that refused every write would
    // satisfy every refusal above and break the annex.
    const before = (raw.prepare('SELECT COUNT(*) n FROM spine_events').get() as { n: number }).n;
    raw
      .prepare(
        `INSERT INTO spine_events
           (id, kind, class, subject_id, revision_id, actor, authored_by, at,
            provenance, op_id, cites, staples_to, body)
         VALUES ('evt_genuinely_new', 'discussion', 'ambient', NULL, NULL, 'lea', NULL,
                 ?, 'native', NULL, '[]', NULL, '{"body":"new"}')`,
      )
      .run(row.at as string);
    expect((raw.prepare('SELECT COUNT(*) n FROM spine_events').get() as { n: number }).n).toBe(
      before + 1,
    );
    raw.close();
  });

  it('still admits an ordinary append — the positive control on all three guards', async () => {
    await runImport();
    const before = allEvents().length;
    // Every case above is a refusal, and a suite of refusals passes
    // happily against a table nothing can be written to at all.
    const added = await spine.append(
      { kind: 'discussion', body: { body: 'the annex still takes writes' } },
      { actor: 'lea', now: T0 + 70 * DAY },
    );
    expect(added.event.provenance).toBe('native');
    expect(allEvents().length).toBe(before + 1);
  });

  it('lets a NATIVE event cite and staple to a legacy one — the positive control', async () => {
    await runImport();
    const doc = contractsByTitle().get('Document the webhook inbox') as SpineContract;
    const legacyDone = eventsOn(doc.id).find(
      (e) => e.kind === 'lifecycle' && (e.body as { state: string }).state === 'done',
    ) as SpineEvent;

    // The rule forbids LAUNDERING, not fixing the record. Without this
    // every refusal above is equally satisfied by a store that has
    // stopped accepting corrections entirely.
    const correction = await spine.append(
      {
        kind: 'correction',
        opId: 'native-correction-of-legacy',
        staplesTo: legacyDone.id,
        expectedStateRev: doc.stateRev,
        cites: [legacyDone.id],
        body: { correction: 'this shipped to the reference page, not the guide' },
      },
      { actor: 'lea', now: T0 + 60 * DAY },
    );

    expect(correction.event.provenance).toBe('native');
    expect(correction.event.staplesTo).toBe(legacyDone.id);
    const stillThere = spine.store.event(legacyDone.id) as SpineEvent;
    expect(stillThere.provenance, 'the legacy event did not move').toBe('legacy_projection');
    expect((stillThere.body as { result: string }).result).toBe('reference page published');
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('a correction never loses the text it carries', () => {
  /**
   * THE ONE THING THE DESIGN SAYS MUST NEVER HAPPEN: member-authored
   * text disappearing.
   *
   * Legacy `correctEvent` explicitly permits correcting an `assigned`
   * event, and `assigned` is the one legacy kind that produces no event
   * of its own — its content IS the specification. Recording it only in
   * the ledger and not in the in-memory map made its correction resolve
   * to nothing, land in `unimported` under a reason that was FALSE
   * about it ("which was not imported" — it was, as the spec), and drop
   * the member's correction text out of the annex entirely.
   */
  it('staples a correction of `assigned` to the specification it became', async () => {
    legacyEvent('ev-1-fix', 'obj-1', T0 + 5 * DAY, 'lea', 'event_corrected', {
      target: 'event',
      ts: T0 + 5 * DAY,
      actor: 'lea',
      reason: 'the assignment named the wrong outcome',
      eventId: 'ev-1-a',
      eventKind: 'assigned',
      eventTs: T0,
      correction: 'the Retry-After header was always in scope, the original text omitted it',
    });

    const summary = await runImport();

    const shipped = contractsByTitle().get('Ship the rate limiter') as SpineContract;
    const correction = eventsOn(shipped.id).find((e) => e.kind === 'correction') as SpineEvent;
    expect(correction, 'the correction landed').toBeDefined();
    // Stapled to the SPECIFICATION, because that is where the corrected
    // event's content went.
    expect(correction.staplesTo).toBe(shipped.id);
    expect((correction.body as { correction: string }).correction).toContain(
      'the Retry-After header was always in scope',
    );
    // …and it is not reported as unimported under a false reason.
    expect(summary.unimported.map((r) => r.id)).not.toContain('ev-1-fix');
    // The member's words are IN THE ANNEX, which is the property.
    expect(JSON.stringify(allEvents())).toContain('the original text omitted it');
  });

  it('resolves a correction added AFTER the run that imported its target', async () => {
    // `produced` is per-run and is never populated for rows the ledger
    // already covers, so a correction arriving on a later run found an
    // empty map and reported its target unimported. The ledger is the
    // durable half of the same mapping; this is why it is consulted.
    await runImport();
    const shipped = contractsByTitle().get('Ship the rate limiter') as SpineContract;
    const doneBefore = eventsOn(shipped.id).find((e) => e.kind === 'lifecycle') as SpineEvent;

    legacyEvent('ev-1-late', 'obj-1', T0 + 9 * DAY, 'lea', 'event_corrected', {
      target: 'event',
      ts: T0 + 9 * DAY,
      actor: 'lea',
      reason: 'the result named the wrong release',
      eventId: 'ev-1-b',
      eventKind: 'completed',
      eventTs: T0 + 4 * DAY,
      correction: 'it shipped in 0.4.3, not 0.4.2',
    });

    const second = await runImport();

    const correction = eventsOn(shipped.id).find((e) => e.kind === 'correction');
    expect(correction, 'a correction on a later run still lands').toBeDefined();
    expect(correction?.staplesTo).toBe(doneBefore.id);
    expect(second.unimported.map((r) => r.id)).not.toContain('ev-1-late');
    expect(JSON.stringify(allEvents())).toContain('it shipped in 0.4.3, not 0.4.2');
  });

  it('still refuses a correction of something genuinely absent — the control', async () => {
    // The nearest INVALID thing: the two fixes above must not turn the
    // refusal into "staple it anywhere".
    legacyEvent('ev-1-ghost', 'obj-1', T0 + 5 * DAY, 'lea', 'event_corrected', {
      target: 'event',
      ts: T0 + 5 * DAY,
      actor: 'lea',
      reason: 'correcting a watcher row, which is never imported',
      eventId: 'ev-does-not-exist',
      eventKind: 'watcher_added',
      eventTs: T0,
      correction: 'this has nothing to staple to',
    });

    const summary = await runImport();

    const dropped = summary.unimported.find((r) => r.id === 'ev-1-ghost');
    expect(dropped?.reason).toContain('was not imported');
    expect(JSON.stringify(allEvents())).not.toContain('this has nothing to staple to');
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('an amendment is paired with its own record, not its neighbour', () => {
  it('does not shift later amendments when one payload is unreadable', async () => {
    // The list of amendments is built by FILTERING the event rows, and
    // a filter compacts. Indexed by an ordinal incremented per
    // `amended` row, one dropped payload pairs every later amendment
    // with the previous one's — producing an event dated and attributed
    // to one member carrying ANOTHER member's reason and another
    // member's recorded prior text. That is a claim nobody made wearing
    // a member's name, generated by the error handler.
    objective({
      id: 'obj-drift',
      title: 'C-title',
      outcome: 'C-outcome',
      status: 'active',
      assignee: 'rune',
      originator: 'lea',
      createdAt: T0 + 10 * DAY,
      outcomeVersion: 3,
    });
    // A: readable.
    legacyEvent('ev-A', 'obj-drift', T0 + 11 * DAY, 'lea', 'amended', {
      target: 'contract',
      version: 2,
      ts: T0 + 11 * DAY,
      actor: 'lea',
      disposition: 'correction',
      reason: "LEA's reason",
      fields: ['title'],
      previous: { title: 'A-title' },
    });
    // B: unreadable payload — the drop branch that makes the shift
    // reachable. It is a handled case, so it must not mis-handle.
    db.prepare(
      'INSERT INTO objective_events (event_id, objective_id, ts, actor, kind, payload) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('ev-B', 'obj-drift', T0 + 12 * DAY, 'cora', 'amended', '{ this is not json');
    // C: readable, and the one that used to inherit A's record.
    legacyEvent('ev-C', 'obj-drift', T0 + 13 * DAY, 'turner', 'amended', {
      target: 'contract',
      version: 3,
      ts: T0 + 13 * DAY,
      actor: 'turner',
      disposition: 'scope_change',
      reason: "TURNER's reason",
      fields: ['title'],
      previous: { title: 'B-title' },
    });

    const summary = await runImport();

    const drift = contractsByTitle().get('C-title') as SpineContract;
    const amendments = eventsOn(drift.id).filter((e) => e.kind === 'amendment');
    expect(amendments, 'A and C land; B is dropped').toHaveLength(2);

    const byActor = new Map(
      amendments.map((a) => [a.actor, a.body as unknown as Record<string, string>]),
    );
    // Each carries ITS OWN reason and ITS OWN recorded prior text.
    expect(byActor.get('lea')?.reason).toBe("LEA's reason");
    expect(byActor.get('lea')?.disclosure).toContain('A-title');
    expect(byActor.get('turner')?.reason).toBe("TURNER's reason");
    expect(byActor.get('turner')?.disclosure).toContain('B-title');
    // Nobody carries somebody else's.
    expect(byActor.get('turner')?.disclosure).not.toContain('A-title');
    expect(byActor.get('turner')?.reason).not.toBe("LEA's reason");

    // And the row reported unimported is the one that actually was.
    expect(summary.unimported.map((r) => r.id)).toContain('ev-B');
    expect(summary.unimported.map((r) => r.id)).not.toContain('ev-C');
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('the crash window between the annex write and the ledger write', () => {
  it('does not duplicate a thread post when the ledger row is missing', async () => {
    // The two writes are separate autocommit statements and cannot be
    // made one — the store opens its own transaction and SQLite refuses
    // a transaction inside a transaction. So a kill between them leaves
    // the event in the annex with no ledger row. Deleting the ledger
    // row IS that state, exactly.
    await runImport();
    const race = contractsByTitle().get('Audit the session middleware') as SpineContract;
    const before = bodiesOn(race.id).filter((b) => b.includes('Three files'));
    expect(before, 'the post is in once to begin with').toHaveLength(1);

    db.prepare('DELETE FROM spine_legacy_import WHERE legacy_kind = ? AND legacy_id = ?').run(
      'message',
      'msg-race',
    );

    await runImport();

    // Still once. Authoritative kinds are covered by op_id; ambient
    // ones carry none, which is why the annex itself is asked.
    expect(bodiesOn(race.id).filter((b) => b.includes('Three files'))).toHaveLength(1);
  });

  it('REPORTS two byte-identical posts collapsing into one, rather than swallowing them', async () => {
    // The pathological case the ambient dedupe cannot resolve: two
    // distinct legacy message ids, one author, one instant, one
    // contract, byte-identical text. Nothing distinguishes them from
    // one post written once — so the annex holds one, and the summary
    // has to SAY one was dropped rather than leaving a reader to
    // notice a missing line years later.
    discussPost('msg-dup-a', 'obj-1', T0 + 6 * DAY, 'rune', 'ship it');
    discussPost('msg-dup-b', 'obj-1', T0 + 6 * DAY, 'rune', 'ship it');

    const summary = await runImport();

    const shipped = contractsByTitle().get('Ship the rate limiter') as SpineContract;
    expect(bodiesOn(shipped.id).filter((b) => b === 'ship it')).toHaveLength(1);
    const collapsed = summary.collapsed.find((r) => r.id === 'msg-dup-b');
    expect(collapsed, 'the collapse is reported').toBeDefined();
    expect(collapsed?.reason).toContain('byte-identical');
    expect(collapsed?.reason).toContain('the annex holds one where the legacy record held two');
    // And a person reading the printed report is told — a field nobody
    // prints has not said anything.
    expect(formatImportSummary(summary)).toContain('collapsed into an existing annex event');
    expect(formatImportSummary(summary)).toContain('msg-dup-b');
  });

  it('does NOT report a collapse when it is just the crash window resuming', async () => {
    // The same code path fires for the resumed write, and that is not a
    // collapse — nothing was lost. Reporting it there would cry wolf on
    // every recovery and train an operator to skip the block.
    await runImport();
    db.prepare('DELETE FROM spine_legacy_import WHERE legacy_kind = ? AND legacy_id = ?').run(
      'message',
      'msg-race',
    );

    const second = await runImport();

    expect(second.collapsed, 'a resumed write is not a collapse').toEqual([]);
    expect(formatImportSummary(second)).not.toContain('collapsed into an existing annex event');
  });

  it('still imports a genuinely new post at the same instant — the control', async () => {
    // The nearest VALID thing the dedupe must not swallow: a different
    // post. Identity is contract + author + instant + text, all four,
    // so same author and same instant with different words is a
    // different post and must land.
    await runImport();
    const race = contractsByTitle().get('Audit the session middleware') as SpineContract;
    const before = bodiesOn(race.id).length;

    discussPost('msg-race-2', 'obj-race', T0 + 5 * DAY, 'cora', 'and one more file: admin.ts');
    await runImport();

    const after = bodiesOn(race.id);
    expect(after).toHaveLength(before + 1);
    expect(after.some((b) => b.includes('admin.ts'))).toBe(true);
  });
});
