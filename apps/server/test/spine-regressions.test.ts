/**
 * Regressions from the phase-1 verification round.
 *
 * Every case below is a thing that HAPPENED — reproduced against this
 * branch by an independent verifier before the fix landed — so each
 * gets the same treatment as an issue-#155 acceptance test: named after
 * the incident, driven through the real surface, and paired with the
 * nearest valid thing the fix must still accept.
 *
 * They live in one file on purpose. A regression folded into the suite
 * whose gap let it through reads as ordinary coverage; collected, they
 * are a record of what this design got wrong on the first pass, which
 * is the more useful thing to be able to re-read.
 *
 * Three of these were defects in code written specifically to prevent
 * the defect — the completion gate that let a superseded verdict
 * through, the supersession fold that retargeted, the refusal that
 * carried no delta. That is CONTRIBUTING's "the code you write to fix a
 * defect is the least-audited place that defect can hide", measured.
 */

import type {
  ListSpineEventsResponse,
  SpineContract,
  SpineCoverageGapDetail,
  SpineEvent,
  SpinePreconditionDetail,
  SpineStaleStateRevDetail,
} from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANDREWJON,
  authed,
  CORA,
  get,
  LEA,
  makeSpineApp,
  post,
  RUNE,
  type SpineApp,
} from './helpers/spine-app.js';

let app: SpineApp;

beforeEach(async () => {
  app = makeSpineApp().app;
  await post(app, '/spine/subjects', LEA, { id: 'repo:acme', type: 'repo' });
});

const observed = (value: string, at?: string) => ({
  subject: 'repo:acme',
  value,
  how: 'observed' as const,
  source: 'integration:github',
  ...(at !== undefined ? { at } : {}),
});
const asserted = (value: string) => ({
  subject: 'repo:acme',
  value,
  how: 'asserted' as const,
  source: 'member:rune',
});

async function contractOf(id: string): Promise<SpineContract> {
  return (await get(app, `/spine/contracts/${id}`, RUNE)).contract as SpineContract;
}

async function authorContract(
  criteria = [{ id: 'c1', text: 'the endpoint returns 200' }],
  opId = 'op-spec',
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await post(app, '/spine/events', LEA, {
    kind: 'specification',
    subject: 'repo:acme',
    opId,
    body: {
      title: 'Ship the endpoint',
      criteria,
      assignee: 'rune',
      verifier: 'lea',
      authority: 'andrewjon',
      ...extra,
    },
  });
  return (created.event as SpineEvent).id;
}

/** POST expecting a refusal; returns the parsed body after asserting the status. */
async function refused(
  token: string,
  body: unknown,
  status: number,
): Promise<{ code: string; error: string; detail?: unknown }> {
  const res = await app.request('/spine/events', authed(token, body));
  const json = (await res.json()) as { code: string; error: string; detail?: unknown };
  expect(res.status, `expected ${status}, got ${res.status}: ${JSON.stringify(json)}`).toBe(status);
  return json;
}

// ─────────────────────────────────────────────────────────────────────

describe('F1 — a completion cited a verdict the projection had already superseded', () => {
  /**
   * lea posted `met`, then `unmet` at the same revision. The completion
   * cited only the `met`. It landed: 201, contract done, while `orient`
   * went on reporting `unmet` to everyone looking at it.
   *
   * The gate read the caller's `cites` list and nothing else — and a
   * cite list is caller-supplied. The projection is the team's answer,
   * and now it is the gate's answer too.
   */
  async function twoVerdicts(): Promise<{ contract: string; met: string; unmet: string }> {
    const contract = await authorContract();
    const met = await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-v1',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    const unmet = await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-v2',
      expectedStateRev: 2,
      revision: observed('sha-a'),
      body: {
        contract,
        criterion: 'c1',
        decision: 'unmet',
        evidence: 'I re-ran it — the 200 only happens with the cache warm',
      },
    });
    return {
      contract,
      met: (met.event as SpineEvent).id,
      unmet: (unmet.event as SpineEvent).id,
    };
  }

  it('refuses the completion, and says the cited verdict was superseded', async () => {
    const { contract, met, unmet } = await twoVerdicts();
    const body = await refused(
      RUNE,
      {
        kind: 'lifecycle',
        opId: 'op-done',
        expectedStateRev: 3,
        revision: asserted('sha-a'),
        cites: [met],
        body: { contract, state: 'done', result: 'shipped' },
      },
      409,
    );
    expect(body.code).toBe('coverage_gap');
    const detail = body.detail as SpineCoverageGapDetail;
    expect(detail.missing.map((m) => m.criterion)).toEqual(['c1']);
    expect(detail.missing[0]?.why).toContain(unmet);
    expect(detail.missing[0]?.why).toContain('superseded');
    expect((await contractOf(contract)).state).toBe('active');
  });

  it('and the gate now agrees with what orient displays', async () => {
    const { unmet } = await twoVerdicts();
    // The property the incident broke: the gate and the display read
    // the same latest-wins projection, so they cannot disagree.
    const pack = (await get(app, '/spine/orient', LEA)) as {
      contracts: { criteria: { decision: string; event: string }[] }[];
    };
    expect(pack.contracts[0]?.criteria[0]?.decision).toBe('unmet');
    expect(pack.contracts[0]?.criteria[0]?.event).toBe(unmet);
  });

  it('accepts the completion once the current verdict is met and cited', async () => {
    // The positive control. Without it every assertion above passes
    // against a gate that refuses every completion.
    const { contract, unmet } = await twoVerdicts();
    const fixed = await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-v3',
      expectedStateRev: 3,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'cache-independent now' },
    });
    expect((fixed.event as SpineEvent).id).not.toBe(unmet);
    const done = await post(app, '/spine/events', RUNE, {
      kind: 'lifecycle',
      opId: 'op-done',
      expectedStateRev: 4,
      revision: asserted('sha-a'),
      cites: [(fixed.event as SpineEvent).id],
      body: { contract, state: 'done', result: 'shipped' },
    });
    expect((done.contract as SpineContract).state).toBe('done');
  });

  it('still accepts a waiver, which is a ruling over the CURRENT cannot_verify', async () => {
    // The other positive control: F1 tightened the gate, and the third
    // legal move after `cannot_verify` must still work.
    const contract = await authorContract();
    const cv = await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-cv',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: {
        contract,
        criterion: 'c1',
        decision: 'cannot_verify',
        evidence: 'no deploy access',
        why: 'the staging box is not mine to reach',
      },
    });
    const ask = await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      opId: 'op-ask',
      subject: 'repo:acme',
      body: {
        authority: 'andrewjon',
        question: 'waive c1?',
        context: 'lea cannot reach staging',
        unblocks: 'the release',
      },
    });
    const waiver = await post(app, '/spine/events', ANDREWJON, {
      kind: 'ruling',
      opId: 'op-waive',
      cites: [(cv.event as SpineEvent).id],
      body: { ask: (ask.event as SpineEvent).id, decision: 'waived', reasoning: 'acceptable' },
    });
    const done = await post(app, '/spine/events', RUNE, {
      kind: 'lifecycle',
      opId: 'op-done',
      expectedStateRev: 2,
      revision: asserted('sha-a'),
      cites: [(cv.event as SpineEvent).id, (waiver.event as SpineEvent).id],
      body: { contract, state: 'done', result: 'shipped with c1 waived' },
    });
    expect((done.contract as SpineContract).state).toBe('done');
  });
});

describe('F2 — a superseded event carrying a revision retargeted the contract it ended', () => {
  /**
   * `revision_id = COALESCE(?, revision_id)` ran on every lifecycle
   * state. Supersede while naming the new head and the old contract
   * silently moved to it: `stale` went false and verdicts reached at
   * the old revision were claimed for the new one. Exactly the silent
   * retargeting §10 forbids, in the fold written to prevent it.
   *
   * Acceptance 2 covers the supersession case end to end. These cover
   * the other four terminal-and-parked states, because closing one
   * state proves nothing about the rest.
   */
  it.each([
    ['cancelled', { state: 'cancelled', reason: 'deprioritised' }],
    ['parked', { state: 'parked', preemptedBy: 'the incident' }],
    ['waiting_on', { state: 'waiting_on', member: 'lea' }],
    ['waiting_for', { state: 'waiting_for', event: 'the docs merge', check: 'poll the docs repo' }],
  ])('does not let a %s event move the bound revision', async (_label, lifecycle) => {
    const contract = await authorContract();
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-attempt',
      expectedStateRev: 1,
      revision: asserted('sha-a'),
      body: { contract, summary: 'pushed at sha-a' },
    });
    await post(app, '/spine/events', CORA, {
      kind: 'observation',
      subject: 'repo:acme',
      revision: observed('sha-b'),
      body: { what: 'push webhook', output: 'main moved to sha-b' },
    });
    expect((await contractOf(contract)).stale).toBe(true);

    await post(app, '/spine/events', LEA, {
      kind: 'lifecycle',
      opId: 'op-lifecycle',
      expectedStateRev: 2,
      revision: observed('sha-b'),
      body: { contract, ...lifecycle },
    });

    const after = await contractOf(contract);
    expect(after.revision).toMatchObject({ value: 'sha-a' });
    // The observable the incident was about: retargeting cleared this.
    expect(after.stale).toBe(true);
  });

  it('still lets a completion bind the revision it completed at', async () => {
    // The positive control. `done(revision)` is the one state the
    // design says binds, and a fix that stopped every state from
    // binding would pass every assertion above.
    const contract = await authorContract([{ id: 'c1', text: 'ships' }], 'op-spec', {
      verifier: undefined,
    });
    const done = await post(app, '/spine/events', RUNE, {
      kind: 'lifecycle',
      opId: 'op-done',
      expectedStateRev: 1,
      revision: asserted('sha-a'),
      body: { contract, state: 'done', result: 'shipped' },
    });
    expect((done.contract as SpineContract).revision).toMatchObject({ value: 'sha-a' });
  });
});

describe('F3 — a stale write against a terminal contract was refused with no delta', () => {
  /**
   * Terminality was checked before the precondition, so the one case
   * where staleness is PROVEN rather than suspected was the one case
   * the caller got nothing back. §6: the refusal is the re-injection.
   *
   * The existing terminality test used a correct `expectedStateRev`, so
   * this combination was never crossed.
   */
  it('returns the events it missed, including the one that ended the contract', async () => {
    const contract = await authorContract();
    const verdict = await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'unmet', evidence: 'still 204' },
    });
    const cancelled = await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-cancel',
      expectedStateRev: 2,
      body: { contract, state: 'cancelled', reason: 'deprioritised' },
    });

    const body = await refused(
      RUNE,
      {
        kind: 'attempt',
        opId: 'op-attempt-late',
        expectedStateRev: 1,
        body: { contract, summary: 'still working on it' },
      },
      409,
    );
    expect(body.code).toBe('invalid_transition');
    const detail = body.detail as SpineStaleStateRevDetail;
    expect(detail.currentStateRev).toBe(3);
    // Both events, in order, in full — and the cancellation is the one
    // that explains why no retry will help.
    expect(detail.intervening.map((e) => e.id)).toEqual([
      (verdict.event as SpineEvent).id,
      (cancelled.event as SpineEvent).id,
    ]);
    expect(body.error).toContain('no retry against a newer counter will succeed');
  });

  it('refuses an up-to-date write to a terminal contract with an empty delta, not a wrong one', async () => {
    const contract = await authorContract();
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-cancel',
      expectedStateRev: 1,
      body: { contract, state: 'cancelled', reason: 'deprioritised' },
    });
    const body = await refused(
      RUNE,
      {
        kind: 'attempt',
        opId: 'op-attempt-late',
        expectedStateRev: 2,
        body: { contract, summary: 'carrying on' },
      },
      409,
    );
    // The caller is not behind, so there is genuinely nothing to hand
    // back. Fabricating a delta here would be the mirror of the defect.
    expect((body.detail as SpineStaleStateRevDetail).intervening).toEqual([]);
    expect(body.error).not.toContain('no retry against a newer counter will succeed');
  });
});

describe('F4 — one member replayed another member’s op_id and was told it worked', () => {
  /**
   * `op_id` identity omitted the actor, so an id was a bearer token for
   * somebody else's write. The worst shape is the structurally
   * forbidden one: rune is the assignee and may not post a verdict at
   * all, and replaying lea's got him `replayed: true` and lea's event.
   */
  async function leasVerdict(): Promise<{ contract: string; payload: Record<string, unknown> }> {
    const contract = await authorContract();
    const payload = {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    };
    await post(app, '/spine/events', LEA, payload);
    return { contract, payload };
  }

  it('refuses the assignee replaying the verifier’s verdict', async () => {
    const { payload } = await leasVerdict();
    const body = await refused(RUNE, { ...payload, expectedStateRev: 2 }, 409);
    expect(body.code).toBe('idempotency_conflict');
  });

  it('refuses an uninvolved member replaying it too', async () => {
    const { payload } = await leasVerdict();
    const body = await refused(CORA, { ...payload, expectedStateRev: 2 }, 409);
    expect(body.code).toBe('idempotency_conflict');
  });

  it('and appends nothing: the annex still holds exactly one verdict, lea’s', async () => {
    const { contract, payload } = await leasVerdict();
    await refused(RUNE, { ...payload, expectedStateRev: 2 }, 409);
    await refused(CORA, { ...payload, expectedStateRev: 2 }, 409);
    const verdicts = (
      (await get(
        app,
        `/spine/events?contract=${encodeURIComponent(contract)}&kind=criterion_verdict`,
        RUNE,
      )) as unknown as ListSpineEventsResponse
    ).events;
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.actor).toBe('lea');
  });

  it('still replays for the original actor', async () => {
    // The positive control: the fix must narrow idempotency to the
    // actor, not switch it off.
    const { payload } = await leasVerdict();
    const replay = await post(app, '/spine/events', LEA, payload, 200);
    expect(replay.replayed).toBe(true);
  });
});

describe('F5 — limit=0 answered “you have reached the head” to a caller who had read nothing', () => {
  it('400s a zero page size', async () => {
    await authorContract();
    const res = await app.request('/spine/events?limit=0', authed(RUNE));
    expect(res.status).toBe(400);
  });

  it('still serves the smallest real page, with a cursor', async () => {
    // The nearest valid thing. A fix that refused every small limit
    // would satisfy the assertion above.
    await authorContract();
    await post(app, '/spine/events', RUNE, {
      kind: 'discussion',
      body: { body: 'a second event so the page is not the whole stream' },
    });
    const page = (await get(
      app,
      '/spine/events?limit=1',
      RUNE,
    )) as unknown as ListSpineEventsResponse;
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toBe(1);
  });
});

describe('F6 — events named members who did not exist and were accepted with a 201', () => {
  it.each([
    [
      'waiting_on naming a non-member, which sits in nobody’s queue forever',
      async (contract: string) => ({
        token: RUNE,
        body: {
          kind: 'lifecycle',
          opId: 'op-wait',
          expectedStateRev: 1,
          body: { contract, state: 'waiting_on', member: 'nooneatall' },
        },
      }),
    ],
    [
      'testimony attributed to a non-member, which is hearsay with no source',
      async () => ({
        token: CORA,
        body: {
          kind: 'testimony',
          subject: 'repo:acme',
          body: { what: 'the handler is fixed', account: 'in standup', observer: 'nooneatall' },
        },
      }),
    ],
  ])('400s %s', async (_label, build) => {
    const contract = await authorContract();
    const { token, body } = await build(contract);
    const res = await app.request('/spine/events', authed(token, body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no such member: nooneatall' });
  });

  it('400s a redirect to a non-member, which drops the ask', async () => {
    const ask = await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      opId: 'op-ask',
      subject: 'repo:acme',
      body: {
        authority: 'andrewjon',
        question: 'may I?',
        context: 'because',
        unblocks: 'the work',
      },
    });
    const res = await app.request(
      '/spine/events',
      authed(ANDREWJON, {
        kind: 'ask_action',
        opId: 'op-redirect',
        body: {
          ask: (ask.event as SpineEvent).id,
          action: 'redirect',
          reason: 'not mine',
          redirectTo: 'nooneatall',
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no such member: nooneatall' });
    // …and the ask is untouched, still awaiting its authority.
    expect(
      ((await get(app, '/spine/orient', ANDREWJON)) as { asksForMe: unknown[] }).asksForMe,
    ).toHaveLength(1);
  });

  it('accepts every one of those naming a real member', async () => {
    // The positive control across all three fields at once: this is a
    // SPELLING check, and a fix that started refusing real members
    // would pass every assertion above.
    const contract = await authorContract();
    await post(app, '/spine/events', RUNE, {
      kind: 'lifecycle',
      opId: 'op-wait',
      expectedStateRev: 1,
      body: { contract, state: 'waiting_on', member: 'lea' },
    });
    await post(app, '/spine/events', CORA, {
      kind: 'testimony',
      subject: 'repo:acme',
      body: { what: 'the handler is fixed', account: 'in standup', observer: 'rune' },
    });
    const ask = await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      opId: 'op-ask',
      subject: 'repo:acme',
      body: { authority: 'andrewjon', question: 'may I?', context: 'x', unblocks: 'y' },
    });
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'ask_action',
      opId: 'op-redirect',
      body: {
        ask: (ask.event as SpineEvent).id,
        action: 'redirect',
        reason: 'lea owns this',
        redirectTo: 'lea',
      },
    });
  });
});

describe('F7 — stale was served with both of its operands opaque', () => {
  it('hydrates the bound revision and the head on a contract read', async () => {
    const contract = await authorContract();
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-attempt',
      expectedStateRev: 1,
      revision: asserted('sha-a'),
      body: { contract, summary: 'pushed' },
    });
    await post(app, '/spine/events', CORA, {
      kind: 'observation',
      subject: 'repo:acme',
      revision: observed('sha-b'),
      body: { what: 'push webhook', output: 'main moved' },
    });
    const one = await contractOf(contract);
    expect(one.stale).toBe(true);
    // Both operands, whole. `stale: true` beside two ids a member has
    // no route to resolve is a derived value rendering bare.
    expect(one.revision).toMatchObject({ value: 'sha-a', how: 'asserted', source: 'member:rune' });
    expect(one.head).toMatchObject({
      value: 'sha-b',
      how: 'observed',
      source: 'integration:github',
    });
    expect(typeof one.revision?.at).toBe('string');
  });

  it('hydrates the revision a verdict was reached at, in orient and in the list', async () => {
    const contract = await authorContract();
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green' },
    });
    const pack = (await get(app, '/spine/orient', LEA)) as {
      contracts: { criteria: { revision: { value: string; source: string } | null }[] }[];
    };
    expect(pack.contracts[0]?.criteria[0]?.revision).toMatchObject({
      value: 'sha-a',
      source: 'integration:github',
    });
    const listed = (await get(app, '/spine/contracts', CORA)) as { contracts: SpineContract[] };
    expect(listed.contracts[0]?.head).toMatchObject({ value: 'sha-a' });
  });
});

describe('F8 — one future-dated observation pinned the head permanently', () => {
  /**
   * The head was ordered by the caller-supplied `at`. A clock-skewed
   * integration, or a backfill naming a real historical instant,
   * therefore falsified staleness for the whole subject with no
   * correction path — nothing removes a revision.
   */
  it('orders the head by arrival, so a future-dated observation does not pin it', async () => {
    const contract = await authorContract();
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-attempt',
      expectedStateRev: 1,
      revision: asserted('sha-a'),
      body: { contract, summary: 'pushed' },
    });
    await post(app, '/spine/events', CORA, {
      kind: 'observation',
      subject: 'repo:acme',
      revision: observed('sha-skewed', '2099-01-01T00:00:00.000Z'),
      body: { what: 'a webhook from a box with a bad clock', output: 'sha-skewed' },
    });
    await post(app, '/spine/events', CORA, {
      kind: 'observation',
      subject: 'repo:acme',
      revision: observed('sha-real'),
      body: { what: 'the next real push', output: 'sha-real' },
    });
    // Arrival order, not caption order.
    expect((await contractOf(contract)).head).toMatchObject({ value: 'sha-real' });
  });

  it('keeps a backfilled past observation from becoming the head as well', async () => {
    // The other direction of the same defect: `at` in the past would
    // sort BEHIND, silently discarding a real later observation from
    // the head. Ordering by arrival answers both.
    const contract = await authorContract();
    await post(app, '/spine/events', CORA, {
      kind: 'observation',
      subject: 'repo:acme',
      revision: observed('sha-first'),
      body: { what: 'push', output: 'sha-first' },
    });
    await post(app, '/spine/events', CORA, {
      kind: 'observation',
      subject: 'repo:acme',
      revision: observed('sha-backfilled', '2020-01-01T00:00:00.000Z'),
      body: { what: 'a backfill of an old push', output: 'sha-backfilled' },
    });
    expect((await contractOf(contract)).head).toMatchObject({ value: 'sha-backfilled' });
    // …and the caption it was given is retained verbatim. Arrival is
    // the ordering; `at` is still evidence about the world.
    expect((await contractOf(contract)).head?.at).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('F9 — the coverage refusal carried a null revision with the value in scope', () => {
  it('carries the caption the completion was refused against', async () => {
    const contract = await authorContract([
      { id: 'c1', text: 'the endpoint returns 200' },
      { id: 'c2', text: 'the reference page documents it' },
    ]);
    const met = await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-v1',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green' },
    });
    const body = await refused(
      RUNE,
      {
        kind: 'lifecycle',
        opId: 'op-done',
        expectedStateRev: 2,
        revision: asserted('sha-a'),
        cites: [(met.event as SpineEvent).id],
        body: { contract, state: 'done', result: 'shipped' },
      },
      409,
    );
    const detail = body.detail as SpineCoverageGapDetail;
    // Whole, like every other revision on the wire.
    expect(detail.revision).toEqual({
      subject: 'repo:acme',
      value: 'sha-a',
      how: 'asserted',
      source: 'member:rune',
    });
  });

  it('is null only when the completion genuinely named no revision', async () => {
    const contract = await authorContract();
    const body = await refused(
      RUNE,
      {
        kind: 'lifecycle',
        opId: 'op-done',
        expectedStateRev: 1,
        body: { contract, state: 'done', result: 'shipped' },
      },
      409,
    );
    expect((body.detail as SpineCoverageGapDetail).revision).toBeNull();
  });
});

describe('F10 — a precondition ahead of the head was reported as staleness', () => {
  /**
   * `expectedStateRev: 99` against a contract at 1 produced
   * `stale_state_rev` with `intervening: []` and a message reading
   * "0 authoritative event(s) landed while you were away … they are in
   * the refusal in full". A caller cannot act on a contradiction.
   */
  it('refuses honestly, naming the counter the contract has never reached', async () => {
    const contract = await authorContract();
    const body = await refused(
      RUNE,
      {
        kind: 'attempt',
        opId: 'op-attempt',
        expectedStateRev: 99,
        body: { contract, summary: 'pushed' },
      },
      400,
    );
    expect(body.code).toBe('invalid_input');
    expect(body.error).toContain('ahead of contract');
    expect(body.error).not.toContain('in the refusal in full');
    const detail = body.detail as SpinePreconditionDetail;
    expect(detail).toMatchObject({
      contract,
      path: ['expectedStateRev'],
      problem: 'ahead',
      currentStateRev: 1,
      suppliedStateRev: 99,
    });
  });

  it('still reports a genuinely stale precondition as staleness, with its delta', async () => {
    // The positive control, and the discrimination that matters: below
    // the head is staleness, above it is not.
    const contract = await authorContract();
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-attempt',
      expectedStateRev: 1,
      body: { contract, summary: 'pushed' },
    });
    const body = await refused(
      RUNE,
      {
        kind: 'attempt',
        opId: 'op-attempt-2',
        expectedStateRev: 1,
        body: { contract, summary: 'pushed again' },
      },
      409,
    );
    expect(body.code).toBe('stale_state_rev');
    expect((body.detail as SpineStaleStateRevDetail).intervening).toHaveLength(1);
  });
});

describe('F11 — the runtime precondition refusal was unstructured, and said “a ask_action”', () => {
  /**
   * `ask` and `ruling` get a schema refinement for "names a contract ⇒
   * needs expectedStateRev", which produces a 400 with a path. The
   * kinds that bind indirectly cannot: the schema would have to look
   * the ask up. So the store refuses them — and it should hand back the
   * same structure, not only prose.
   */
  async function contractBoundAsk(): Promise<{ contract: string; ask: string }> {
    const contract = await authorContract();
    const ask = await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      opId: 'op-ask',
      subject: 'repo:acme',
      expectedStateRev: 1,
      body: {
        authority: 'andrewjon',
        question: 'ship?',
        context: 'tight window',
        unblocks: 'the release',
        contract,
      },
    });
    return { contract, ask: (ask.event as SpineEvent).id };
  }

  it('gives an ask_action the same structured detail the schema path produces', async () => {
    const { contract, ask } = await contractBoundAsk();
    const body = await refused(
      ANDREWJON,
      {
        kind: 'ask_action',
        opId: 'op-decline',
        body: { ask, action: 'decline', reason: 'not now' },
      },
      400,
    );
    expect(body.code).toBe('invalid_input');
    expect(body.detail).toMatchObject({
      contract,
      path: ['expectedStateRev'],
      problem: 'missing',
      currentStateRev: 2,
      suppliedStateRev: null,
    });
    // …and reads as a sentence. An agent is the consumer of this text.
    expect(body.error).toContain('an ask_action');
    expect(body.error).not.toContain('a ask_action');
  });

  it('accepts the same ask_action once it carries the precondition', async () => {
    const { ask } = await contractBoundAsk();
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'ask_action',
      opId: 'op-decline',
      expectedStateRev: 2,
      body: { ask, action: 'decline', reason: 'not now' },
    });
  });
});

describe('F12 — an amendment removed a criterion and nothing asked it to say so', () => {
  /**
   * §5's one stated amendment refusal — "removing text without a
   * disclosure" — was unimplemented. #155's finding 4 was "amendments
   * can't undo contamination": a criterion that quietly disappears
   * leaves everyone who read it working to a requirement the record no
   * longer admits existed.
   */
  const TWO = [
    { id: 'c1', text: 'the endpoint returns 200' },
    { id: 'c2', text: 'the reference page documents it' },
  ];

  const amend = (contract: string, body: Record<string, unknown>) => ({
    kind: 'amendment',
    opId: `op-amend-${JSON.stringify(body).length}`,
    expectedStateRev: 1,
    body: {
      contract,
      changes: 'see criteria',
      reason: 'the scope moved',
      disposition: 'scope_change',
      ...body,
    },
  });

  it('refuses a dropped criterion and names it', async () => {
    const contract = await authorContract(TWO);
    const body = await refused(LEA, amend(contract, { criteria: [TWO[0]] }), 400);
    expect(body.error).toContain("criterion 'c2'");
    expect(body.error).toContain('disclosure');
  });

  it('refuses a reworded criterion, a dropped constraint and a rewritten title', async () => {
    const withConstraints = await authorContract(TWO, 'op-spec-c', {
      constraints: ['do not touch the auth layer'],
    });
    const reworded = await refused(
      LEA,
      amend(withConstraints, {
        criteria: [TWO[0], { id: 'c2', text: 'the changelog mentions it' }],
      }),
      400,
    );
    expect(reworded.error).toContain("the wording of criterion 'c2'");

    const dropped = await refused(LEA, amend(withConstraints, { constraints: [] }), 400);
    expect(dropped.error).toContain('do not touch the auth layer');

    const retitled = await refused(LEA, amend(withConstraints, { title: 'Something else' }), 400);
    expect(retitled.error).toContain('Ship the endpoint');
  });

  it('lands the same removal when it carries a disclosure', async () => {
    const contract = await authorContract(TWO);
    const done = await post(
      app,
      '/spine/events',
      LEA,
      amend(contract, {
        criteria: [TWO[0]],
        disclosure:
          'c2 required the reference page and has been dropped; anyone who deferred work ' +
          'waiting on the docs team should stop waiting',
      }),
    );
    expect((done.contract as SpineContract).criteria).toEqual([TWO[0]]);
  });

  it('needs no disclosure to ADD, to APPEND, or to change nothing textual', async () => {
    // The positive controls, and the reason the rule is containment
    // rather than a length heuristic: the honest edits stay free, so
    // the disclosure means something when it does appear.
    const a = await authorContract(TWO, 'op-spec-a');
    await post(
      app,
      '/spine/events',
      LEA,
      amend(a, { criteria: [...TWO, { id: 'c3', text: 'and it is fast' }] }),
    );
    const b = await authorContract(TWO, 'op-spec-b');
    await post(
      app,
      '/spine/events',
      LEA,
      amend(b, {
        criteria: [TWO[0], { id: 'c2', text: 'the reference page documents it, with an example' }],
      }),
    );
    const c = await authorContract(TWO, 'op-spec-cc');
    await post(app, '/spine/events', LEA, amend(c, { constraints: ['a new constraint'] }));
  });
});

describe('T2 — op_id is required on authoritative kinds and refused on ambient ones, over HTTP', () => {
  /**
   * The typed union already says this, and `tsc` is not in the threat
   * model: the caller that matters is an untyped one posting JSON. The
   * boundary fixture and these fixtures cover different populations.
   */
  it('400s an authoritative event with no opId', async () => {
    const contract = await authorContract();
    const res = await app.request(
      '/spine/events',
      authed(RUNE, {
        kind: 'attempt',
        expectedStateRev: 1,
        body: { contract, summary: 'pushed' },
      }),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('opId');
  });

  it('400s an ambient event that carries one', async () => {
    const res = await app.request(
      '/spine/events',
      authed(RUNE, { kind: 'discussion', opId: 'op-nope', body: { body: 'a thought' } }),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('opId');
  });

  it('accepts each of them in the shape it is supposed to have', async () => {
    // Both positive controls: the pair of refusals above is satisfied
    // by a route that refuses every append.
    const contract = await authorContract();
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-attempt',
      expectedStateRev: 1,
      body: { contract, summary: 'pushed' },
    });
    await post(app, '/spine/events', RUNE, {
      kind: 'discussion',
      body: { body: 'a thought' },
    });
  });
});
