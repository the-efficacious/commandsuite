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

import type { SpineContract, SpineEvent } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
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

describe('provenance is permanent', () => {
  /**
   * §13: legacy projections NEVER acquire native status. Nobody ever
   * took that photograph, and no amount of later work makes it so.
   *
   * The compile-time half of this rule is in `spine-boundary.test-d.ts`
   * — there is no `promoteToNative`, no update taking a `provenance`,
   * no "finish the migration" sweep on the surface at all. That covers
   * every caller the compiler sees. It does NOT cover the caller this
   * rule actually has to survive: a migration holding a raw database
   * handle, written by someone who has read neither §13 nor the comment
   * on the events table. So the runtime half is a SQLite trigger, and
   * these tests drive it the way that caller would — by raw SQL.
   */
  it('refuses to flip an imported event to native, by any SQL that tries', async () => {
    await runImport();
    const before = allEvents();
    const legacy = before[0] as SpineEvent;
    expect(legacy.provenance).toBe('legacy_projection');

    // Exactly what a migration would write. The SPECIFIC refusal, by
    // its own message — a bare `toThrow()` is satisfied by a typo in
    // the table name just as happily as by the rule under test.
    expect(() =>
      db.prepare('UPDATE spine_events SET provenance = ? WHERE id = ?').run('native', legacy.id),
    ).toThrow(/provenance is permanent/);

    // …and the bulk form, which is how it would really be written.
    expect(() => db.prepare("UPDATE spine_events SET provenance = 'native'").run()).toThrow(
      /provenance is permanent/,
    );

    // Nothing moved. A trigger that aborts after the write would leave
    // the row changed and the caller merely informed.
    expect(allEvents()).toEqual(before);
  });

  it('refuses INSERT OR REPLACE, which is a delete-and-reinsert underneath', async () => {
    await runImport();
    const before = allEvents();
    const legacy = before[0] as SpineEvent;
    const row = db.prepare('SELECT * FROM spine_events WHERE id = ?').get(legacy.id) as Record<
      string,
      unknown
    >;

    // THE CALLER THE RULE EXISTS FOR, spelled the way they would spell
    // it. This is not an exotic attack — it is how somebody changes a
    // column they cannot ALTER — and it preserves the row's id AND its
    // seq, so nothing downstream can tell afterwards. An `UPDATE OF
    // provenance` trigger alone did not see it, because it is not an
    // UPDATE.
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO spine_events
             (seq, id, kind, class, subject_id, revision_id, actor, authored_by, at,
              provenance, op_id, cites, staples_to, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'native', ?, ?, ?, ?)`,
        )
        .run(
          row.seq as number,
          row.id as string,
          row.kind as string,
          row.class as string,
          row.subject_id as string | null,
          row.revision_id as string | null,
          row.actor as string,
          row.authored_by as string | null,
          row.at as string,
          row.op_id as string | null,
          row.cites as string,
          row.staples_to as string | null,
          row.body as string,
        ),
    ).toThrow(/append-only/);

    // The whole stream, not a spot check: a REPLACE that got halfway
    // would leave the row changed and the caller merely informed.
    expect(allEvents()).toEqual(before);
    expect(spine.store.event(legacy.id)?.provenance).toBe('legacy_projection');
  });

  it('refuses a bare DELETE — the other half of the same rewrite', async () => {
    await runImport();
    const before = allEvents();
    const legacy = before[0] as SpineEvent;

    // Delete-then-insert reaches the same place as REPLACE by two
    // statements instead of one. Both have to be closed or neither is.
    expect(() => db.prepare('DELETE FROM spine_events WHERE id = ?').run(legacy.id)).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM spine_events').run()).toThrow(/append-only/);
    expect(allEvents()).toEqual(before);
  });

  it('still admits an ordinary append — the positive control on both triggers', async () => {
    await runImport();
    const before = allEvents().length;
    // Four refusals above are equally satisfied by a table nothing can
    // be written to at all.
    const added = await spine.append(
      { kind: 'discussion', body: { body: 'the annex still takes writes' } },
      { actor: 'lea', now: T0 + 70 * DAY },
    );
    expect(added.event.provenance).toBe('native');
    expect(allEvents().length).toBe(before + 1);
  });

  it('refuses to rewrite a native event as legacy, the other direction', async () => {
    await runImport();
    spine.store.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea', T0);
    const native = await spine.append(
      { kind: 'discussion', body: { body: 'a native remark' } },
      { actor: 'lea', now: T0 + 50 * DAY },
    );
    expect(native.event.provenance).toBe('native');

    // The rule is symmetric: the caption says how the record was
    // obtained, and a native event relabelled as an import is the same
    // lie pointing the other way — it launders a live claim into
    // something a reader will discount as history.
    expect(() =>
      db
        .prepare('UPDATE spine_events SET provenance = ? WHERE id = ?')
        .run('legacy_projection', native.event.id),
    ).toThrow(/provenance is permanent/);
    expect(spine.store.event(native.event.id)?.provenance).toBe('native');
  });

  it('lets a NATIVE event cite and staple to a legacy one — the positive control', async () => {
    await runImport();
    const doc = contractsByTitle().get('Document the webhook inbox') as SpineContract;
    const legacyDone = eventsOn(doc.id).find(
      (e) => e.kind === 'lifecycle' && (e.body as { state: string }).state === 'done',
    ) as SpineEvent;

    // The rule forbids LAUNDERING, not fixing the record. Without this
    // the three refusals above are equally satisfied by a store that
    // has stopped accepting corrections entirely.
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

    // The correction is NATIVE — it is a fresh claim by a live member,
    // not part of the import — and it stands beside the legacy event
    // rather than over it. Both provenances, both readable.
    expect(correction.event.provenance).toBe('native');
    expect(correction.event.staplesTo).toBe(legacyDone.id);
    expect(correction.event.cites).toEqual([legacyDone.id]);
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
