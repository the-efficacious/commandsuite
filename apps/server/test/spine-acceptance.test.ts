/**
 * The acceptance tests from issue #155, phase-1 applicable ones.
 *
 * Each traces to a MEASURED INCIDENT on this team, not to a property
 * somebody thought would be nice:
 *
 *   1   Rune and Turner: a cancellation landed on top of a verdict
 *       nobody had read, and the verdict was lost.
 *   2   Lea and Rune: the subject moved under a contract and the
 *       contract silently retargeted, so verdicts reached at the old
 *       revision were quietly claimed for the new one.
 *   7   Cora and Turner: "this became false" had nowhere to live, so
 *       it lived in a reply nobody found.
 *   8   Seamus: recovery omitted the conversation, so a member who
 *       came back had the plate and none of the reasoning.
 *  10   AndrewJon: a lost response turned one completion into two.
 *
 * They drive HTTP and nothing else. THE OPAQUE-RUNNER PROPERTY: every
 * correctness test here passes against a runner that reveals nothing
 * about its context, because none of them reads anything but acts.
 */

import type {
  ListSpineEventsResponse,
  SpineContract,
  SpineCoverageGapDetail,
  SpineEvent,
  SpineStaleStateRevDetail,
} from 'csuite-sdk/types';
import { SPINE_EVENT_KINDS } from 'csuite-sdk/types';
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
  await post(app, '/spine/subjects', LEA, {
    id: 'file:acme/api.ts',
    type: 'file',
    parent: 'repo:acme',
  });
});

const observed = (value: string) => ({
  subject: 'repo:acme',
  value,
  how: 'observed' as const,
  source: 'integration:github',
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
    },
  });
  return (created.event as SpineEvent).id;
}

// ─────────────────────────────────────────────────────────────────────

describe('acceptance 1 — a cancellation that races a verdict conflicts, and is shown the verdict', () => {
  it('refuses the stale cancel and returns the verdict it raced, in full', async () => {
    const contract = await authorContract();
    // Everyone believes state_rev 1 at this point. rune attempts…
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-attempt',
      expectedStateRev: 1,
      revision: asserted('sha-a'),
      body: { contract, summary: 'pushed the fix' },
    });
    // …and lea's verdict lands while andrewjon is composing a cancel
    // against the state_rev they last read.
    const verdict = await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 2,
      revision: observed('sha-a'),
      body: {
        contract,
        criterion: 'c1',
        decision: 'met',
        evidence: 'the integration suite is green at sha-a',
      },
    });

    const res = await app.request(
      '/spine/events',
      authed(ANDREWJON, {
        kind: 'lifecycle',
        opId: 'op-cancel',
        expectedStateRev: 2,
        body: { contract, state: 'cancelled', reason: 'deprioritised' },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; detail: SpineStaleStateRevDetail };
    expect(body.code).toBe('stale_state_rev');

    // DISPLAYED, not referenced. The whole verdict is in the refusal —
    // its decision, its evidence, and the revision it was reached at —
    // because a cancel-or-not decision made from an event id is a
    // decision made from nothing.
    const shown = body.detail.intervening.find((e) => e.id === (verdict.event as SpineEvent).id);
    expect(shown, 'the raced verdict must be in the refusal').toBeDefined();
    expect(shown?.body).toEqual({
      contract,
      criterion: 'c1',
      decision: 'met',
      evidence: 'the integration suite is green at sha-a',
    });
    // WHOLE, here of all places. A stale refusal is the recovery
    // moment — there is no second call to resolve an id with — so the
    // raced verdict arrives saying which revision it was reached at
    // and who observed it, not `rev_01H…`.
    expect(shown?.revision).toEqual((verdict.event as SpineEvent).revision);
    expect(shown?.revision).toMatchObject({
      subject: 'repo:acme',
      value: 'sha-a',
      how: 'observed',
      source: 'integration:github',
    });
    expect(body.detail.currentStateRev).toBe(3);

    // …and the cancellation did NOT land.
    expect((await contractOf(contract)).state).toBe('active');
  });

  it('lets the same cancel through once the caller has read what it raced', async () => {
    const contract = await authorContract();
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green' },
    });
    // The positive control. Without it, everything above passes
    // against a store that refuses every cancellation.
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-cancel',
      expectedStateRev: 2,
      body: { contract, state: 'cancelled', reason: 'deprioritised, having read the verdict' },
    });
    const after = await contractOf(contract);
    expect(after.state).toBe('cancelled');
    expect(after.reason).toBe('deprioritised, having read the verdict');
  });
});

describe('acceptance 2 — the head moves, and supersession leaves the old contract terminal at its revision', () => {
  it('links a successor without retargeting the original, verdicts intact', async () => {
    const original = await authorContract();
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-attempt',
      expectedStateRev: 1,
      revision: asserted('sha-a'),
      body: { contract: original, summary: 'pushed at sha-a' },
    });
    const verdict = await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 2,
      revision: observed('sha-a'),
      body: { contract: original, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    const boundBefore = (await contractOf(original)).revision;
    expect(boundBefore).toMatchObject({ value: 'sha-a' });

    // The room moves under the contract.
    await post(app, '/spine/events', CORA, {
      kind: 'observation',
      subject: 'repo:acme',
      revision: observed('sha-b'),
      body: { what: 'push webhook on main', output: 'main is now sha-b' },
    });
    expect((await contractOf(original)).stale).toBe(true);

    // The ONLY legal path: a successor, authored, then linked. Prior
    // criteria travel as suggestions — the successor is authored, not
    // derived.
    const successor = await authorContract(
      [{ id: 'c1', text: 'the endpoint returns 200' }],
      'op-spec-successor',
    );
    // THE REVISION IS SUPPLIED ON PURPOSE. The original fixture omitted
    // this optional field, and that omission was the only reason the
    // test passed against a fold that applied `COALESCE(?, revision_id)`
    // to every lifecycle state — a superseded event carrying a revision
    // retargeted the contract it was terminating. The incident this
    // test is named after, committed by the code meant to prevent it.
    await post(app, '/spine/events', LEA, {
      kind: 'lifecycle',
      opId: 'op-supersede',
      expectedStateRev: 3,
      revision: observed('sha-b'),
      body: { contract: original, state: 'superseded', successor },
    });

    const after = await contractOf(original);
    expect(after.state).toBe('superseded');
    expect(after.successor).toBe(successor);
    // NEVER RETARGETED. The old journey stays where it stood: same
    // revision, same subject, same criteria. This is the assertion the
    // incident was about — a silent retarget would leave the contract
    // pointing at sha-b with verdicts reached at sha-a.
    expect(after.revision).toEqual(boundBefore);
    // …and still stale, because the world really did move. Retargeting
    // would have quietly cleared this and claimed the sha-a verdicts
    // for sha-b.
    expect(after.stale).toBe(true);
    expect(after.head).toMatchObject({ value: 'sha-b' });
    expect(after.subject).toBe('repo:acme');
    expect(after.criteria).toEqual([{ id: 'c1', text: 'the endpoint returns 200' }]);

    // Verdicts intact, still attached to the revision they were
    // reached at, and still visible to the member they bind.
    const pack = (await get(app, '/spine/orient', LEA)) as {
      contracts: {
        contract: string;
        criteria: { criterion: string; decision: string | null; revision: string | null }[];
      }[];
    };
    const oldPack = pack.contracts.find((c) => c.contract === original);
    expect(oldPack?.criteria).toEqual([
      {
        criterion: 'c1',
        text: 'the endpoint returns 200',
        decision: 'met',
        revision: {
          id: (verdict.event as SpineEvent).revision?.id,
          subject: 'repo:acme',
          value: 'sha-a',
          how: 'observed',
          source: 'integration:github',
          at: expect.any(String),
        },
        event: (verdict.event as SpineEvent).id,
        waivedBy: null,
        // The verdict was reached at sha-a and the contract is still
        // bound to sha-a — the supersession did not retarget it — so
        // the decision and the contract are talking about the same
        // state of the world.
        atBoundRevision: true,
      },
    ]);

    // And the successor is its own contract, at its own state.
    const next = await contractOf(successor);
    expect(next.state).toBe('active');
    expect(next.successor).toBeNull();
    expect(next.id).not.toBe(original);
  });

  it('refuses further work on the superseded contract but not on its successor', async () => {
    const original = await authorContract();
    const successor = await authorContract(
      [{ id: 'c1', text: 'the endpoint returns 200' }],
      'op-spec-successor',
    );
    await post(app, '/spine/events', LEA, {
      kind: 'lifecycle',
      opId: 'op-supersede',
      expectedStateRev: 1,
      body: { contract: original, state: 'superseded', successor },
    });
    const refused = await app.request(
      '/spine/events',
      authed(RUNE, {
        kind: 'attempt',
        opId: 'op-attempt-old',
        expectedStateRev: 2,
        body: { contract: original, summary: 'carrying on regardless' },
      }),
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('invalid_transition');
    // The nearest valid thing: the same attempt on the successor.
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-attempt-new',
      expectedStateRev: 1,
      body: { contract: successor, summary: 'carrying the work forward' },
    });
    expect((await contractOf(successor)).stateRev).toBe(2);
  });
});

describe('acceptance 7 — a correction stapled to a terminal event comes back prominently', () => {
  it('returns the correction on the contract stream, naming what it corrects', async () => {
    const contract = await authorContract();
    const cancelled = await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-cancel',
      expectedStateRev: 1,
      body: { contract, state: 'cancelled', reason: 'the customer withdrew' },
    });
    const cancelId = (cancelled.event as SpineEvent).id;

    const correction = await post(app, '/spine/events', ANDREWJON, {
      kind: 'correction',
      opId: 'op-correction',
      expectedStateRev: 2,
      staplesTo: cancelId,
      body: {
        correction:
          'the customer did not withdraw — their budget was reallocated and they expect this in Q4',
      },
    });

    const stream = (await get(
      app,
      `/spine/events?contract=${encodeURIComponent(contract)}`,
      RUNE,
    )) as unknown as ListSpineEventsResponse;

    // PROMINENT means "on the stream a reader of this contract already
    // reads", not "retrievable by a caller who thinks to ask". The
    // correction is the last thing on it and it names its target.
    const last = stream.events.at(-1);
    expect(last?.id).toBe((correction.event as SpineEvent).id);
    expect(last?.kind).toBe('correction');
    expect(last?.staplesTo).toBe(cancelId);

    // Name the string the deliverable must produce, then look for it
    // in what the consumer actually receives.
    expect(JSON.stringify(stream)).toContain('their budget was reallocated');

    // The corrected event is NOT rewritten. A photo seen cannot be
    // unseen, so the original reason is still exactly what it was.
    const original = stream.events.find((e) => e.id === cancelId);
    expect(original?.body).toEqual({
      contract,
      state: 'cancelled',
      reason: 'the customer withdrew',
    });
    // …and the contract is still terminal, still carrying the reason
    // it was cancelled for.
    const after = await contractOf(contract);
    expect(after.state).toBe('cancelled');
    expect(after.reason).toBe('the customer withdrew');
  });
});

describe('acceptance 8 — cursor recovery returns events of every kind, complete', () => {
  it('pages the whole stream, every kind present and every seq exactly once', async () => {
    // A stream carrying at least one of every kind in the registry.
    const contract = await authorContract([
      { id: 'c1', text: 'the endpoint returns 200' },
      { id: 'c2', text: 'the reference page documents it' },
    ]);
    const rev = async () => (await contractOf(contract)).stateRev;

    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-attempt',
      expectedStateRev: await rev(),
      revision: asserted('sha-a'),
      body: { contract, summary: 'pushed at sha-a' },
    });
    await post(app, '/spine/events', CORA, {
      kind: 'observation',
      subject: 'file:acme/api.ts',
      body: { what: 'read the handler', output: 'the status is hard-coded' },
    });
    await post(app, '/spine/events', CORA, {
      kind: 'testimony',
      subject: 'file:acme/api.ts',
      body: { what: 'rune says the handler is fixed', account: 'in standup', observer: 'rune' },
    });
    const chatter = await post(app, '/spine/events', RUNE, {
      kind: 'discussion',
      body: { body: 'the 204 was deliberate two years ago; worth recording', contract },
    });
    await post(app, '/spine/events', RUNE, {
      kind: 'promotion',
      opId: 'op-promotion',
      expectedStateRev: await rev(),
      cites: [(chatter.event as SpineEvent).id],
      body: { as: 'testimony', note: 'the history matters for the amendment' },
    });
    await post(app, '/spine/events', LEA, {
      kind: 'amendment',
      opId: 'op-amendment',
      expectedStateRev: await rev(),
      body: {
        contract,
        changes: 'c2 now names the reference page',
        reason: 'the original said "the docs", which nobody could check',
        disposition: 'correction',
        disclosure:
          'c2 previously read "the docs say so"; anyone who satisfied it by editing the ' +
          'changelog was working to a criterion this contract no longer states',
        criteria: [
          { id: 'c1', text: 'the endpoint returns 200' },
          { id: 'c2', text: 'the reference page documents it' },
        ],
      },
    });
    const verdict = await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: await rev(),
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    const ask = await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      opId: 'op-ask',
      subject: 'repo:acme',
      expectedStateRev: await rev(),
      body: {
        authority: 'andrewjon',
        question: 'ship c2 as a follow-up?',
        context: 'the reference page is owned by another team',
        unblocks: 'the 0.6 release',
        contract,
      },
    });
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'ruling',
      opId: 'op-ruling',
      expectedStateRev: await rev(),
      body: {
        ask: (ask.event as SpineEvent).id,
        decision: 'yes, follow-up',
        reasoning: 'the release matters more than the page',
        contract,
      },
    });
    const second = await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      opId: 'op-ask-2',
      subject: 'file:acme/api.ts',
      body: {
        authority: 'andrewjon',
        question: 'may I delete the legacy branch?',
        context: 'nothing has built from it in a year',
        unblocks: 'the cleanup',
      },
    });
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'ask_action',
      opId: 'op-ask-action',
      body: {
        ask: (second.event as SpineEvent).id,
        action: 'defer',
        reason: 'ask me after the release',
        trigger: '0.6 ships',
      },
    });
    const third = await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      opId: 'op-ask-3',
      subject: 'file:acme/api.ts',
      body: {
        authority: 'andrewjon',
        question: 'may I bump the dependency?',
        context: 'a CVE',
        unblocks: 'the fix',
      },
    });
    await post(app, '/spine/events', RUNE, {
      kind: 'proceeding',
      opId: 'op-proceeding',
      subject: 'file:acme/api.ts',
      body: {
        ask: (third.event as SpineEvent).id,
        reason: 'the CVE is exploitable today; proceeding and recording it',
      },
    });
    await post(app, '/spine/events', RUNE, {
      kind: 'lifecycle',
      opId: 'op-waiting',
      expectedStateRev: await rev(),
      body: {
        contract,
        state: 'waiting_for',
        event: 'the reference page merges',
        check: 'poll the docs repo for the page',
      },
    });
    await post(app, '/spine/events', LEA, {
      kind: 'correction',
      opId: 'op-correction',
      expectedStateRev: await rev(),
      staplesTo: (verdict.event as SpineEvent).id,
      body: { correction: 'the evidence link pointed at the wrong run; the right one is #4412' },
    });
    // Light it into the focus set (andrewjon holds `spine.focus`), so the
    // recovery stream carries a `focus` event like every other kind.
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'focus',
      opId: 'op-focus',
      expectedStateRev: await rev(),
      body: { contract, lit: true, reason: 'the 0.6 push is what we are on now' },
    });

    // ── Recovery: page from the beginning in small pages ──
    const head = (
      (await get(app, '/spine/events?limit=1', RUNE)) as unknown as ListSpineEventsResponse
    ).headSeq;
    const seen: SpineEvent[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = (await get(
        app,
        `/spine/events?since_seq=${cursor}&limit=3`,
        RUNE,
      )) as unknown as ListSpineEventsResponse;
      pages += 1;
      if (page.nextCursor !== null) {
        // The page-full property, asserted on the page rather than by
        // noticing an id is absent.
        expect(page.events, `page ${pages} was short while rows remained`).toHaveLength(3);
      }
      seen.push(...page.events);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      expect(pages, 'paging did not terminate').toBeLessThan(50);
    }

    // COMPLETE: every seq from 1 to the head, exactly once, in order.
    expect(seen.map((e) => e.seq)).toEqual(Array.from({ length: head }, (_, i) => i + 1));
    // EVERY KIND: the registry itself is the expectation, so a kind
    // added later and never recovered fails this without anybody
    // remembering to extend the list.
    expect([...new Set(seen.map((e) => e.kind))].sort()).toEqual([...SPINE_EVENT_KINDS].sort());
    // …and each event came back whole, not as a stub.
    for (const event of seen) {
      expect(event.body, `event ${event.id} came back with no body`).toBeTruthy();
      expect(typeof event.at).toBe('string');
      expect(event.actor.length).toBeGreaterThan(0);
    }
  });
});

describe('acceptance 10 — an idempotent completion retry produces exactly one event', () => {
  async function coveredCompletion(contract: string, result: string, opId = 'op-complete') {
    const stateRev = (await contractOf(contract)).stateRev;
    const verdicts = (
      (await get(
        app,
        `/spine/events?contract=${encodeURIComponent(contract)}&kind=criterion_verdict`,
        RUNE,
      )) as unknown as ListSpineEventsResponse
    ).events.map((e) => e.id);
    return {
      kind: 'lifecycle' as const,
      opId,
      expectedStateRev: stateRev,
      revision: asserted('sha-a'),
      cites: verdicts,
      body: { contract, state: 'done' as const, result },
    };
  }

  it('resolves both calls to the same event and appends nothing the second time', async () => {
    const contract = await authorContract();
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });

    const payload = await coveredCompletion(contract, 'shipped in 0.6');
    const first = await post(app, '/spine/events', RUNE, payload);
    // The lost-response retry: byte-identical payload, same op_id.
    // 200 rather than 201, because it created nothing.
    const second = await post(app, '/spine/events', RUNE, payload, 200);

    expect(second.replayed).toBe(true);
    expect((second.event as SpineEvent).id).toBe((first.event as SpineEvent).id);
    expect((second.event as SpineEvent).seq).toBe((first.event as SpineEvent).seq);
    expect((second.contract as SpineContract).state).toBe('done');

    // EXACTLY ONE, counted on the stream. Two completion events on one
    // contract is the defect; matching ids alone would not see a third
    // event appended alongside.
    const lifecycles = (
      (await get(
        app,
        `/spine/events?contract=${encodeURIComponent(contract)}&kind=lifecycle`,
        RUNE,
      )) as unknown as ListSpineEventsResponse
    ).events;
    expect(lifecycles).toHaveLength(1);
    // specification, verdict, completion — and nothing from the retry.
    expect((await contractOf(contract)).stateRev).toBe(3);
  });

  it('refuses the same op_id carrying a different result', async () => {
    const contract = await authorContract();
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    await post(app, '/spine/events', RUNE, await coveredCompletion(contract, 'shipped in 0.6'));

    const changed = await app.request(
      '/spine/events',
      authed(RUNE, {
        ...(await coveredCompletion(contract, 'shipped in 0.7, actually')),
        expectedStateRev: 2,
      }),
    );
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as { code: string }).code).toBe('idempotency_conflict');
    expect((await contractOf(contract)).result).toBe('shipped in 0.6');
  });

  it('still refuses an uncovered completion, retried or not', async () => {
    // The positive control's mirror: idempotency must not become a way
    // to make an illegal write legal by sending it twice.
    const contract = await authorContract([
      { id: 'c1', text: 'the endpoint returns 200' },
      { id: 'c2', text: 'the reference page documents it' },
    ]);
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    const payload = await coveredCompletion(contract, 'shipped');
    for (const attempt of [1, 2]) {
      const res = await app.request('/spine/events', authed(RUNE, payload));
      expect(res.status, `attempt ${attempt}`).toBe(409);
      const body = (await res.json()) as { code: string; detail: SpineCoverageGapDetail };
      expect(body.code).toBe('coverage_gap');
      expect(body.detail.missing.map((m) => m.criterion)).toEqual(['c2']);
    }
    expect((await contractOf(contract)).state).toBe('active');
  });
});
