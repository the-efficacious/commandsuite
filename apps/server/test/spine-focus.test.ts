/**
 * The focus set (D9), at the store — membership as an annex event, the
 * projection folded from it, and the effective set the curator gates on.
 *
 * Nearly every rule here is a refusal (re-lighting what is lit, lighting
 * what is terminal, a probe curating focus), so each is paired with the
 * NEAREST VALID THING it must still accept, and the completeness claims
 * (the projection, the rebuild) assert the whole value rather than the
 * presence of one member of it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseSyncInstance, openDatabase } from '../src/db.js';
import { SpineError } from '../src/spine/index.js';
import { type AnnexWriter, createSqliteAnnexStore } from '../src/spine/store.js';

const T0 = Date.UTC(2026, 7, 9, 12, 0, 0);

let db: DatabaseSyncInstance;
let annex: AnnexWriter;
let clock = T0;

function tick(): number {
  clock += 1000;
  return clock;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  annex = createSqliteAnnexStore(db);
  clock = T0;
  annex.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea', tick());
});

/** A fresh contract at state_rev 1. `n` distinguishes the ids in one test. */
function authorContract(n = 0): string {
  return annex.append(
    {
      kind: 'specification',
      subject: 'repo:acme',
      opId: `op-spec-${n}-${clock}`,
      body: {
        title: `Ship the endpoint ${n}`,
        criteria: [{ id: 'c1', text: 'the endpoint returns 200' }],
        assignee: 'rune',
        verifier: 'lea',
        authority: 'andrewjon',
      },
    },
    { actor: 'lea', now: tick() },
  ).event.id;
}

function light(contract: string, expectedStateRev: number, actor = 'andrewjon') {
  return annex.append(
    {
      kind: 'focus',
      opId: `op-light-${contract}-${clock}`,
      expectedStateRev,
      body: { contract, lit: true, reason: 'this sprint' },
    },
    { actor, now: tick() },
  );
}

function unlight(contract: string, expectedStateRev: number, actor = 'andrewjon') {
  return annex.append(
    {
      kind: 'focus',
      opId: `op-unlight-${contract}-${clock}`,
      expectedStateRev,
      body: { contract, lit: false, reason: 'sprint over' },
    },
    { actor, now: tick() },
  );
}

function expectSpineError(fn: () => unknown, code: string): SpineError {
  try {
    fn();
  } catch (err) {
    expect(err, 'expected a SpineError').toBeInstanceOf(SpineError);
    const spineErr = err as SpineError;
    expect(spineErr.code, `expected ${code}, got ${spineErr.code}: ${spineErr.message}`).toBe(code);
    return spineErr;
  }
  throw new Error(`expected a ${code} SpineError, but the call returned`);
}

describe('lighting a contract into the focus set', () => {
  it('lands the event, flips the projection, and advances the counter', () => {
    const c = authorContract();
    // Before: not lit, not in the set.
    expect(annex.contract(c)?.inFocus).toBe(false);
    expect(annex.focusSet()).toEqual([]);

    const res = light(c, 1);
    expect(res.event.kind).toBe('focus');
    // The focus event is authoritative and contract-bound, so it bumps
    // the counter exactly like any other act on the contract.
    expect(res.contract?.stateRev).toBe(2);
    expect(res.contract?.inFocus).toBe(true);
    // The projection agrees, read back fresh.
    expect(annex.contract(c)?.inFocus).toBe(true);
    expect(annex.focusSet()).toEqual([c]);
  });

  it('leaves a DIFFERENT contract out of the set — membership is per contract', () => {
    const lit = authorContract(1);
    const dark = authorContract(2);
    light(lit, 1);
    expect(annex.focusSet()).toEqual([lit]);
    expect(annex.contract(dark)?.inFocus).toBe(false);
  });
});

describe('unlighting a contract', () => {
  it('flips the projection back and removes it from the effective set', () => {
    const c = authorContract();
    light(c, 1); // → state_rev 2
    unlight(c, 2); // → state_rev 3
    expect(annex.contract(c)?.inFocus).toBe(false);
    expect(annex.focusSet()).toEqual([]);
  });
});

describe('the focus projection is a SET — every event must flip it', () => {
  it('refuses re-lighting an already-lit contract, and still accepts unlighting it', () => {
    const c = authorContract();
    light(c, 1); // → state_rev 2
    // Re-light with a fresh op_id (a genuine second write, not a replay).
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'focus',
            opId: 'op-relight',
            expectedStateRev: 2,
            body: { contract: c, lit: true, reason: 'again' },
          },
          { actor: 'andrewjon', now: tick() },
        ),
      'invalid_transition',
    );
    // NEAREST VALID THING: the contract is still lit and can be unlit.
    expect(annex.contract(c)?.inFocus).toBe(true);
    const off = unlight(c, 2);
    expect(off.contract?.inFocus).toBe(false);
  });

  it('refuses unlighting a contract that is not in the set, and still accepts lighting it', () => {
    const c = authorContract();
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'focus',
            opId: 'op-unlight-unset',
            expectedStateRev: 1,
            body: { contract: c, lit: false, reason: 'never lit' },
          },
          { actor: 'andrewjon', now: tick() },
        ),
      'invalid_transition',
    );
    // NEAREST VALID THING: lighting the never-lit contract works.
    expect(light(c, 1).contract?.inFocus).toBe(true);
  });

  it('accepts re-lighting after an unlight — the round trip is legal', () => {
    const c = authorContract();
    light(c, 1); // rev 2
    unlight(c, 2); // rev 3
    const back = light(c, 3); // rev 4 — legal again, membership had flipped off
    expect(back.contract?.inFocus).toBe(true);
    expect(annex.focusSet()).toEqual([c]);
  });
});

describe('focus carries the annex precondition', () => {
  it('refuses a stale expectedStateRev and hands back the intervening delta', () => {
    const c = authorContract();
    light(c, 1); // → state_rev 2
    const err = expectSpineError(
      () =>
        annex.append(
          {
            kind: 'focus',
            opId: 'op-stale',
            expectedStateRev: 1, // behind — the light already moved it to 2
            body: { contract: c, lit: false, reason: 'stale write' },
          },
          { actor: 'andrewjon', now: tick() },
        ),
      'stale_state_rev',
    );
    // The refusal IS the re-injection: the light they missed rides in it.
    const detail = err.detail as { intervening: { kind: string }[] };
    expect(detail.intervening.map((e) => e.kind)).toEqual(['focus']);
  });

  it('replays a lost light idempotently — same op_id and payload, no second event', () => {
    const c = authorContract();
    const first = light(c, 1);
    const headAfter = annex.events({ limit: 500 }).headSeq;
    const replay = annex.append(
      {
        kind: 'focus',
        opId: first.event.opId as string,
        expectedStateRev: 1,
        body: { contract: c, lit: true, reason: 'this sprint' },
      },
      { actor: 'andrewjon', now: tick() },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.event.id).toBe(first.event.id);
    // Nothing was appended a second time, and the set is unchanged.
    expect(annex.events({ limit: 500 }).headSeq).toBe(headAfter);
    expect(annex.focusSet()).toEqual([c]);
  });
});

describe('who may curate focus, and on what', () => {
  it('refuses a probe — the system holds the camera; it does not curate', () => {
    const c = authorContract();
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'focus',
            opId: 'op-probe-focus',
            expectedStateRev: 1,
            authoredBy: 'lea',
            body: { contract: c, lit: true, reason: 'the probe decided' },
          },
          { actor: 'probe:check-1', now: tick() },
        ),
      'not_permitted',
    );
  });

  it('refuses lighting a terminal contract', () => {
    const c = authorContract();
    annex.append(
      {
        kind: 'lifecycle',
        opId: 'op-cancel',
        expectedStateRev: 1,
        body: { contract: c, state: 'cancelled', reason: 'dropped' },
      },
      { actor: 'andrewjon', now: tick() },
    );
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'focus',
            opId: 'op-light-dead',
            expectedStateRev: 2,
            body: { contract: c, lit: true, reason: 'too late' },
          },
          { actor: 'andrewjon', now: tick() },
        ),
      'invalid_transition',
    );
  });
});

describe('a lit contract that ends leaves the focus set on every surface', () => {
  /**
   * The blocker this pins, found in verification: a lit contract that
   * goes terminal can NEVER be unlit — every authoritative act on a
   * terminal contract is refused, `focus` included — so any surface that
   * reported raw membership held finished work on the allocator's plate
   * forever, with no act able to clear it. And completing lit work is
   * the PRESCRIBED way the set empties, so it was the normal path.
   *
   * The fix is one definition of "in focus" everywhere: lit AND
   * non-terminal. The raw decision survives in the event stream, which
   * is where the record lives.
   */
  it('drops out of focusSet, of inFocus, and of the ?focus=true predicate', () => {
    const c = authorContract();
    light(c, 1); // → state_rev 2, in the set
    expect(annex.focusSet()).toEqual([c]);
    expect(annex.contract(c)?.inFocus).toBe(true);

    annex.append(
      {
        kind: 'lifecycle',
        opId: 'op-cancel-lit',
        expectedStateRev: 2,
        body: { contract: c, state: 'cancelled', reason: 'preempted for good' },
      },
      { actor: 'andrewjon', now: tick() },
    );

    // All three surfaces agree, because they are one predicate.
    expect(annex.focusSet(), 'the curator gate').toEqual([]);
    expect(annex.contract(c)?.inFocus, 'the wire flag').toBe(false);
    expect(annex.contracts({ focus: true }), "the allocator's plate").toEqual([]);

    // And it cannot be cleared by hand — which is why the flag had to
    // stop reporting raw membership rather than the unlight being fixed.
    expectSpineError(
      () =>
        annex.append(
          {
            kind: 'focus',
            opId: 'op-unlight-terminal',
            expectedStateRev: 3,
            body: { contract: c, lit: false, reason: 'tidy up' },
          },
          { actor: 'andrewjon', now: tick() },
        ),
      'invalid_transition',
    );

    // RECORD-HONESTY: the decision to light it is still on the record,
    // in the events, which is what the record is made of. Attention
    // silence never costs a photograph.
    const focusEvents = annex.events({ kind: 'focus' }).events;
    expect(focusEvents.map((e) => (e.body as { lit: boolean }).lit)).toEqual([true]);
  });

  it('keeps a NON-terminal lit contract on the plate — the positive control', () => {
    const live = authorContract(1);
    const dead = authorContract(2);
    light(live, 1);
    light(dead, 1);
    annex.append(
      {
        kind: 'lifecycle',
        opId: 'op-done-dead',
        expectedStateRev: 2,
        body: { contract: dead, state: 'cancelled', reason: 'dropped' },
      },
      { actor: 'andrewjon', now: tick() },
    );
    // The narrowing removed the dead one and nothing else.
    expect(annex.focusSet()).toEqual([live]);
    expect(annex.contracts({ focus: true }).map((c) => c.id)).toEqual([live]);
    expect(annex.contract(live)?.inFocus).toBe(true);
  });
});

describe('raw membership, the other half of the pair', () => {
  /**
   * `focusSet()` is lit AND non-terminal; `focusMembership()` is lit,
   * full stop. The pair exists for one question the effective set cannot
   * answer — was this contract lit WHEN IT ENDED — and the curator asks
   * it of contracts that ended inside the window it is judging.
   *
   * Both halves are asserted, because a read that answered "lit" for
   * every row it found would satisfy the interesting case and be wrong
   * about the ordinary one.
   */
  it('reports a contract that ended while lit, and no contract that was unlit', () => {
    const ended = authorContract(1);
    const unlit = authorContract(2);
    const live = authorContract(3);
    const never = authorContract(4);
    light(ended, 1);
    light(unlit, 1);
    unlight(unlit, 2);
    light(live, 1);
    annex.append(
      {
        kind: 'lifecycle',
        opId: 'op-end-ended',
        expectedStateRev: 2,
        body: { contract: ended, state: 'cancelled', reason: 'the sprint took it' },
      },
      { actor: 'andrewjon', now: tick() },
    );

    // The one the effective set has already forgotten.
    expect(annex.focusSet(), 'the effective set drops what ended').toEqual([live]);
    expect(
      annex.focusMembership([ended, unlit, live, never]).sort(),
      'raw membership keeps the ended one and drops the unlit one',
    ).toEqual([ended, live].sort());

    // Scoped to the question asked, and an empty question is answerable.
    expect(annex.focusMembership([unlit, never])).toEqual([]);
    expect(annex.focusMembership([])).toEqual([]);
  });
});

describe('the focus projection rebuilds identically from the stream', () => {
  it('refolds to the same set, membership and contracts after a varied history', () => {
    const a = authorContract(1);
    const b = authorContract(2);
    const d = authorContract(3);
    light(a, 1);
    light(b, 1);
    unlight(a, 2); // a: lit then unlit
    light(a, 3); // a: lit again
    light(d, 1);
    // d goes terminal while lit — the interesting rebuild case.
    annex.append(
      {
        kind: 'lifecycle',
        opId: 'op-done-d',
        expectedStateRev: 2,
        body: { contract: d, state: 'cancelled', reason: 'dropped' },
      },
      { actor: 'andrewjon', now: tick() },
    );

    const setBefore = annex.focusSet();
    const membershipBefore = annex.focusMembership([a, b, d]);
    const contractsBefore = annex.contracts();
    // Not vacuous: the stream mixes lights, an unlight, a re-light, and
    // a terminal transition on a lit contract.
    expect(setBefore.sort()).toEqual([a, b].sort());

    annex.rebuildProjections();

    // Whole values, not spot fields — and BOTH readings of the
    // projection, since the fold is what makes the raw row survive the
    // terminal transition that removes d from the effective set.
    expect(annex.focusSet()).toEqual(setBefore);
    expect(annex.focusMembership([a, b, d])).toEqual(membershipBefore);
    expect(membershipBefore.sort(), 'and d is in it, having ended while lit').toEqual(
      [a, b, d].sort(),
    );
    expect(annex.contracts()).toEqual(contractsBefore);
  });
});

describe('the reason is required, and one character is a reason', () => {
  /**
   * `reason` is what makes membership AUTHORED rather than derived — it
   * is the sentence whoever reads the set later gets instead of guessing
   * why this was the push. So an empty one must be refused.
   *
   * And the nearest valid thing must still be accepted, which is the
   * half a refusal test cannot see: a check that rejects `''` is one
   * typo from a check that rejects everything, and a suite made only of
   * refusals passes happily against it.
   */
  it('refuses an empty reason and accepts a one-character one', () => {
    const c = authorContract();
    // Refused by the SCHEMA rather than the fold — the shape is the law
    // here, so it never reaches the store's own rules. Asserted on the
    // field it names, not on "it threw": a bare throw is satisfied by a
    // typo in the fixture just as happily as by the check under test.
    expect(() =>
      annex.append(
        {
          kind: 'focus',
          opId: 'op-empty-reason',
          expectedStateRev: 1,
          body: { contract: c, lit: true, reason: '' },
        },
        { actor: 'andrewjon', now: tick() },
      ),
    ).toThrow(/reason/);
    // NEAREST VALID THING: one character is a reason, and it lands whole.
    const on = annex.append(
      {
        kind: 'focus',
        opId: 'op-short-reason',
        expectedStateRev: 1,
        body: { contract: c, lit: true, reason: 'x' },
      },
      { actor: 'andrewjon', now: tick() },
    );
    expect(on.contract?.inFocus).toBe(true);
  });
});
