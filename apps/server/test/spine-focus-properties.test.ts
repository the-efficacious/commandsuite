/**
 * The phase-6 pinned properties, each driven end to end.
 *
 *   A. EVERY class-1 arm reaches its addressee on an OUT-OF-FOCUS
 *      contract, while class 2 on that same contract stays silent;
 *   B. out-of-focus is attention-silence, never record-absence;
 *   C. the running-dry edge survives a curator RESTART, in both
 *      directions — no spurious fire, and no missed one;
 *   D. the gate is inert while nothing is lit.
 *
 * ADOPTED FROM INDEPENDENT VERIFICATION, which wrote these against the
 * shipped code and found it correct in every case — and then found that
 * the deliverable pinned only ONE of the eight class-1 arms, two of the
 * four record-absence surfaces, and one of the two restart directions.
 * The code was right; the guards were not there. Gating class 1 on
 * focus, focus-filtering the queue or `annex_read`, and constructing the
 * curator as though the set were already empty are each a live mutation
 * that the suite could not see before these landed.
 *
 * They are kept as one file, in the verifier's structure, because what
 * makes them worth having is that they sweep a surface exhaustively
 * rather than sampling it.
 */

import type { Message, SpineContract, SpineEvent, SpineInjection } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCurator } from '../src/spine/index.js';
import {
  ANDREWJON,
  authed,
  CORA,
  type CuratorApp,
  get,
  LEA,
  makeCuratorApp,
  post,
  RUNE,
  T0,
} from './helpers/spine-curator-app.js';

let harness: CuratorApp;
let app: CuratorApp['app'];

beforeEach(async () => {
  harness = makeCuratorApp();
  app = harness.app;
  await post(app, '/spine/subjects', LEA, { id: 'repo:acme', type: 'repo' });
});

async function authorContract(opId: string, assignee = 'rune'): Promise<string> {
  const res = await post(app, '/spine/events', LEA, {
    kind: 'specification',
    subject: 'repo:acme',
    opId,
    body: {
      title: `Ship ${opId}`,
      criteria: [{ id: 'c1', text: 'the endpoint returns 200' }],
      assignee,
      verifier: 'lea',
      authority: 'andrewjon',
    },
  });
  return (res.event as SpineEvent).id;
}

async function rev(contract: string): Promise<number> {
  const one = (await get(app, `/spine/contracts/${contract}`, RUNE)).contract as SpineContract;
  return one.stateRev;
}

async function light(contract: string, opId: string): Promise<void> {
  await post(app, '/spine/events', ANDREWJON, {
    kind: 'focus',
    opId,
    expectedStateRev: await rev(contract),
    body: { contract, lit: true, reason: 'this sprint' },
  });
}

const observed = (value: string) => ({
  subject: 'repo:acme',
  value,
  how: 'observed' as const,
  source: 'integration:github',
  at: new Date(T0).toISOString(),
});

async function ledger(token: string): Promise<SpineInjection[]> {
  return (await get(app, '/spine/injections', token)).injections as SpineInjection[];
}
const addressed = (rows: SpineInjection[]) => rows.filter((r) => r.kind === 'addressed');
const deltas = (rows: SpineInjection[]) => rows.filter((r) => r.kind === 'subscription_delta');

/**
 * The world every class-1 case below runs in: contract A (the subject),
 * contract F (lit, so the focus filter is ACTIVE and A is out of it),
 * and cora subscribed to A at `all` — the class-2 control.
 */
async function outOfFocusWorld(): Promise<string> {
  const a = await authorContract('op-a');
  const f = await authorContract('op-f', 'cora');
  await app.request(
    '/spine/curator',
    authed(CORA, { subscription: { contract: a, level: 'all' } }, 'PUT'),
  );
  await light(f, 'op-light-f');
  // DRAIN THE SETUP WINDOW, and record what it legitimately owed. The
  // specs landed while nothing was lit, and membership is judged at
  // ARRIVAL, so those deltas are genuinely cora's — measuring from zero
  // would count the fixture's own setup as the act under test.
  await harness.curator.sweep();
  class2Baseline = deltas(await ledger(CORA)).length;
  // Not vacuous: the focus filter is genuinely on, and A is genuinely out.
  const one = (await get(app, `/spine/contracts/${a}`, RUNE)).contract as SpineContract;
  expect(one.inFocus, 'A must be OUT of focus for this to measure anything').toBe(false);
  return a;
}

/** Set by `outOfFocusWorld`: the class-2 traffic the SETUP owed cora. */
let class2Baseline = 0;

/**
 * After the act: cora, subscribed to A at `all`, heard nothing NEW about
 * it. Not "less" — nothing. Counted against the drained baseline, so the
 * measurement is the act and only the act.
 */
async function expectClass2Silent(_a: string): Promise<void> {
  await harness.curator.sweep();
  const rows = deltas(await ledger(CORA));
  expect(rows, 'no NEW class-2 delta on the out-of-focus contract').toHaveLength(class2Baseline);
}

describe('A — every class-1 arm is focus-independent', () => {
  it('ask: the named authority is reached out of focus', async () => {
    const a = await outOfFocusWorld();
    await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      opId: 'op-ask',
      expectedStateRev: await rev(a),
      body: {
        contract: a,
        authority: 'andrewjon',
        question: 'may I drop the legacy path?',
        context: 'it is unused',
        unblocks: 'the 0.6 cut',
      },
    });
    expect(addressed(await ledger(ANDREWJON)).length, 'the authority hears the ask').toBe(1);
    await expectClass2Silent(a);
  });

  it('criterion_verdict: the assignee is reached out of focus', async () => {
    const a = await outOfFocusWorld();
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-v',
      expectedStateRev: await rev(a),
      revision: observed('sha-a'),
      body: { contract: a, criterion: 'c1', decision: 'unmet', evidence: 'still 500ing' },
    });
    expect(addressed(await ledger(RUNE)).flatMap((r) => r.refs)).toContain(a);
    await expectClass2Silent(a);
  });

  it('ruling: the asker is reached out of focus', async () => {
    const a = await outOfFocusWorld();
    const ask = (
      await post(app, '/spine/events', RUNE, {
        kind: 'ask',
        opId: 'op-ask',
        expectedStateRev: await rev(a),
        body: {
          contract: a,
          authority: 'andrewjon',
          question: 'may I drop the legacy path?',
          context: 'it is unused',
          unblocks: 'the 0.6 cut',
        },
      })
    ).event as SpineEvent;
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'ruling',
      opId: 'op-rule',
      expectedStateRev: await rev(a),
      body: { ask: ask.id, contract: a, decision: 'yes, drop it', reasoning: 'nobody calls it' },
    });
    const runeLines = addressed(await ledger(RUNE));
    expect(runeLines.length, 'the asker hears the ruling out of focus').toBeGreaterThan(0);
    await expectClass2Silent(a);
  });

  it('proceeding: the authority is reached out of focus', async () => {
    const a = await outOfFocusWorld();
    const ask = (
      await post(app, '/spine/events', RUNE, {
        kind: 'ask',
        opId: 'op-ask',
        expectedStateRev: await rev(a),
        body: {
          contract: a,
          authority: 'andrewjon',
          question: 'may I drop the legacy path?',
          context: 'it is unused',
          unblocks: 'the 0.6 cut',
        },
      })
    ).event as SpineEvent;
    const before = addressed(await ledger(ANDREWJON)).length;
    await post(app, '/spine/events', RUNE, {
      kind: 'proceeding',
      opId: 'op-proceed',
      subject: 'repo:acme',
      expectedStateRev: await rev(a),
      body: { ask: ask.id, reason: 'shipping now, will revisit' },
    });
    expect(addressed(await ledger(ANDREWJON)).length).toBe(before + 1);
    await expectClass2Silent(a);
  });

  it('ask_action redirect: the redirect target is reached out of focus', async () => {
    const a = await outOfFocusWorld();
    const ask = (
      await post(app, '/spine/events', RUNE, {
        kind: 'ask',
        opId: 'op-ask',
        expectedStateRev: await rev(a),
        body: {
          contract: a,
          authority: 'andrewjon',
          question: 'may I drop the legacy path?',
          context: 'it is unused',
          unblocks: 'the 0.6 cut',
        },
      })
    ).event as SpineEvent;
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'ask_action',
      opId: 'op-redirect',
      subject: 'repo:acme',
      expectedStateRev: await rev(a),
      body: { ask: ask.id, action: 'redirect', redirectTo: 'lea', reason: 'lea owns this' },
    });
    expect(addressed(await ledger(LEA)).length, 'the redirect target hears it').toBeGreaterThan(0);
    await expectClass2Silent(a);
  });

  it('terminal lifecycle (done): assignee AND named verifier are reached out of focus', async () => {
    const a = await outOfFocusWorld();
    const verdict = (
      await post(app, '/spine/events', LEA, {
        kind: 'criterion_verdict',
        opId: 'op-vmet',
        expectedStateRev: await rev(a),
        revision: observed('sha-a'),
        body: { contract: a, criterion: 'c1', decision: 'met', evidence: '200 on #4412' },
      })
    ).event as SpineEvent;
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-done',
      expectedStateRev: await rev(a),
      revision: observed('sha-a'),
      cites: [verdict.id],
      body: { contract: a, state: 'done', result: 'shipped, verdict covers it' },
    });
    expect(
      addressed(await ledger(RUNE)).flatMap((r) => r.refs),
      'assignee',
    ).toContain(a);
    expect(
      addressed(await ledger(LEA)).flatMap((r) => r.refs),
      'named verifier',
    ).toContain(a);
    await expectClass2Silent(a);
  });

  it('parked lifecycle: assignee AND named verifier are reached out of focus', async () => {
    const a = await outOfFocusWorld();
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-park',
      expectedStateRev: await rev(a),
      body: { contract: a, state: 'parked', preemptedBy: 'the incident' },
    });
    expect(
      addressed(await ledger(RUNE)).flatMap((r) => r.refs),
      'assignee',
    ).toContain(a);
    expect(
      addressed(await ledger(LEA)).flatMap((r) => r.refs),
      'named verifier',
    ).toContain(a);
    await expectClass2Silent(a);
  });

  it('ask discharge (phase 4): asker AND authority are reached out of focus', async () => {
    const a = await outOfFocusWorld();
    const ask = (
      await post(app, '/spine/events', LEA, {
        kind: 'ask',
        opId: 'op-ask',
        expectedStateRev: await rev(a),
        body: {
          contract: a,
          authority: 'andrewjon',
          question: 'may I drop the legacy path?',
          context: 'it is unused',
          unblocks: 'the 0.6 cut',
        },
      })
    ).event as SpineEvent;
    const leaBefore = addressed(await ledger(LEA)).length;
    const ajBefore = addressed(await ledger(ANDREWJON)).length;
    // lea armed the check; the probe's observation staples to the ask.
    await harness.spine.appendAsProbe(
      {
        kind: 'observation',
        subject: 'repo:acme',
        staplesTo: ask.id,
        body: { what: 'the check lea armed fired', output: '{"ok":true}' },
      },
      { check: 'check-1', authoredBy: 'lea', now: T0 },
    );
    expect(addressed(await ledger(LEA)).length, 'the asker hears the discharge').toBe(
      leaBefore + 1,
    );
    expect(addressed(await ledger(ANDREWJON)).length, 'the authority hears it too').toBe(
      ajBefore + 1,
    );
    await expectClass2Silent(a);
  });
});

describe('B — out-of-focus is attention-silence, never record-absence', () => {
  it('keeps the contract in annex_read, the listing, the queue and orient', async () => {
    const a = await outOfFocusWorld();
    // Put A into rune's queue: waiting_on(rune).
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-wait',
      expectedStateRev: await rev(a),
      body: { contract: a, state: 'waiting_on', member: 'rune' },
    });

    // annex_read — the events of the out-of-focus contract are all there.
    const events = (await get(app, `/spine/events?contract=${a}`, CORA)).events as SpineEvent[];
    expect(events.length, 'the out-of-focus contract still has its whole stream').toBeGreaterThan(
      1,
    );
    expect(events.every((e) => e.contract === a)).toBe(true);

    // the unfiltered listing
    const all = (await get(app, '/spine/contracts', CORA)).contracts as SpineContract[];
    expect(
      all.map((c) => c.id),
      'the listing carries the out-of-focus contract',
    ).toContain(a);
    expect(all.find((c) => c.id === a)?.inFocus).toBe(false);

    // the owner's queue
    const queue = (await get(app, '/spine/queue?member=rune', RUNE)).queue as {
      waitingOn: SpineContract[];
    };
    expect(
      queue.waitingOn.map((c) => c.id),
      "the owner's queue still holds it",
    ).toContain(a);

    // orient — MARKED out of focus, never omitted
    const pack = (await get(app, '/spine/orient', RUNE)) as unknown as {
      contracts: { contract: string; inFocus: boolean }[];
    };
    const binding = pack.contracts.find((c) => c.contract === a);
    expect(binding, 'orient must not omit an out-of-focus binding').toBeDefined();
    expect(binding?.inFocus).toBe(false);
  });
});

describe('C — the running-dry edge survives a restart', () => {
  /** A second curator over the SAME stores: what a process restart builds. */
  function restart(phone?: (m: Message) => void) {
    return createCurator({
      annex: harness.spine.store,
      store: harness.curatorStore,
      broker: harness.broker,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => harness.clock.ms,
      ...(phone !== undefined ? { phonePush: phone } : {}),
      focusHolders: () =>
        harness.members
          .members()
          .filter((m) => m.permissions.includes('spine.focus'))
          .map((m) => m.name),
    });
  }

  it('a restart with an ALREADY-EMPTY set does not spuriously fire', async () => {
    const a = await authorContract('op-a');
    await light(a, 'op-light-a');
    await post(app, '/spine/events', RUNE, {
      kind: 'lifecycle',
      opId: 'op-cancel',
      expectedStateRev: await rev(a),
      body: { contract: a, state: 'cancelled', reason: 'dropped' },
    });
    const before = (await ledger(ANDREWJON)).filter((r) => r.kind === 'running_dry').length;
    expect(before, 'the live curator fired once').toBe(1);

    // Restart. The set is empty and stays empty; an unrelated lifecycle
    // must not re-fire. The fresh curator has its OWN phone spy, so what
    // IT did is separable from what the still-registered live curator did.
    const freshPhone = vi.fn<(m: Message) => void>();
    const fresh = restart(freshPhone);
    const b = await authorContract('op-b');
    await fresh.onAppend(
      await harness.spine.append(
        {
          kind: 'lifecycle',
          opId: 'op-cancel-b',
          expectedStateRev: 1,
          body: { contract: b, state: 'cancelled', reason: 'never lit' },
        },
        { actor: 'rune', now: harness.clock.ms },
      ),
    );
    expect(
      (await ledger(ANDREWJON)).filter((r) => r.kind === 'running_dry').length,
      'a restart over an already-empty set must not re-fire',
    ).toBe(before);
    expect(freshPhone, 'the restarted curator said nothing').not.toHaveBeenCalled();
  });

  it('a restart with a FULL set still fires when it later empties', async () => {
    const a = await authorContract('op-a');
    await light(a, 'op-light-a');
    // Restart while the set is {a} — the fresh curator must learn it is
    // non-empty, or the emptying edge is lost. Its own phone spy isolates
    // it from the live curator, which is still hooked on the write path.
    const freshPhone = vi.fn<(m: Message) => void>();
    const fresh = restart(freshPhone);
    const before = (await ledger(ANDREWJON)).filter((r) => r.kind === 'running_dry').length;
    expect(before, 'no running-dry line is owed before the set empties').toBe(0);
    await fresh.onAppend(
      await harness.spine.append(
        {
          kind: 'lifecycle',
          opId: 'op-cancel-a',
          expectedStateRev: await rev(a),
          body: { contract: a, state: 'cancelled', reason: 'dropped' },
        },
        { actor: 'rune', now: harness.clock.ms },
      ),
    );
    expect(
      freshPhone,
      'the restarted curator must still see the emptying edge and buzz the allocator',
    ).toHaveBeenCalledTimes(1);
    const buzzed = freshPhone.mock.calls[0]?.[0] as { to: string } | undefined;
    expect(buzzed?.to).toBe('andrewjon');
  });
});

describe('D — the gate is inert while nothing is lit', () => {
  it('flows class 2 on a contract nobody lit — phase-3 behaviour unchanged', async () => {
    const a = await authorContract('op-a');
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: a, level: 'all' } }, 'PUT'),
    );
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att',
      expectedStateRev: await rev(a),
      revision: observed('sha-a'),
      body: { contract: a, summary: 'poked at it' },
    });
    await harness.curator.sweep();
    expect(deltas(await ledger(CORA)).flatMap((r) => r.refs)).toContain(a);
  });
});
