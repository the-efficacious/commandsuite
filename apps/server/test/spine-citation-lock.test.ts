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
import { SpineError } from '../src/spine/index.js';
import { type AnnexWriter, createSqliteAnnexStore } from '../src/spine/store.js';
import { authed, LEA, makeSpineApp, post, RUNE } from './helpers/spine-app.js';

const T0 = Date.UTC(2026, 7, 9, 9, 0, 0);

let db: DatabaseSyncInstance;
let annex: AnnexWriter;
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
    // THE RULING EXIT, WORDED TRUTHFULLY. A ruling resolves its ask, so
    // "cite it on this write" instructs a step that cannot be the thing
    // that releases them — and the function's own doc comment calling
    // the wording "the feature" is not something that fails when the
    // wording reverts. This is.
    expect(err.message).toMatch(/that resolves the ask and releases you/);
    expect(err.message).not.toMatch(/cite it on this write/);
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
    // The count as well as the contents. A list assertion compared
    // against a literal already catches an addition, but stating the
    // arity separately is what makes "five" a claim in the file rather
    // than a property of whatever the literal happens to hold.
    expect(LOCKED_KINDS).toHaveLength(5);
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

describe('a caption cannot move an act out of its own contract’s scope', () => {
  /**
   * THE DODGE THIS CLOSES, plainly: `subject` is optional on the four
   * contract-bound locked kinds, and the lock scopes on it. So an
   * attempt — or a cancellation — on a contract about `repo:acme`,
   * captioned `subject: repo:other`, was evaluated in a scope where
   * the actor had no asks and landed. One caller-controlled field,
   * reachable through `promote`, which defaults the caption to the
   * origin post's subject.
   */
  beforeEach(() => {
    annex.registerSubject({ id: 'repo:other', type: 'repo' }, 'lea', tick());
  });

  it('refuses an act on a contract captioned with an unrelated subject', () => {
    const contract = contractOn('repo:acme');
    askOn({ subject: 'repo:acme' });

    let caught: SpineError | null = null;
    try {
      annex.append(
        {
          kind: 'attempt',
          opId: op(),
          expectedStateRev: 1,
          subject: 'repo:other',
          revision: {
            subject: 'repo:acme',
            value: 'sha-a',
            how: 'asserted',
            source: 'member:rune',
          },
          body: { contract, summary: 'pushed the fix' },
        },
        { actor: 'rune', now: tick() },
      );
    } catch (err) {
      caught = err as SpineError;
    }
    expect(caught, 'the dodge must not land').not.toBeNull();
    expect(caught?.code).toBe('invalid_input');
    // Both subjects named, because the member has to be able to tell
    // which of the two they got wrong.
    expect(caught?.message).toContain('repo:other');
    expect(caught?.message).toContain('repo:acme');
    // And nothing was written: the contract's counter has not moved.
    expect(annex.contract(contract)?.stateRev).toBe(1);
  });

  it('leaves the conversation alone — a post may name a contract and point elsewhere', () => {
    // THE EXEMPTION IS THE POINT, not an oversight. This rule exists to
    // protect the citation lock, and the lock never touches an ambient
    // kind, so applying it here would buy nothing and cost the one
    // thing §10 forbids by name: never make the conversation
    // expensive. "Aside: repo:other has the same bug" on a thread about
    // this contract is exactly the remark a member should be able to
    // write without first deciding which region of the room owns it.
    const contract = contractOn('repo:acme');
    const post = annex.append(
      {
        kind: 'discussion',
        subject: 'repo:other',
        body: { body: 'aside — repo:other has the same bug', contract },
      },
      { actor: 'rune', now: tick() },
    );
    expect(post.event.kind).toBe('discussion');
    expect(post.event.subject).toBe('repo:other');
    // …and it is still a post about this contract: the caption says
    // where the remark points, the body says what it is about.
    expect(post.event.contract).toBe(contract);
    // The observation and testimony halves of ambient, same shape.
    expect(
      annex.append(
        {
          kind: 'observation',
          subject: 'repo:other',
          body: { what: 'grepped the other repo', output: 'same handler, same bug' },
        },
        { actor: 'rune', now: tick() },
      ).event.kind,
    ).toBe('observation');
  });

  it('refuses the same shape on an authoritative kind, which is the control on that exemption', () => {
    // The pairing that makes the exemption a decision rather than a
    // hole: identical caption, identical contract, and the kind is what
    // decides. An attempt is an act on the world; a post is not.
    const contract = contractOn('repo:acme');
    annex.append(
      {
        kind: 'discussion',
        subject: 'repo:other',
        body: { body: 'aside — repo:other has the same bug', contract },
      },
      { actor: 'rune', now: tick() },
    );
    const err = (() => {
      try {
        annex.append(
          {
            kind: 'attempt',
            opId: op(),
            expectedStateRev: 1,
            subject: 'repo:other',
            revision: {
              subject: 'repo:acme',
              value: 'sha-a',
              how: 'asserted',
              source: 'member:rune',
            },
            body: { contract, summary: 'pushed the fix' },
          },
          { actor: 'rune', now: tick() },
        );
      } catch (e) {
        return e as SpineError;
      }
      return null;
    })();
    expect(err?.code).toBe('invalid_input');
  });

  it('refuses the same dodge on a lifecycle, which is the irreversible one', () => {
    const contract = contractOn('repo:acme');
    askOn({ subject: 'repo:acme' });
    const err = (() => {
      try {
        annex.append(
          {
            kind: 'lifecycle',
            opId: op(),
            expectedStateRev: 1,
            subject: 'repo:other',
            body: { contract, state: 'cancelled', reason: 'not needed' },
          },
          { actor: 'rune', now: tick() },
        );
      } catch (e) {
        return e as SpineError;
      }
      return null;
    })();
    expect(err?.code).toBe('invalid_input');
    expect(annex.contract(contract)?.state).toBe('active');
  });

  it('accepts a caption that is the contract’s own subject, or contained in it', () => {
    // THE POSITIVE CONTROL, and it is the whole reason the rule is
    // containment rather than equality: an attempt on one file inside
    // the repo the contract is about is a true, narrower caption and
    // must still land.
    const contract = contractOn('repo:acme');
    expect(
      annex.append(
        {
          kind: 'attempt',
          opId: op(),
          expectedStateRev: 1,
          subject: 'file:acme/api.ts',
          revision: {
            subject: 'repo:acme',
            value: 'sha-a',
            how: 'asserted',
            source: 'member:rune',
          },
          body: { contract, summary: 'pushed the fix' },
        },
        { actor: 'rune', now: tick() },
      ).event.subject,
    ).toBe('file:acme/api.ts');
    expect(
      annex.append(
        {
          kind: 'attempt',
          opId: op(),
          expectedStateRev: 2,
          subject: 'repo:acme',
          revision: {
            subject: 'repo:acme',
            value: 'sha-b',
            how: 'asserted',
            source: 'member:rune',
          },
          body: { contract, summary: 'again' },
        },
        { actor: 'rune', now: tick() },
      ).event.subject,
    ).toBe('repo:acme');
  });

  it('still locks the narrower caption, which is what the dodge was reaching for', () => {
    const contract = contractOn('repo:acme');
    askOn({ subject: 'repo:acme' });
    const err = expectLocked(() =>
      annex.append(
        {
          kind: 'attempt',
          opId: op(),
          expectedStateRev: 1,
          subject: 'file:acme/api.ts',
          revision: {
            subject: 'repo:acme',
            value: 'sha-a',
            how: 'asserted',
            source: 'member:rune',
          },
          body: { contract, summary: 'pushed the fix' },
        },
        { actor: 'rune', now: tick() },
      ),
    );
    // The scope is the union of both walks, so the repo-level ask is
    // found from a file-level caption on a repo-level contract.
    expect(detailOf(err).scope).toEqual(['repo:acme', 'file:acme/api.ts']);
  });
});

describe('which refusal wins when several apply', () => {
  /**
   * ORDERING IS A DECISION AND NOTHING PINNED IT. Reordering the lock
   * ahead of the precondition, or ahead of the legitimacy checks,
   * passed the entire spine suite. Both orderings are load-bearing for
   * a different reason, so both get a fixture.
   */
  it('answers a stale caller with the delta, not with the lock', () => {
    // The delta-carrying refusal wins because it is the one that
    // re-injects: reading what they missed may well remove the act.
    const contract = contractOn('repo:acme');
    askOn({ subject: 'repo:acme' });
    annex.append(
      {
        kind: 'attempt',
        opId: op(),
        expectedStateRev: 1,
        revision: { subject: 'repo:acme', value: 'sha-a', how: 'asserted', source: 'member:lea' },
        body: { contract, summary: 'lea moved it' },
      },
      { actor: 'lea', now: tick() },
    );

    let caught: SpineError | null = null;
    try {
      attempt(contract, 1);
    } catch (err) {
      caught = err as SpineError;
    }
    expect(caught?.code).toBe('stale_state_rev');
    // NON-EMPTY, because a stale refusal that wins the race and then
    // hands back nothing is worse than the lock's answer.
    const detail = caught?.detail as { intervening: { id: string }[] };
    expect(detail.intervening.length).toBeGreaterThan(0);
    expect(detail.intervening.map((e) => e.id)).toHaveLength(1);
  });

  it('answers a structurally impossible act as impossible, not as unauthorised', () => {
    // No ruling could make an assignee's verdict legal, so sending the
    // member to ask for one sends them to the wrong person.
    const contract = contractOn('repo:acme');
    askOn({ subject: 'repo:acme' });
    let caught: SpineError | null = null;
    try {
      annex.append(
        {
          kind: 'criterion_verdict',
          opId: op(),
          expectedStateRev: 1,
          revision: {
            subject: 'repo:acme',
            value: 'sha-a',
            how: 'observed',
            source: 'integration:github',
          },
          body: { contract, criterion: 'c1', decision: 'met', evidence: 'green' },
        },
        // rune is the assignee AND holds the open ask.
        { actor: 'rune', now: tick() },
      );
    } catch (err) {
      caught = err as SpineError;
    }
    expect(caught?.code).toBe('not_permitted');
    expect(caught?.message).toMatch(/traveller/);
  });
});

describe('a redirect re-addresses an ask; it does not resolve one', () => {
  function redirect(ask: string, to: string, actor = 'andrewjon') {
    return annex.append(
      {
        kind: 'ask_action',
        opId: op(),
        body: { ask, action: 'redirect', reason: 'lea owns this area', redirectTo: to },
      },
      { actor, now: tick() },
    );
  }

  it('leaves the asker locked after their authority hands the question on', () => {
    const contract = contractOn('repo:acme');
    const ask = askOn({ subject: 'repo:acme' });
    expectLocked(() => attempt(contract, 1));

    redirect(ask, 'lea');
    // The ask is open, not resolved: nobody has answered it.
    expect(annex.ask(ask)?.state).toBe('open');
    expect(annex.ask(ask)?.authority).toBe('lea');
    expect(annex.ask(ask)?.resolvedBy).toBeNull();
    // And the asker is still held to it — this is the moment the old
    // behaviour released them, which is the one moment the lock is
    // most obviously still needed.
    expect(detailOf(expectLocked(() => attempt(contract, 1))).asks.map((a) => a.id)).toEqual([ask]);
  });

  it('returns a deferred ask to open, since the new authority never deferred it', () => {
    const ask = askOn({ subject: 'repo:acme' });
    annex.append(
      {
        kind: 'ask_action',
        opId: op(),
        body: { ask, action: 'defer', reason: 'after the release', trigger: 'the release' },
      },
      { actor: 'andrewjon', now: tick() },
    );
    expect(annex.ask(ask)?.state).toBe('deferred');
    redirect(ask, 'lea');
    // Open, not deferred: the deferral was the OLD authority's answer
    // about their own queue, and it does not travel with the question.
    // Either way it keeps locking the asker, which is what matters.
    expect(annex.ask(ask)?.state).toBe('open');
    expect(annex.ask(ask)?.authority).toBe('lea');
  });

  it('moves the right to rule, and the ruling then releases the asker', () => {
    const contract = contractOn('repo:acme');
    const ask = askOn({ subject: 'repo:acme' });
    redirect(ask, 'lea');

    // The old authority may not rule on it any more.
    let caught: SpineError | null = null;
    try {
      ruleOn(ask, 'andrewjon');
    } catch (err) {
      caught = err as SpineError;
    }
    expect(caught?.code).toBe('not_permitted');
    expect(caught?.message).toContain('lea');

    // The new one may, and that resolves it.
    ruleOn(ask, 'lea');
    expect(annex.ask(ask)?.state).toBe('ruled');
    expect(attempt(contract, 1).event.kind).toBe('attempt');
  });

  it('shows the ask in the new authority’s orient and not the old one’s', () => {
    const ask = askOn({ subject: 'repo:acme' });
    expect(annex.orient('andrewjon').asksForMe.map((a) => a.id)).toEqual([ask]);
    redirect(ask, 'lea');
    expect(annex.orient('andrewjon').asksForMe).toEqual([]);
    expect(annex.orient('lea').asksForMe.map((a) => a.id)).toEqual([ask]);
    // And it is still the asker's open ask — one durable ask, one id.
    expect(annex.orient('rune').myOpenAsks.map((a) => a.id)).toEqual([ask]);
  });

  it('refuses a redirect back to the asker', () => {
    // The self-ask rule, restated where authority can move: redirected
    // to the asker, the ask becomes one whose authority may rule on it
    // and cite that ruling.
    const ask = askOn({ subject: 'repo:acme' });
    let caught: SpineError | null = null;
    try {
      redirect(ask, 'rune');
    } catch (err) {
      caught = err as SpineError;
    }
    expect(caught?.code).toBe('invalid_input');
    expect(caught?.message).toContain('rune');
    // The control: a redirect to anybody else still lands.
    expect(redirect(ask, 'cora').event.kind).toBe('ask_action');
  });

  it('survives a projection rebuild with the redirect applied', () => {
    // The fold is the only writer, and a redirect is now the one action
    // that changes a column other than `state`. A rebuild that dropped
    // the authority move would restore the released-asker bug silently.
    const ask = askOn({ subject: 'repo:acme' });
    redirect(ask, 'lea');
    annex.rebuildProjections();
    expect(annex.ask(ask)?.authority).toBe('lea');
    expect(annex.ask(ask)?.state).toBe('open');
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
