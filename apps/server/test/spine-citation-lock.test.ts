/**
 * The citation lock — the one hard gate in a warn-never-lock design.
 *
 * WHAT MAKES THIS SUITE DIFFERENT FROM THE REST OF THE ANNEX'S. Every
 * other refusal in the store is about the event: a verdict from the
 * traveller, a completion outrunning its evidence, a precondition that
 * has moved. This one is about the ACTOR'S OWN MEMORY — it fires on an
 * event that is perfectly well formed, from a member who is perfectly
 * entitled to write it, because they have an outstanding question and
 * are about to act as though it were answered.
 *
 * So the suite is built around the two ways a lock like this fails, and
 * they are opposite:
 *
 *   LOCKING TOO LITTLE  the escape hatch nobody notices — an ask on the
 *                       repo dodged by acting on a file, an ask with no
 *                       subject binding nothing, a proceeding by one
 *                       member covering another. Each has a negative
 *                       here.
 *   LOCKING TOO MUCH    a gate that refuses everything satisfies every
 *                       negative test that can be written. So every
 *                       refusal below is paired with the nearest thing
 *                       that must still land: the same act by another
 *                       member, the same act once the ask is answered,
 *                       the same act after a proceeding, and the whole
 *                       ambient surface which must never be touched.
 *
 * The message assertions are not decoration either. §5's requirement is
 * that "an agent that cannot cite a ruling is told, in the refusal,
 * that it does not have one" — the deliverable is a sentence an agent
 * reads, so the sentence is what gets asserted, by grep.
 */

import type { SpineAsk, SpineCitationRequiredDetail, SpineEventKind } from 'csuite-sdk/types';
import { SPINE_CITATION_LOCKED_KINDS } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';
import { type AnnexStore, createSqliteAnnexStore, SpineError } from '../src/spine/index.js';
import { authed, LEA, makeSpineApp, post, RUNE } from './helpers/spine-app.js';

const T0 = Date.UTC(2026, 7, 9, 9, 0, 0);

let db: DatabaseSyncInstance;
let annex: AnnexStore;
let clock = T0;
let ops = 0;

function tick(): number {
  clock += 1000;
  return clock;
}

/** A fresh idempotency key per write; these tests are never testing replay. */
function op(): string {
  ops += 1;
  return `op-${ops}`;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  annex = createSqliteAnnexStore(db);
  clock = T0;
  ops = 0;
  annex.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea', tick());
  annex.registerSubject(
    { id: 'file:acme/api.ts', type: 'file', parent: 'repo:acme' },
    'lea',
    tick(),
  );
  annex.registerSubject(
    { id: 'file:acme/db.ts', type: 'file', parent: 'repo:acme' },
    'lea',
    tick(),
  );
});

/** A contract on `subject`: rune travels, lea judges, andrewjon rules. */
function contractOn(subject: string): string {
  return annex.append(
    {
      kind: 'specification',
      subject,
      opId: op(),
      body: {
        title: `Ship ${subject}`,
        criteria: [{ id: 'c1', text: 'the endpoint returns 200' }],
        assignee: 'rune',
        verifier: 'lea',
        authority: 'andrewjon',
      },
    },
    { actor: 'lea', now: tick() },
  ).event.id;
}

function askOn(
  where: { subject?: string; contract?: string; expectedStateRev?: number },
  actor = 'rune',
  question = 'may we drop the legacy header?',
  authority = 'andrewjon',
): string {
  return annex.append(
    {
      kind: 'ask',
      opId: op(),
      ...(where.subject !== undefined ? { subject: where.subject } : {}),
      ...(where.expectedStateRev !== undefined ? { expectedStateRev: where.expectedStateRev } : {}),
      body: {
        authority,
        question,
        context: 'two callers still send it',
        unblocks: 'the whole migration',
        ...(where.contract !== undefined ? { contract: where.contract } : {}),
      },
    },
    { actor, now: tick() },
  ).event.id;
}

function ruleOn(ask: string, actor = 'andrewjon'): string {
  return annex.append(
    {
      kind: 'ruling',
      opId: op(),
      body: { ask, decision: 'drop it', reasoning: 'both callers were told in March' },
    },
    { actor, now: tick() },
  ).event.id;
}

function proceedPast(ask: string, subject: string, actor = 'rune'): string {
  return annex.append(
    {
      kind: 'proceeding',
      opId: op(),
      subject,
      body: { ask, reason: 'the release ships today and the header is reversible' },
    },
    { actor, now: tick() },
  ).event.id;
}

/** The workhorse state-changing act: an attempt by the assignee. */
function attempt(contract: string, stateRev: number, actor = 'rune', cites?: string[]) {
  return annex.append(
    {
      kind: 'attempt',
      opId: op(),
      expectedStateRev: stateRev,
      revision: {
        subject: 'repo:acme',
        value: 'sha-a',
        how: 'asserted',
        source: `member:${actor}`,
      },
      ...(cites !== undefined ? { cites } : {}),
      body: { contract, summary: 'pushed the fix' },
    },
    { actor, now: tick() },
  );
}

function expectLocked(fn: () => unknown): SpineError {
  try {
    fn();
  } catch (err) {
    expect(err, 'expected a SpineError').toBeInstanceOf(SpineError);
    const spineErr = err as SpineError;
    // The SPECIFIC refusal. A bare throw assertion is satisfied by a
    // missing subject, a stale counter, or a typo in the fixture.
    expect(
      spineErr.code,
      `expected citation_required, got ${spineErr.code}: ${spineErr.message}`,
    ).toBe('citation_required');
    return spineErr;
  }
  throw new Error('expected a citation_required refusal, but the call returned');
}

function detailOf(err: SpineError): SpineCitationRequiredDetail {
  return err.detail as SpineCitationRequiredDetail;
}

// ─────────────────────────────────────────────────────────────────────

describe('an unresolved ask binds its asker', () => {
  it('lets the act land while the asker has nothing outstanding', () => {
    const contract = contractOn('repo:acme');
    // POSITIVE CONTROL, and it comes first deliberately: everything
    // below asserts a refusal, and a store that refused every attempt
    // would satisfy all of them.
    expect(attempt(contract, 1).event.kind).toBe('attempt');
  });

  it('refuses it once they have one, and says flatly that they hold no ruling', () => {
    const contract = contractOn('repo:acme');
    const ask = askOn({ subject: 'repo:acme' });

    const err = expectLocked(() => attempt(contract, 1));

    // The sentence an agent reads. §5: told, in the refusal, that it
    // does not have one.
    expect(err.message).toContain('YOU DO NOT HAVE A RULING');
    expect(err.message).toContain('remembered authorisation');
    // Both exits, named, because a lock with no exit is one members
    // route around.
    expect(err.message).toContain('proceeding');
    expect(err.message).toContain('andrewjon');
    // The ask itself, in the sentence — a member reading only the
    // message still has to be able to act on it.
    expect(err.message).toContain(ask);
    expect(err.message).toContain('may we drop the legacy header?');
    expect(err.message).toContain('the whole migration');
  });

  it('hands back the ask whole rather than an id to go and look up', () => {
    const contract = contractOn('repo:acme');
    const ask = askOn({ subject: 'repo:acme' });
    const detail = detailOf(expectLocked(() => attempt(contract, 1)));

    expect(detail.subject).toBe('repo:acme');
    expect(detail.kind).toBe('attempt');
    expect(detail.contract).toBe(contract);
    // WHOLE, field by field. An id here would invite the member to
    // remember what they asked, which is the failure being closed.
    expect(detail.asks).toHaveLength(1);
    const carried = detail.asks[0] as SpineAsk;
    expect(carried).toMatchObject({
      id: ask,
      asker: 'rune',
      authority: 'andrewjon',
      question: 'may we drop the legacy header?',
      context: 'two callers still send it',
      unblocks: 'the whole migration',
      state: 'open',
      subject: 'repo:acme',
    });
  });

  it('binds a deferred ask too — deferring is not answering', () => {
    const contract = contractOn('repo:acme');
    const ask = askOn({ subject: 'repo:acme' });
    annex.append(
      {
        kind: 'ask_action',
        opId: op(),
        body: { ask, action: 'defer', reason: 'revisit after the release', trigger: 'the release' },
      },
      { actor: 'andrewjon', now: tick() },
    );
    expect(annex.ask(ask)?.state).toBe('deferred');
    expect(detailOf(expectLocked(() => attempt(contract, 1))).asks[0]?.state).toBe('deferred');
  });

  it('releases the moment the ask is answered, and again when it is withdrawn', () => {
    const contract = contractOn('repo:acme');
    const ruled = askOn({ subject: 'repo:acme' });
    ruleOn(ruled);
    expect(attempt(contract, 1).event.kind).toBe('attempt');

    const withdrawn = askOn({ subject: 'repo:acme' });
    expectLocked(() => attempt(contract, 2));
    annex.append(
      {
        kind: 'ask_action',
        opId: op(),
        body: { ask: withdrawn, action: 'withdraw', reason: 'answered in chat' },
      },
      { actor: 'rune', now: tick() },
    );
    expect(attempt(contract, 2).event.kind).toBe('attempt');
  });

  it('binds an ask that names only a contract, scoping it by that contract subject', () => {
    // The commonest ask shape there is: §5's required fields do not
    // include a subject. Matching on the ask's own subject alone would
    // leave this one binding nothing at all.
    const contract = contractOn('repo:acme');
    askOn({ contract, expectedStateRev: 1 });
    const detail = detailOf(expectLocked(() => attempt(contract, 2)));
    expect(detail.asks[0]?.subject).toBeNull();
    expect(detail.asks[0]?.contract).toBe(contract);
  });
});

describe('containment: a rule one level up is not escaped one level down', () => {
  it('locks an act on a file when the ask was raised on the repo containing it', () => {
    const contract = contractOn('file:acme/api.ts');
    askOn({ subject: 'repo:acme' });

    const err = expectLocked(() => attempt(contract, 1));
    const detail = detailOf(err);
    // Outermost first, and both links present — the walk, not just its
    // endpoints.
    expect(detail.scope).toEqual(['repo:acme', 'file:acme/api.ts']);
    expect(detail.subject).toBe('file:acme/api.ts');
    expect(err.message).toContain('CONTAINING this one');
    expect(err.message).toContain('repo:acme ⊃ file:acme/api.ts');
  });

  it('does not lock an act on the repo when the ask was raised on a file inside it', () => {
    // Containment has a direction. A question about one file is not a
    // question about the whole repository, and a lock that ran both
    // ways would let any member freeze the repo by asking about a line
    // of it.
    const contract = contractOn('repo:acme');
    askOn({ subject: 'file:acme/api.ts' });
    expect(attempt(contract, 1).event.kind).toBe('attempt');
  });

  it('does not lock an act on a sibling file', () => {
    const contract = contractOn('file:acme/api.ts');
    askOn({ subject: 'file:acme/db.ts' });
    expect(attempt(contract, 1).event.kind).toBe('attempt');
  });
});

/**
 * The five, WRITTEN OUT. Not derived from the exported constant.
 *
 * An earlier version of this suite iterated `SPINE_CITATION_LOCKED_KINDS`
 * to build its cases and compared the result against the same list.
 * Deleting `lifecycle` from the constant then deleted the case that
 * would have caught it and the expectation that would have failed:
 * eighteen tests, all green, against a store that no longer locked
 * completions. A fixture that reads its answer from the thing under
 * test cannot fail, and mutation is the only thing that says so.
 */
const LOCKED_KINDS = [
  'specification',
  'amendment',
  'attempt',
  'criterion_verdict',
  'lifecycle',
] as const;

describe('which kinds the lock reaches', () => {
  it('publishes exactly those five kinds as locked', () => {
    // The list is a deliverable in its own right: the store enforces
    // it, the tool descriptions teach it, and an agent reading a
    // refusal has to recognise it. Pinned to the literal so a change
    // to the constant is a change somebody has to make here too.
    expect([...SPINE_CITATION_LOCKED_KINDS]).toEqual([...LOCKED_KINDS]);
  });

  /**
   * COMPLETENESS IN BOTH DIRECTIONS, in one place. The locked list must
   * be exactly the five state-changing kinds: a sixth would make the
   * conversation expensive, and a fourth would leave a way to change
   * what the team owes without answering for it.
   */
  it('refuses all five state-changing kinds, and lets all five land once the ask is answered', () => {
    const contract = contractOn('repo:acme');
    const ask = askOn({ subject: 'repo:acme' }, 'lea');

    // lea is the asker here, and also the author, verifier and a member
    // who may drive lifecycle — so one actor exercises all five kinds.
    const acts: Record<(typeof LOCKED_KINDS)[number], (stateRev: number) => unknown> = {
      specification: () =>
        annex.append(
          {
            kind: 'specification',
            subject: 'repo:acme',
            opId: op(),
            body: {
              title: 'A second contract',
              criteria: [{ id: 'c1', text: 'it works' }],
              assignee: 'rune',
            },
          },
          { actor: 'lea', now: tick() },
        ),
      amendment: (stateRev) =>
        annex.append(
          {
            kind: 'amendment',
            opId: op(),
            expectedStateRev: stateRev,
            body: {
              contract,
              changes: 'added a criterion',
              reason: 'the reviewer asked for it',
              disposition: 'scope_change',
              criteria: [
                { id: 'c1', text: 'the endpoint returns 200' },
                { id: 'c2', text: 'and logs the request id' },
              ],
            },
          },
          { actor: 'lea', now: tick() },
        ),
      attempt: (stateRev) => attempt(contract, stateRev, 'lea'),
      criterion_verdict: (stateRev) =>
        annex.append(
          {
            kind: 'criterion_verdict',
            opId: op(),
            expectedStateRev: stateRev,
            revision: {
              subject: 'repo:acme',
              value: 'sha-a',
              how: 'observed',
              source: 'integration:github',
            },
            body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
          },
          { actor: 'lea', now: tick() },
        ),
      lifecycle: (stateRev) =>
        annex.append(
          {
            kind: 'lifecycle',
            opId: op(),
            expectedStateRev: stateRev,
            body: { contract, state: 'waiting_on', member: 'rune', reason: 'needs a rebase' },
          },
          { actor: 'lea', now: tick() },
        ),
    };

    const refused = LOCKED_KINDS.map((kind) => {
      const err = expectLocked(() => acts[kind](1));
      return [kind, detailOf(err).kind] as const;
    });
    // The whole list, mapped to itself: a store that locked four of the
    // five would produce a shorter array, and a store that reported the
    // wrong kind in its detail would produce a different one.
    expect(refused).toEqual(LOCKED_KINDS.map((k) => [k, k]));
    // Nothing landed: the counter has not moved off the specification.
    expect(annex.contract(contract)?.stateRev).toBe(1);

    ruleOn(ask);
    // The same five, in a legal order, against a store that has stopped
    // refusing them.
    acts.specification(0);
    acts.amendment(1);
    acts.attempt(2);
    acts.criterion_verdict(3);
    acts.lifecycle(4);
    expect(annex.contract(contract)?.stateRev).toBe(5);
    expect(annex.contract(contract)?.state).toBe('waiting_on');
  });

  it('never touches the ambient surface, the lock’s own exits, or a correction', () => {
    const contract = contractOn('repo:acme');
    const ask = askOn({ subject: 'repo:acme' });
    // The authority has an open ask of their own, so the ruling below
    // is written by a member the lock would bind if rulings were
    // locked. Without this, "a ruling is never locked" is vacuous.
    askOn({ subject: 'repo:acme' }, 'andrewjon', 'do we need a second reviewer?', 'lea');

    const chat = annex.append(
      { kind: 'discussion', body: { body: 'looking at the header now', contract } },
      { actor: 'rune', now: tick() },
    );
    const landed: SpineEventKind[] = [chat.event.kind];

    landed.push(
      annex.append(
        {
          kind: 'observation',
          subject: 'file:acme/api.ts',
          body: { what: 'read the handler', output: 'it still sets the header' },
        },
        { actor: 'rune', now: tick() },
      ).event.kind,
    );
    landed.push(
      annex.append(
        {
          kind: 'testimony',
          subject: 'file:acme/api.ts',
          body: { what: 'the header', account: 'cora says it is unused', observer: 'cora' },
        },
        { actor: 'rune', now: tick() },
      ).event.kind,
    );
    const second = askOn({ subject: 'repo:acme' }, 'rune', 'and the trailing slash?');
    landed.push('ask');
    landed.push(
      annex.append(
        {
          kind: 'ask_action',
          opId: op(),
          body: { ask: second, action: 'withdraw', reason: 'answered in the thread' },
        },
        { actor: 'rune', now: tick() },
      ).event.kind,
    );
    landed.push(
      annex.append(
        {
          kind: 'proceeding',
          opId: op(),
          subject: 'repo:acme',
          body: { ask, reason: 'shipping today' },
        },
        { actor: 'rune', now: tick() },
      ).event.kind,
    );
    // Read back from the annex rather than assumed: the point is that
    // the ruling LANDED, and a helper returning a string proves nothing.
    landed.push(annex.event(ruleOn(ask))?.kind as SpineEventKind);
    landed.push(
      annex.append(
        {
          kind: 'correction',
          opId: op(),
          staplesTo: chat.event.id,
          // The chat post named the contract, so the correction reaches
          // it too and carries the precondition every authoritative
          // write on a contract carries. That is the counter, not the
          // lock.
          expectedStateRev: 1,
          body: { correction: 'cora said the opposite' },
        },
        { actor: 'rune', now: tick() },
      ).event.kind,
    );
    landed.push(
      annex.append(
        {
          kind: 'promotion',
          opId: op(),
          cites: [chat.event.id],
          expectedStateRev: 2,
          body: { as: 'observation' },
        },
        { actor: 'rune', now: tick() },
      ).event.kind,
    );

    // Every one of them, not "at least one". A lock that had crept onto
    // discussion would shorten this list, and the whole point of the
    // ambient class is that the conversation stays free.
    expect(landed).toEqual([
      'discussion',
      'observation',
      'testimony',
      'ask',
      'ask_action',
      'proceeding',
      'ruling',
      'correction',
      'promotion',
    ]);
  });
});

describe('the proceed coverage window', () => {
  it('covers every later act by that actor until the ask resolves, and a new ask locks again', () => {
    const contract = contractOn('repo:acme');
    const first = askOn({ subject: 'repo:acme' });
    expectLocked(() => attempt(contract, 1));

    proceedPast(first, 'repo:acme');
    // Not one-shot. §5's settled scope is one deliberate act of record,
    // not a toll on every write — so the SECOND act after the
    // proceeding matters more than the first.
    expect(attempt(contract, 1).event.kind).toBe('attempt');
    expect(attempt(contract, 2).event.kind).toBe('attempt');

    const second = askOn({ subject: 'repo:acme' }, 'rune', 'and the trailing slash?');
    const detail = detailOf(expectLocked(() => attempt(contract, 3)));
    // ONLY the new one. The first ask staying in this list would mean
    // the proceeding had been consumed rather than held.
    expect(detail.asks.map((a) => a.id)).toEqual([second]);

    proceedPast(second, 'repo:acme');
    expect(attempt(contract, 3).event.kind).toBe('attempt');
  });

  it('does not let one member’s proceeding cover another member’s ask', () => {
    const contract = contractOn('repo:acme');
    const runes = askOn({ subject: 'repo:acme' });
    const leas = askOn({ subject: 'repo:acme' }, 'lea', 'do we still support node 20?');

    proceedPast(runes, 'repo:acme');
    expect(attempt(contract, 1).event.kind).toBe('attempt');

    // lea's own ask is untouched by rune's proceeding, and lea is still
    // held to it.
    const detail = detailOf(expectLocked(() => attempt(contract, 2, 'lea')));
    expect(detail.asks.map((a) => a.id)).toEqual([leas]);
  });

  it('does not accept a proceeding past somebody else’s ask as cover', () => {
    const contract = contractOn('repo:acme');
    const ask = askOn({ subject: 'repo:acme' });
    // cora proceeds past rune's ask. Legal, and irrelevant: the lock is
    // per-ask PER ACTOR, and cover it does not.
    proceedPast(ask, 'repo:acme', 'cora');
    expect(detailOf(expectLocked(() => attempt(contract, 1))).asks.map((a) => a.id)).toEqual([ask]);
  });
});

describe('a ruling releases only the ask it answers', () => {
  it('lets the act land, citing the ruling, once the ask it named is answered', () => {
    const contract = contractOn('repo:acme');
    const ask = askOn({ subject: 'repo:acme' });
    const ruling = ruleOn(ask);
    expect(attempt(contract, 1, 'rune', [ruling]).event.kind).toBe('attempt');
  });

  it('refuses an act citing a ruling on a DIFFERENT ask, naming only the unanswered one', () => {
    const contract = contractOn('repo:acme');
    const answered = askOn({ subject: 'repo:acme' });
    const outstanding = askOn({ subject: 'repo:acme' }, 'rune', 'and the trailing slash?');
    const ruling = ruleOn(answered);

    const detail = detailOf(expectLocked(() => attempt(contract, 1, 'rune', [ruling])));
    expect(detail.asks.map((a) => a.id)).toEqual([outstanding]);
    expect(detail.asks.map((a) => a.id)).not.toContain(answered);
  });
});

describe('the lock reaches nobody else', () => {
  it('leaves every other member entirely unaffected by an outstanding ask', () => {
    const contract = contractOn('repo:acme');
    askOn({ subject: 'repo:acme' }, 'rune');

    // lea authors, verdicts and drives lifecycle on the very contract
    // rune is locked out of.
    expect(attempt(contract, 1, 'lea').event.kind).toBe('attempt');
    expect(contractOn('repo:acme')).toMatch(/^evt_/);
    expectLocked(() => attempt(contract, 2, 'rune'));
  });
});

describe('the lock binds every caller, not only the store', () => {
  it('refuses over HTTP with 409 citation_required and the ask in the body', async () => {
    const { app } = makeSpineApp();
    await post(app, '/spine/subjects', LEA, { id: 'repo:acme', type: 'repo' });
    const spec = (await post(app, '/spine/events', LEA, {
      kind: 'specification',
      subject: 'repo:acme',
      opId: 'op-spec',
      body: {
        title: 'Ship the endpoint',
        criteria: [{ id: 'c1', text: 'the endpoint returns 200' }],
        assignee: 'rune',
        verifier: 'lea',
        authority: 'andrewjon',
      },
    })) as { event: { id: string } };

    await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      opId: 'op-ask',
      subject: 'repo:acme',
      body: {
        authority: 'andrewjon',
        question: 'may we drop the legacy header?',
        context: 'two callers still send it',
        unblocks: 'the whole migration',
      },
    });

    const res = await app.request(
      '/spine/events',
      authed(RUNE, {
        kind: 'attempt',
        opId: 'op-attempt',
        expectedStateRev: 1,
        revision: {
          subject: 'repo:acme',
          value: 'sha-a',
          how: 'asserted',
          source: 'member:rune',
        },
        body: { contract: spec.event.id, summary: 'pushed the fix' },
      }),
    );
    // The consumer here is an HTTP client: the status code and the body
    // are the product, not the store's exception.
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      error: string;
      detail: SpineCitationRequiredDetail;
    };
    expect(body.code).toBe('citation_required');
    expect(body.error).toContain('YOU DO NOT HAVE A RULING');
    expect(body.detail.asks).toHaveLength(1);
    expect(body.detail.asks[0]?.question).toBe('may we drop the legacy header?');
    expect(body.detail.scope).toEqual(['repo:acme']);
  });
});
