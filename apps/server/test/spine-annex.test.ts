/**
 * The annex store — the write path, and every guarantee that lives in
 * it.
 *
 * WHAT THESE ASSERT, AND WHY IN THIS SHAPE. Nearly every property here
 * is a refusal, and a suite of refusals passes happily against a store
 * that refuses everything. So each refusal is paired with the NEAREST
 * VALID THING it must still accept: a verdict from the assignee is
 * refused and one from the verifier lands; a stale precondition is
 * refused and the current one lands; an incomplete completion is
 * refused and a covered one lands. Where an assertion is about
 * completeness — a page, a delta, a rebuild — it asserts the whole
 * value rather than the presence of one member of it, because a short
 * page and a full page are indistinguishable to `toContain`.
 */

import type {
  SpineCoverageGapDetail,
  SpineIdempotencyConflictDetail,
  SpineStaleStateRevDetail,
} from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';
import { type AnnexStore, createSqliteAnnexStore, SpineError } from '../src/spine/index.js';

const T0 = Date.UTC(2026, 7, 8, 12, 0, 0);

let db: DatabaseSyncInstance;
let annex: AnnexStore;
let clock = T0;

/** Distinct instants, so `at` ordering is never a coin flip. */
function tick(): number {
  clock += 1000;
  return clock;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  annex = createSqliteAnnexStore(db);
  clock = T0;
  annex.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea', tick());
  annex.registerSubject(
    { id: 'file:acme/api.ts', type: 'file', parent: 'repo:acme' },
    'lea',
    tick(),
  );
});

/** A contract with a verifier: rune travels, lea judges, andrewjon rules. */
function authorContract(criteria = [{ id: 'c1', text: 'the endpoint returns 200' }]) {
  return annex.append(
    {
      kind: 'specification',
      subject: 'repo:acme',
      opId: `op-spec-${criteria.length}-${clock}`,
      body: {
        title: 'Ship the endpoint',
        criteria,
        assignee: 'rune',
        verifier: 'lea',
        authority: 'andrewjon',
      },
    },
    { actor: 'lea', now: tick() },
  );
}

const rev = (value: string, how: 'observed' | 'asserted' = 'observed') => ({
  subject: 'repo:acme',
  value,
  how,
  source: how === 'observed' ? 'integration:github' : 'member:rune',
});

function verdict(
  contract: string,
  stateRev: number,
  criterion: string,
  decision: 'met' | 'unmet' | 'cannot_verify',
  value = 'sha-a',
  actor = 'lea',
) {
  return annex.append(
    {
      kind: 'criterion_verdict',
      opId: `op-v-${criterion}-${decision}-${clock}`,
      expectedStateRev: stateRev,
      revision: rev(value),
      body: {
        contract,
        criterion,
        decision,
        evidence: 'ran the suite',
        ...(decision === 'cannot_verify' ? { why: 'no access to the deploy' } : {}),
      },
    },
    { actor, now: tick() },
  );
}

function expectSpineError(fn: () => unknown, code: string): SpineError {
  try {
    fn();
  } catch (err) {
    // The SPECIFIC failure, by identity. A bare `toThrow()` is
    // satisfied by a typo, a 404, or a missing subject just as
    // happily as by the refusal under test.
    expect(err, 'expected a SpineError').toBeInstanceOf(SpineError);
    const spineErr = err as SpineError;
    expect(spineErr.code, `expected ${code}, got ${spineErr.code}: ${spineErr.message}`).toBe(code);
    return spineErr;
  }
  throw new Error(`expected a ${code} SpineError, but the call returned`);
}

// ─────────────────────────────────────────────────────────────────────

describe('the stream', () => {
  it('assigns gapless seq in append order across every kind', () => {
    const spec = authorContract();
    annex.append(
      { kind: 'discussion', body: { body: 'looking at this now', contract: spec.event.id } },
      { actor: 'rune', now: tick() },
    );
    annex.append(
      {
        kind: 'observation',
        subject: 'file:acme/api.ts',
        body: { what: 'read the handler', output: 'it returns 204' },
      },
      { actor: 'rune', now: tick() },
    );
    annex.append(
      {
        kind: 'attempt',
        opId: 'op-att',
        expectedStateRev: 1,
        revision: rev('sha-a', 'asserted'),
        body: { contract: spec.event.id, summary: 'pushed the fix' },
      },
      { actor: 'rune', now: tick() },
    );

    // The whole sequence, not "seq 4 exists". A store that skipped one
    // would still contain a 4.
    expect(annex.events().events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(annex.events().events.map((e) => e.kind)).toEqual([
      'specification',
      'discussion',
      'observation',
      'attempt',
    ]);
  });

  it('stamps every caption an event carries', () => {
    const spec = authorContract();
    const stored = annex.event(spec.event.id);
    expect(stored).not.toBeNull();
    expect(stored?.actor).toBe('lea');
    expect(stored?.subject).toBe('repo:acme');
    expect(stored?.provenance).toBe('native');
    expect(stored?.class).toBe('authoritative');
    expect(stored?.opId).toBe(spec.event.opId);
    expect(Number.isNaN(Date.parse(stored?.at ?? ''))).toBe(false);
    expect(stored?.id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('gives ambient kinds no op_id and no state_rev, and authoritative ones both', () => {
    const spec = authorContract();
    const chat = annex.append(
      { kind: 'discussion', body: { body: 'a thought', contract: spec.event.id } },
      { actor: 'cora', now: tick() },
    );
    expect(chat.event.class).toBe('ambient');
    expect(chat.event.opId).toBeNull();
    expect(chat.event.stateRev).toBeNull();
    // …and the contract's counter did not move, which is the property
    // "a busy thread can never veto a lifecycle act".
    expect(annex.contract(spec.event.id)?.stateRev).toBe(1);
    expect(spec.event.stateRev).toBe(1);
  });

  it('refuses a citation to an event that is not in the annex, and accepts one that is', () => {
    const spec = authorContract();
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'discussion',
            cites: ['evt_nope'],
            body: { body: 'per evt_nope', contract: spec.event.id },
          },
          { actor: 'rune', now: tick() },
        ),
      'not_found',
    );
    // The nearest valid thing: the same post citing a real event.
    const ok = annex.append(
      {
        kind: 'discussion',
        cites: [spec.event.id],
        body: { body: 'per the spec', contract: spec.event.id },
      },
      { actor: 'rune', now: tick() },
    );
    expect(ok.event.cites).toEqual([spec.event.id]);
  });
});

describe('subjects and containment', () => {
  it('resolves containment transitively, several levels down', () => {
    annex.registerSubject({ id: 'pr:acme/7', type: 'pr', parent: 'repo:acme' }, 'lea', tick());
    annex.registerSubject(
      { id: 'file:acme/7/diff.ts', type: 'file', parent: 'pr:acme/7' },
      'lea',
      tick(),
    );
    // The whole contained set, sorted, so a resolver that stopped one
    // level down fails rather than passing on a subset.
    expect(
      annex
        .subjects({ within: 'repo:acme' })
        .map((s) => s.id)
        .sort(),
    ).toEqual(['file:acme/7/diff.ts', 'file:acme/api.ts', 'pr:acme/7', 'repo:acme']);
    // …and containment is not the whole registry: a sibling root is
    // outside it.
    annex.registerSubject({ id: 'repo:other', type: 'repo' }, 'lea', tick());
    expect(annex.subjects({ within: 'repo:acme' }).map((s) => s.id)).not.toContain('repo:other');
  });

  it('is idempotent on an identical re-registration and refuses a conflicting one', () => {
    const first = annex.subject('file:acme/api.ts');
    const again = annex.registerSubject(
      { id: 'file:acme/api.ts', type: 'file', parent: 'repo:acme' },
      'integration:github',
      tick(),
    );
    // Integrations re-register on every webhook; the second must be a
    // no-op that keeps the ORIGINAL registrar rather than rewriting it.
    expect(again).toEqual(first);
    expectSpineError(
      () => annex.registerSubject({ id: 'file:acme/api.ts', type: 'doc' }, 'lea', tick()),
      'invalid_input',
    );
  });

  it('refuses a child whose parent is not registered', () => {
    expectSpineError(
      () =>
        annex.registerSubject({ id: 'file:ghost.ts', type: 'file', parent: 'repo:ghost' }, 'lea'),
      'not_found',
    );
    // Positive control: register the parent and the same child lands.
    annex.registerSubject({ id: 'repo:ghost', type: 'repo' }, 'lea', tick());
    expect(
      annex.registerSubject(
        { id: 'file:ghost.ts', type: 'file', parent: 'repo:ghost' },
        'lea',
        tick(),
      ).parent,
    ).toBe('repo:ghost');
  });

  it('refuses to say anything about a subject nobody registered', () => {
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'observation',
            subject: 'repo:unknown',
            body: { what: 'looked', output: 'saw' },
          },
          { actor: 'rune', now: tick() },
        ),
      'not_found',
    );
  });
});

describe('revisions', () => {
  it('keeps every caption field of a revision it stores', () => {
    const spec = authorContract();
    const attempt = annex.append(
      {
        kind: 'attempt',
        opId: 'op-att',
        expectedStateRev: 1,
        revision: {
          subject: 'repo:acme',
          value: 'sha-a',
          how: 'asserted',
          source: 'member:rune',
        },
        body: { contract: spec.event.id, summary: 'pushed' },
      },
      { actor: 'rune', now: tick() },
    );
    // Read off the EVENT, because that is where a caller meets it —
    // and the event carries the caption whole, so nothing has to
    // resolve an id through a route that does not exist.
    const stored = attempt.event.revision;
    // The whole record. A store that dropped `source` would still
    // return a revision, and "verified at sha-a" with nobody saying
    // who looked is the exact shape §4 exists to remove.
    expect(stored).toEqual({
      id: expect.any(String),
      subject: 'repo:acme',
      value: 'sha-a',
      how: 'asserted',
      source: 'member:rune',
      at: stored?.at,
    });
    expect(stored?.at).toBeTruthy();
    // …and the standalone lookup agrees with what the event carries.
    expect(annex.revision(stored?.id as string)).toEqual(stored);
  });

  it('moves the head on an observed revision and never on an asserted one', () => {
    const spec = authorContract();
    annex.append(
      {
        kind: 'attempt',
        opId: 'op-att',
        expectedStateRev: 1,
        revision: rev('sha-a', 'asserted'),
        body: { contract: spec.event.id, summary: 'pushed' },
      },
      { actor: 'rune', now: tick() },
    );
    expect(annex.contract(spec.event.id)?.stale).toBe(false);

    // A member ASSERTING a different SHA must not flip everyone else's
    // contract to stale — that would let one member's belief rewrite
    // the team's staleness.
    annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        revision: rev('sha-z', 'asserted'),
        body: { what: 'I think main is here', output: 'sha-z' },
      },
      { actor: 'cora', now: tick() },
    );
    expect(annex.contract(spec.event.id)?.stale).toBe(false);

    // The integration observing it does.
    annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        revision: rev('sha-b'),
        body: { what: 'push webhook', output: 'main moved to sha-b' },
      },
      { actor: 'integration:github', now: tick() },
    );
    const contract = annex.contract(spec.event.id);
    expect(contract?.stale).toBe(true);
    // Hydrated: the head arrives WHOLE, so a reader of `stale` can see
    // what they are behind without a second lookup there is no route for.
    expect(contract?.head).toMatchObject({
      value: 'sha-b',
      how: 'observed',
      source: 'integration:github',
    });
  });

  it('does not report a contract stale against a re-observation of its own revision', () => {
    const spec = authorContract();
    annex.append(
      {
        kind: 'attempt',
        opId: 'op-att',
        expectedStateRev: 1,
        revision: rev('sha-a'),
        body: { contract: spec.event.id, summary: 'pushed' },
      },
      { actor: 'rune', now: tick() },
    );
    // A second observation of the SAME value is a second observation
    // point with its own id. Comparing ids rather than values here
    // would report the contract stale against itself.
    annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        revision: rev('sha-a'),
        body: { what: 'poll', output: 'still sha-a' },
      },
      { actor: 'integration:github', now: tick() },
    );
    expect(annex.contract(spec.event.id)?.stale).toBe(false);
  });
});

describe('the state_rev precondition', () => {
  it('advances only on authoritative events on that contract', () => {
    const spec = authorContract();
    const other = annex.append(
      {
        kind: 'specification',
        subject: 'file:acme/api.ts',
        opId: 'op-spec-other',
        body: { title: 'Other', criteria: [{ id: 'x', text: 'x' }], assignee: 'cora' },
      },
      { actor: 'lea', now: tick() },
    );
    annex.append(
      { kind: 'discussion', body: { body: 'chatter', contract: spec.event.id } },
      { actor: 'rune', now: tick() },
    );
    annex.append(
      {
        kind: 'attempt',
        opId: 'op-att-other',
        expectedStateRev: 1,
        body: { contract: other.event.id, summary: 'work on the OTHER contract' },
      },
      { actor: 'cora', now: tick() },
    );
    // Neither the chatter nor the other contract's attempt moved it.
    expect(annex.contract(spec.event.id)?.stateRev).toBe(1);
    expect(annex.contract(other.event.id)?.stateRev).toBe(2);
  });

  it('refuses a stale write and returns every intervening authoritative event in full', () => {
    const spec = authorContract();
    annex.append(
      {
        kind: 'attempt',
        opId: 'op-att',
        expectedStateRev: 1,
        body: { contract: spec.event.id, summary: 'pushed' },
      },
      { actor: 'rune', now: tick() },
    );
    const v = verdict(spec.event.id, 2, 'c1', 'unmet');

    const err = expectSpineError(
      () =>
        annex.append(
          {
            kind: 'lifecycle',
            opId: 'op-park',
            expectedStateRev: 1,
            body: { contract: spec.event.id, state: 'parked', preemptedBy: 'the incident' },
          },
          { actor: 'lea', now: tick() },
        ),
      'stale_state_rev',
    );
    const detail = err.detail as SpineStaleStateRevDetail;
    expect(detail.expectedStateRev).toBe(1);
    expect(detail.currentStateRev).toBe(3);
    // COMPLETE, in order, and in full. A delta that named only the
    // latest event, or only ids, would leave the caller to make a
    // second call to find out what it raced.
    expect(detail.intervening.map((e) => e.kind)).toEqual(['attempt', 'criterion_verdict']);
    expect(detail.intervening.map((e) => e.stateRev)).toEqual([2, 3]);
    const returnedVerdict = detail.intervening[1];
    expect(returnedVerdict?.id).toBe(v.event.id);
    expect(returnedVerdict?.body).toEqual(annex.event(v.event.id)?.body);
  });

  it('accepts the same write once the caller has read the delta', () => {
    const spec = authorContract();
    verdict(spec.event.id, 1, 'c1', 'unmet');
    // The positive control for the whole precondition: a suite of
    // "refuses stale" passes against a store that refuses everything.
    const parked = annex.append(
      {
        kind: 'lifecycle',
        opId: 'op-park',
        expectedStateRev: 2,
        body: { contract: spec.event.id, state: 'parked', preemptedBy: 'the incident' },
      },
      { actor: 'lea', now: tick() },
    );
    expect(parked.contract?.state).toBe('parked');
    expect(parked.contract?.stateRev).toBe(3);
    expect(parked.contract?.preemptedBy).toBe('the incident');
  });

  it('requires a precondition on a conditionally contract-bound write', () => {
    const spec = authorContract();
    const ask = annex.append(
      {
        kind: 'ask',
        opId: 'op-ask',
        expectedStateRev: 1,
        subject: 'repo:acme',
        body: {
          authority: 'andrewjon',
          question: 'ship on Friday?',
          context: 'the fix is green',
          unblocks: 'the release',
          contract: spec.event.id,
        },
      },
      { actor: 'rune', now: tick() },
    );
    expect(annex.ask(ask.event.id)?.state).toBe('open');
    expect(annex.contract(spec.event.id)?.stateRev).toBe(2);
  });
});

describe('idempotency', () => {
  it('replays the original event for the same op_id and the same payload', () => {
    const spec = authorContract();
    const payload = {
      kind: 'attempt',
      opId: 'op-att-retry',
      expectedStateRev: 1,
      body: { contract: spec.event.id, summary: 'pushed the fix' },
    } as const;
    const first = annex.append({ ...payload }, { actor: 'rune', now: tick() });
    const second = annex.append({ ...payload }, { actor: 'rune', now: tick() });

    expect(second.replayed).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(second.event.seq).toBe(first.event.seq);
    // EXACTLY ONE event, counted on the stream rather than inferred
    // from the ids matching.
    expect(annex.events({ kind: 'attempt' }).events).toHaveLength(1);
    expect(annex.contract(spec.event.id)?.stateRev).toBe(2);
  });

  it('replays even when the retry carries a newer precondition', () => {
    const spec = authorContract();
    const first = annex.append(
      {
        kind: 'attempt',
        opId: 'op-att-retry',
        expectedStateRev: 1,
        body: { contract: spec.event.id, summary: 'pushed the fix' },
      },
      { actor: 'rune', now: tick() },
    );
    verdict(spec.event.id, 2, 'c1', 'unmet');
    // The counter has moved. A retry of the SAME write with the
    // counter the caller now believes is still the same write — the
    // precondition is not payload, and treating it as payload would
    // refuse the one retry idempotency exists to make free.
    const retry = annex.append(
      {
        kind: 'attempt',
        opId: 'op-att-retry',
        expectedStateRev: 3,
        body: { contract: spec.event.id, summary: 'pushed the fix' },
      },
      { actor: 'rune', now: tick() },
    );
    expect(retry.replayed).toBe(true);
    expect(retry.event.id).toBe(first.event.id);
    expect(annex.events({ kind: 'attempt' }).events).toHaveLength(1);
  });

  it('refuses the same op_id carrying a different payload', () => {
    const spec = authorContract();
    const first = annex.append(
      {
        kind: 'attempt',
        opId: 'op-att-retry',
        expectedStateRev: 1,
        body: { contract: spec.event.id, summary: 'pushed the fix' },
      },
      { actor: 'rune', now: tick() },
    );
    const err = expectSpineError(
      () =>
        annex.append(
          {
            kind: 'attempt',
            opId: 'op-att-retry',
            expectedStateRev: 2,
            body: { contract: spec.event.id, summary: 'pushed something ELSE' },
          },
          { actor: 'rune', now: tick() },
        ),
      'idempotency_conflict',
    );
    expect((err.detail as SpineIdempotencyConflictDetail).originalEvent).toBe(first.event.id);
    expect(annex.events({ kind: 'attempt' }).events).toHaveLength(1);
  });

  it('treats a payload whose keys were written in a different order as the same payload', () => {
    const spec = authorContract();
    const first = annex.append(
      {
        kind: 'attempt',
        opId: 'op-order',
        expectedStateRev: 1,
        body: { contract: spec.event.id, summary: 'pushed' },
      },
      { actor: 'rune', now: tick() },
    );
    const reordered = annex.append(
      {
        expectedStateRev: 1,
        body: { summary: 'pushed', contract: spec.event.id },
        opId: 'op-order',
        kind: 'attempt',
      },
      { actor: 'rune', now: tick() },
    );
    expect(reordered.replayed).toBe(true);
    expect(reordered.event.id).toBe(first.event.id);
  });
});

describe('verdict legitimacy', () => {
  it('refuses a verdict from the assignee and accepts one from anybody else', () => {
    const spec = authorContract();
    expectSpineError(
      () => verdict(spec.event.id, 1, 'c1', 'met', 'sha-a', 'rune'),
      'not_permitted',
    );
    // Both nearest valid things: the named verifier…
    const byVerifier = verdict(spec.event.id, 1, 'c1', 'met', 'sha-a', 'lea');
    expect(byVerifier.event.kind).toBe('criterion_verdict');
    // …and an independent third member, because the rule is "not the
    // traveller", not "only the verifier".
    const byThirdParty = verdict(spec.event.id, 2, 'c1', 'met', 'sha-b', 'cora');
    expect(byThirdParty.event.actor).toBe('cora');
  });

  it('refuses a verdict naming a criterion the contract does not have', () => {
    const spec = authorContract();
    const err = expectSpineError(
      () => verdict(spec.event.id, 1, 'not-a-criterion', 'met'),
      'invalid_input',
    );
    expect(err.message).toContain('not-a-criterion');
    expect(verdict(spec.event.id, 1, 'c1', 'met').event.kind).toBe('criterion_verdict');
  });
});

describe('rulings and asks', () => {
  function openAsk(contract?: string, stateRev?: number) {
    return annex.append(
      {
        kind: 'ask',
        opId: `op-ask-${clock}`,
        subject: 'repo:acme',
        ...(contract !== undefined ? { expectedStateRev: stateRev } : {}),
        body: {
          authority: 'andrewjon',
          question: 'may we ship on Friday?',
          context: 'the fix is green but the release window is tight',
          unblocks: 'the 0.6 release',
          ...(contract !== undefined ? { contract } : {}),
        },
      },
      { actor: 'rune', now: tick() },
    );
  }

  it('refuses a ruling from anyone but the ask’s named authority', () => {
    const ask = openAsk();
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'ruling',
            opId: 'op-rule-wrong',
            body: { ask: ask.event.id, decision: 'yes', reasoning: 'seems fine' },
          },
          { actor: 'lea', now: tick() },
        ),
      'not_permitted',
    );
    const ruled = annex.append(
      {
        kind: 'ruling',
        opId: 'op-rule',
        body: { ask: ask.event.id, decision: 'ship it', reasoning: 'the window holds' },
      },
      { actor: 'andrewjon', now: tick() },
    );
    expect(ruled.event.kind).toBe('ruling');
    expect(annex.ask(ask.event.id)?.state).toBe('ruled');
    expect(annex.ask(ask.event.id)?.resolvedBy).toBe(ruled.event.id);
  });

  it('lets the asker withdraw and refuses a withdrawal from the authority', () => {
    const ask = openAsk();
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'ask_action',
            opId: 'op-wd-wrong',
            body: { ask: ask.event.id, action: 'withdraw', reason: 'never mind' },
          },
          { actor: 'andrewjon', now: tick() },
        ),
      'not_permitted',
    );
    const withdrawn = annex.append(
      {
        kind: 'ask_action',
        opId: 'op-wd',
        body: { ask: ask.event.id, action: 'withdraw', reason: 'answered itself' },
      },
      { actor: 'rune', now: tick() },
    );
    expect(annex.ask(ask.event.id)?.state).toBe('withdrawn');
    expect(annex.ask(ask.event.id)?.resolvedBy).toBe(withdrawn.event.id);
  });

  it('records a proceed against an open ask and refuses one against a resolved ask', () => {
    const ask = openAsk();
    const proceeded = annex.append(
      {
        kind: 'proceeding',
        opId: 'op-proceed',
        subject: 'repo:acme',
        body: { ask: ask.event.id, reason: 'the window closes before the ruling can land' },
      },
      { actor: 'rune', now: tick() },
    );
    expect(proceeded.event.kind).toBe('proceeding');
    annex.append(
      {
        kind: 'ruling',
        opId: 'op-rule',
        body: { ask: ask.event.id, decision: 'fine', reasoning: 'after the fact' },
      },
      { actor: 'andrewjon', now: tick() },
    );
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'proceeding',
            opId: 'op-proceed-2',
            subject: 'repo:acme',
            body: { ask: ask.event.id, reason: 'again' },
          },
          { actor: 'rune', now: tick() },
        ),
      'invalid_transition',
    );
  });
});

describe('completion coverage', () => {
  function complete(contract: string, stateRev: number, cites: string[], value = 'sha-a') {
    return annex.append(
      {
        kind: 'lifecycle',
        opId: `op-done-${clock}`,
        expectedStateRev: stateRev,
        revision: rev(value, 'asserted'),
        cites,
        body: { contract, state: 'done', result: 'shipped in 0.6' },
      },
      { actor: 'rune', now: tick() },
    );
  }

  it('refuses completion that leaves a criterion uncovered and names the gap', () => {
    const spec = authorContract([
      { id: 'c1', text: 'the endpoint returns 200' },
      { id: 'c2', text: 'the docs say so' },
    ]);
    const v1 = verdict(spec.event.id, 1, 'c1', 'met');
    const err = expectSpineError(() => complete(spec.event.id, 2, [v1.event.id]), 'coverage_gap');
    const detail = err.detail as SpineCoverageGapDetail;
    // The GAP, named — not "coverage failed". The whole list, so a
    // check that reported one of two missing criteria fails here.
    expect(detail.missing.map((m) => m.criterion)).toEqual(['c2']);
    expect(detail.missing[0]?.text).toBe('the docs say so');
    expect(detail.missing[0]?.why).toContain('no verdict has been reached');
    // F9: the refusal carries the caption it was refused against,
    // rather than a null beside a message quoting the value.
    expect(detail.revision).toMatchObject({ value: 'sha-a', how: 'asserted' });
    expect(annex.contract(spec.event.id)?.state).toBe('active');
  });

  it('refuses completion citing an unmet verdict, and says which one', () => {
    const spec = authorContract();
    const v = verdict(spec.event.id, 1, 'c1', 'unmet');
    const err = expectSpineError(() => complete(spec.event.id, 2, [v.event.id]), 'coverage_gap');
    expect((err.detail as SpineCoverageGapDetail).missing[0]?.why).toContain('unmet');
  });

  it('refuses completion whose verdicts sit at a different revision', () => {
    const spec = authorContract();
    const v = verdict(spec.event.id, 1, 'c1', 'met', 'sha-a');
    const err = expectSpineError(
      () => complete(spec.event.id, 2, [v.event.id], 'sha-b'),
      'coverage_gap',
    );
    expect((err.detail as SpineCoverageGapDetail).missing[0]?.why).toContain('sha-b');
  });

  it('completes when cited verdicts cover every criterion at one revision', () => {
    const spec = authorContract([
      { id: 'c1', text: 'the endpoint returns 200' },
      { id: 'c2', text: 'the docs say so' },
    ]);
    const v1 = verdict(spec.event.id, 1, 'c1', 'met');
    const v2 = verdict(spec.event.id, 2, 'c2', 'met');
    const done = complete(spec.event.id, 3, [v1.event.id, v2.event.id]);
    expect(done.contract?.state).toBe('done');
    expect(done.contract?.result).toBe('shipped in 0.6');
  });

  it('completes on a ruling that waives a cannot_verify, and not on the cannot_verify alone', () => {
    const spec = authorContract();
    const cv = verdict(spec.event.id, 1, 'c1', 'cannot_verify');
    // Move 3 of the three legal moves after `cannot_verify`. Without
    // the waiver the completion is refused…
    const err = expectSpineError(() => complete(spec.event.id, 2, [cv.event.id]), 'coverage_gap');
    expect((err.detail as SpineCoverageGapDetail).missing[0]?.why).toContain('cannot_verify');

    const ask = annex.append(
      {
        kind: 'ask',
        opId: 'op-ask-waiver',
        subject: 'repo:acme',
        body: {
          authority: 'andrewjon',
          question: 'lea cannot verify c1 — waive it?',
          context: 'no deploy access',
          unblocks: 'completion',
        },
      },
      { actor: 'rune', now: tick() },
    );
    const waiver = annex.append(
      {
        kind: 'ruling',
        opId: 'op-waive',
        cites: [cv.event.id],
        body: { ask: ask.event.id, decision: 'waived', reasoning: 'the risk is acceptable' },
      },
      { actor: 'andrewjon', now: tick() },
    );
    // …and with it, the same completion lands.
    const done = complete(spec.event.id, 2, [cv.event.id, waiver.event.id]);
    expect(done.contract?.state).toBe('done');
  });

  it('lets a contract with no verifier complete on its result alone', () => {
    const spec = annex.append(
      {
        kind: 'specification',
        subject: 'repo:acme',
        opId: 'op-spec-solo',
        body: { title: 'Tidy up', criteria: [{ id: 'c1', text: 'tidier' }], assignee: 'rune' },
      },
      { actor: 'lea', now: tick() },
    );
    const done = annex.append(
      {
        kind: 'lifecycle',
        opId: 'op-done-solo',
        expectedStateRev: 1,
        body: { contract: spec.event.id, state: 'done', result: 'tidied' },
      },
      { actor: 'rune', now: tick() },
    );
    expect(done.contract?.state).toBe('done');
    // The absence of a verifier is a stated fact on the contract, not
    // a silence a reader has to interpret.
    expect(done.contract?.verifier).toBeNull();
  });
});

describe('terminality and supersession', () => {
  function cancel(contract: string, stateRev: number) {
    return annex.append(
      {
        kind: 'lifecycle',
        opId: `op-cancel-${clock}`,
        expectedStateRev: stateRev,
        body: { contract, state: 'cancelled', reason: 'the customer withdrew' },
      },
      { actor: 'lea', now: tick() },
    );
  }

  it('refuses a further authoritative event on a terminal contract', () => {
    const spec = authorContract();
    cancel(spec.event.id, 1);
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'attempt',
            opId: 'op-att-after',
            expectedStateRev: 2,
            body: { contract: spec.event.id, summary: 'carrying on anyway' },
          },
          { actor: 'rune', now: tick() },
        ),
      'invalid_transition',
    );
  });

  it('still accepts a stapled correction on a terminal contract, and discussion of it', () => {
    const spec = authorContract();
    const cancelled = cancel(spec.event.id, 1);
    const correction = annex.append(
      {
        kind: 'correction',
        opId: 'op-correct',
        staplesTo: cancelled.event.id,
        expectedStateRev: 2,
        body: { correction: 'the customer did not withdraw; the budget was reallocated' },
      },
      { actor: 'lea', now: tick() },
    );
    expect(correction.event.staplesTo).toBe(cancelled.event.id);
    // The cancellation itself is untouched: a correction staples, it
    // never rewrites.
    expect(annex.event(cancelled.event.id)?.body).toEqual({
      contract: spec.event.id,
      state: 'cancelled',
      reason: 'the customer withdrew',
    });
    expect(annex.contract(spec.event.id)?.reason).toBe('the customer withdrew');
    const chatter = annex.append(
      { kind: 'discussion', body: { body: 'noting this for the retro', contract: spec.event.id } },
      { actor: 'cora', now: tick() },
    );
    expect(chatter.event.seq).toBeGreaterThan(correction.event.seq);
  });

  it('refuses supersession to a contract that does not exist, and to itself', () => {
    const spec = authorContract();
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'lifecycle',
            opId: 'op-sup-ghost',
            expectedStateRev: 1,
            body: { contract: spec.event.id, state: 'superseded', successor: 'evt_ghost' },
          },
          { actor: 'lea', now: tick() },
        ),
      'not_found',
    );
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'lifecycle',
            opId: 'op-sup-self',
            expectedStateRev: 1,
            body: { contract: spec.event.id, state: 'superseded', successor: spec.event.id },
          },
          { actor: 'lea', now: tick() },
        ),
      'invalid_input',
    );
  });
});

describe('paging', () => {
  it('returns FULL pages while rows remain, and every event exactly once', () => {
    const spec = authorContract();
    for (let i = 0; i < 24; i++) {
      annex.append(
        { kind: 'discussion', body: { body: `post ${i}`, contract: spec.event.id } },
        { actor: 'cora', now: tick() },
      );
    }
    const total = 25;
    const seen: number[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = annex.events({ since_seq: cursor, limit: 10 });
      pages += 1;
      // THE PAGE-FULL PROPERTY. A short page while rows remain is the
      // defect this asserts against; "the deleted id is absent" would
      // pass against it.
      if (page.nextCursor !== null) {
        expect(page.events, `page ${pages} was short while more rows remained`).toHaveLength(10);
      }
      seen.push(...page.events.map((e) => e.seq));
      expect(page.headSeq).toBe(total);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(10);
    }
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it('pages a FILTERED stream completely', () => {
    const spec = authorContract();
    for (let i = 0; i < 6; i++) {
      annex.append(
        { kind: 'discussion', body: { body: `post ${i}`, contract: spec.event.id } },
        { actor: 'cora', now: tick() },
      );
      annex.append(
        {
          kind: 'observation',
          subject: 'file:acme/api.ts',
          body: { what: `look ${i}`, output: 'nothing yet' },
        },
        { actor: 'rune', now: tick() },
      );
    }
    const first = annex.events({ kind: 'discussion', limit: 4 });
    expect(first.events).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();
    const second = annex.events({
      kind: 'discussion',
      limit: 4,
      since_seq: first.nextCursor as number,
    });
    // Six discussion posts total: 4 + 2, and every one of them.
    expect(second.events).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(
      [...first.events, ...second.events].map((e) => (e.body as { body: string }).body),
    ).toEqual(['post 0', 'post 1', 'post 2', 'post 3', 'post 4', 'post 5']);
  });

  it('filters by contract, subject containment, and actor', () => {
    const spec = authorContract();
    annex.append(
      {
        kind: 'observation',
        subject: 'file:acme/api.ts',
        body: { what: 'read it', output: 'fine' },
      },
      { actor: 'cora', now: tick() },
    );
    annex.append(
      { kind: 'discussion', body: { body: 'about the contract', contract: spec.event.id } },
      { actor: 'cora', now: tick() },
    );
    expect(annex.events({ contract: spec.event.id }).events.map((e) => e.kind)).toEqual([
      'specification',
      'discussion',
    ]);
    // The observation is on a FILE inside the repo, and a filter on
    // the repo has to reach it.
    expect(annex.events({ subject: 'repo:acme' }).events.map((e) => e.kind)).toEqual([
      'specification',
      'observation',
    ]);
    expect(annex.events({ actor: 'cora' }).events).toHaveLength(2);
    expect(annex.events({ actor: 'nobody' }).events).toEqual([]);
  });
});

describe('projections are folds', () => {
  it('rebuilds to exactly the incrementally maintained state after a varied stream', () => {
    const spec = authorContract([
      { id: 'c1', text: 'the endpoint returns 200' },
      { id: 'c2', text: 'the docs say so' },
    ]);
    annex.append(
      {
        kind: 'attempt',
        opId: 'op-att',
        expectedStateRev: 1,
        revision: rev('sha-a', 'asserted'),
        body: { contract: spec.event.id, summary: 'pushed' },
      },
      { actor: 'rune', now: tick() },
    );
    annex.append(
      {
        kind: 'amendment',
        opId: 'op-amend',
        expectedStateRev: 2,
        body: {
          contract: spec.event.id,
          changes: 'tightened c2',
          reason: 'the original was ambiguous',
          disposition: 'correction',
          disclosure:
            'the prior wording of c2 was "the docs say so" — anyone who read it as ' +
            'covering the changelog was working to something this contract never meant',
          criteria: [
            { id: 'c1', text: 'the endpoint returns 200' },
            { id: 'c2', text: 'the reference page documents it' },
          ],
        },
      },
      { actor: 'lea', now: tick() },
    );
    const cv = verdict(spec.event.id, 3, 'c1', 'cannot_verify');
    const ask = annex.append(
      {
        kind: 'ask',
        opId: 'op-ask',
        subject: 'repo:acme',
        body: {
          authority: 'andrewjon',
          question: 'waive c1?',
          context: 'no deploy access',
          unblocks: 'completion',
        },
      },
      { actor: 'rune', now: tick() },
    );
    annex.append(
      {
        kind: 'ruling',
        opId: 'op-waive',
        cites: [cv.event.id],
        body: { ask: ask.event.id, decision: 'waived', reasoning: 'acceptable' },
      },
      { actor: 'andrewjon', now: tick() },
    );
    const chat = annex.append(
      { kind: 'discussion', body: { body: 'on it', contract: spec.event.id } },
      { actor: 'cora', now: tick() },
    );
    annex.append(
      {
        kind: 'promotion',
        opId: 'op-promote',
        expectedStateRev: 4,
        cites: [chat.event.id],
        body: { as: 'testimony', note: 'worth keeping' },
      },
      { actor: 'cora', now: tick() },
    );
    annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        revision: rev('sha-b'),
        body: { what: 'push webhook', output: 'main moved' },
      },
      { actor: 'integration:github', now: tick() },
    );

    const contractsBefore = annex.contracts();
    const eventsBefore = annex.events({ limit: 500 }).events;
    const orientBefore = annex.orient('lea', clock);
    const askBefore = annex.ask(ask.event.id);

    annex.rebuildProjections();

    // Whole values, not spot fields — the rebuild is only meaningful
    // if NOTHING differs, and a field-by-field check is complete on
    // the day it is written.
    expect(annex.contracts()).toEqual(contractsBefore);
    expect(annex.events({ limit: 500 }).events).toEqual(eventsBefore);
    expect(annex.orient('lea', clock)).toEqual(orientBefore);
    expect(annex.ask(ask.event.id)).toEqual(askBefore);
    // …and the rebuild is not vacuous: the stream it folded is varied.
    expect(new Set(eventsBefore.map((e) => e.kind)).size).toBeGreaterThanOrEqual(8);
  });
});

describe('orient', () => {
  it('returns every binding a member holds, with criteria, staleness and a cursor', () => {
    const spec = authorContract();
    annex.append(
      {
        kind: 'attempt',
        opId: 'op-att',
        expectedStateRev: 1,
        revision: rev('sha-a', 'asserted'),
        body: { contract: spec.event.id, summary: 'pushed' },
      },
      { actor: 'rune', now: tick() },
    );
    verdict(spec.event.id, 2, 'c1', 'unmet');
    annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        revision: rev('sha-b'),
        body: { what: 'push webhook', output: 'main moved' },
      },
      { actor: 'integration:github', now: tick() },
    );

    const pack = annex.orient('lea', clock);
    expect(pack.member).toBe('lea');
    expect(pack.cursor).toBe(annex.events().headSeq);
    expect(pack.contracts).toHaveLength(1);
    const one = pack.contracts[0];
    // lea is the verifier and nothing else here — authoring a contract
    // is not a binding, and the pack says so. The two-binding case is
    // the next test, which is where "every binding, not the first one
    // found" is actually measured.
    expect(one?.bindings).toEqual(['verifier']);
    expect(one?.criteria).toEqual([
      {
        criterion: 'c1',
        text: 'the endpoint returns 200',
        decision: 'unmet',
        // WHOLE. "unmet at rev_01H…" is a verdict a member cannot check.
        revision: {
          id: expect.any(String),
          subject: 'repo:acme',
          value: 'sha-a',
          how: 'observed',
          source: 'integration:github',
          at: expect.any(String),
        },
        event: expect.any(String),
        waivedBy: null,
        atBoundRevision: true,
      },
    ]);
    expect(one?.stale).toBe(true);
    expect(one?.head?.value).toBe('sha-b');
    expect(one?.revision?.value).toBe('sha-a');
    expect(one?.subject.id).toBe('repo:acme');
  });

  it('reports both bindings when one member holds two, and nothing for an unbound member', () => {
    annex.append(
      {
        kind: 'specification',
        subject: 'repo:acme',
        opId: 'op-spec-two',
        body: {
          title: 'Two hats',
          criteria: [{ id: 'c1', text: 'done' }],
          assignee: 'rune',
          verifier: 'lea',
          authority: 'lea',
        },
      },
      { actor: 'lea', now: tick() },
    );
    expect(annex.orient('lea', clock).contracts[0]?.bindings).toEqual(['verifier', 'authority']);
    // The positive control's mirror: a member with no bindings gets an
    // empty pack rather than everyone's plate.
    const stranger = annex.orient('seamus', clock);
    expect(stranger.contracts).toEqual([]);
    expect(stranger.asksForMe).toEqual([]);
    expect(stranger.cursor).toBe(annex.events().headSeq);
  });

  it('carries the asks awaiting the caller and the rulings that bind their contracts', () => {
    const spec = authorContract();
    const ask = annex.append(
      {
        kind: 'ask',
        opId: 'op-ask',
        subject: 'repo:acme',
        expectedStateRev: 1,
        body: {
          authority: 'andrewjon',
          question: 'ship on Friday?',
          context: 'tight window',
          unblocks: 'the release',
          contract: spec.event.id,
        },
      },
      { actor: 'rune', now: tick() },
    );
    const authorityPack = annex.orient('andrewjon', clock);
    expect(authorityPack.asksForMe.map((a) => a.id)).toEqual([ask.event.id]);
    expect(authorityPack.asksForMe[0]?.unblocks).toBe('the release');

    const ruling = annex.append(
      {
        kind: 'ruling',
        opId: 'op-rule',
        expectedStateRev: 2,
        body: {
          ask: ask.event.id,
          decision: 'ship it',
          reasoning: 'window holds',
          contract: spec.event.id,
        },
      },
      { actor: 'andrewjon', now: tick() },
    );
    const assigneePack = annex.orient('rune', clock);
    expect(assigneePack.contracts[0]?.rulings.map((r) => r.id)).toEqual([ruling.event.id]);
    // The ruling arrives WHOLE — a member who has to fetch the body to
    // learn what was ruled has not been re-oriented.
    expect(assigneePack.contracts[0]?.rulings[0]?.body).toEqual({
      ask: ask.event.id,
      decision: 'ship it',
      reasoning: 'window holds',
      contract: spec.event.id,
    });
    // A resolved ask leaves the authority's queue.
    expect(annex.orient('andrewjon', clock).asksForMe).toEqual([]);
  });
});
