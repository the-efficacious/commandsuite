/**
 * The curator honours the focus set (D9) — the hole phase 3 left open,
 * now closed: class-3 silence is parked ∪ waiting_for ∪ OUT-OF-FOCUS.
 *
 * THE LINE THAT MATTERS MOST, proven in both directions here: focus
 * gates class 2 (ambient subscription deltas) and NEVER class 1
 * (addressed). An ask naming you, a verdict on your contract, a terminal
 * lifecycle on your contract reach you even out of focus; only the
 * ambient traffic goes quiet. Each gate carries its positive control,
 * and the phase-3 nudge bound is re-run on an out-of-focus contract.
 *
 * Driven with ZERO floor signals, like the phase-3 suite — nothing here
 * posts one, so nothing here depends on one.
 */

import type { SpineContract, SpineEvent, SpineInjection } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AnnexStore, createCurator } from '../src/spine/index.js';
import {
  ANDREWJON,
  authed,
  CORA,
  type CuratorApp,
  get,
  injectionText,
  LEA,
  makeCuratorApp,
  post,
  RUNE,
  type Sink,
  T0,
} from './helpers/spine-curator-app.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

let harness: CuratorApp;
let app: CuratorApp['app'];
let sinks: Record<string, Sink>;

beforeEach(async () => {
  harness = makeCuratorApp();
  app = harness.app;
  sinks = {
    lea: harness.sinkFor('lea'),
    rune: harness.sinkFor('rune'),
    andrewjon: harness.sinkFor('andrewjon'),
    cora: harness.sinkFor('cora'),
  };
  await post(app, '/spine/subjects', LEA, { id: 'repo:acme', type: 'repo' });
});

/** rune assignee, lea verifier, andrewjon authority. `assignee` overridable. */
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

/** andrewjon holds spine.focus in the fixture; lea holds spine.author. */
async function light(contract: string, expectedStateRev: number, opId: string): Promise<void> {
  await post(app, '/spine/events', ANDREWJON, {
    kind: 'focus',
    opId,
    expectedStateRev,
    body: { contract, lit: true, reason: 'this sprint' },
  });
}

/** The counterpart to `light`, for cycling a contract's membership. */
async function unlight(contract: string, expectedStateRev: number, opId: string): Promise<void> {
  await post(app, '/spine/events', ANDREWJON, {
    kind: 'focus',
    opId,
    expectedStateRev,
    body: { contract, lit: false, reason: 'sprint over' },
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

const deltas = (rows: SpineInjection[]) => rows.filter((r) => r.kind === 'subscription_delta');

/** The contract's live `state_rev`, for acts that follow other acts. */
async function rev(contract: string): Promise<number> {
  const one = (await get(app, `/spine/contracts/${contract}`, RUNE)).contract as SpineContract;
  return one.stateRev;
}

/**
 * The line a class-2 batch RENDERED for one contract.
 *
 * The ledger row records refs and a count of injections, not what was in
 * them — and two events that share a tick share an injection. So the row
 * count cannot tell "the ending was delivered" from "the ending and
 * everything behind it were", and the rendered line, which is the only
 * thing a member ever actually reads, is where that difference lives.
 */
function deltaLine(sink: Sink, contract: string): string {
  const batches = sink.injections
    .map((m) => String(m.body))
    .filter((body) => body.startsWith('spine: changes on contracts you subscribe to.'));
  return (batches.at(-1) ?? '').split('\n').find((line) => line.includes(contract)) ?? '';
}

// ─────────────────────────────────────────────────────────────────────

describe('class 2 is gated by focus, class 1 is not — the pinned line', () => {
  it('silences a subscriber to an out-of-focus contract, and flows once it is lit', async () => {
    const a = await authorContract('op-a');
    const b = await authorContract('op-b');
    // cora subscribes to B at `all` — she would hear every authoritative
    // event on it, if focus let her.
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: b, level: 'all' } }, 'PUT'),
    );

    // Light A. The focus set is now {A}, so B is OUT OF FOCUS.
    await light(a, 1, 'op-light-a');

    // DRAIN THE SETUP WINDOW before measuring. The specs themselves are
    // authoritative events that landed while nothing was lit, so they are
    // legitimately owed (membership is judged at arrival) — counting them
    // as the measurement would confuse setup traffic with the act under
    // test.
    await harness.curator.sweep();
    const baseline = deltas(await ledger(CORA)).length;

    // An authoritative event on B — an attempt — which at `all` would
    // qualify for a class-2 delta.
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att-b',
      expectedStateRev: 1,
      revision: observed('sha-b1'),
      body: { contract: b, summary: 'poked at B' },
    });
    await harness.curator.sweep();

    // SILENT: B is out of focus, so cora gets no subscription delta about
    // it — not less, none.
    expect(deltas(await ledger(CORA))).toHaveLength(baseline);

    // POSITIVE CONTROL: light B too. The only thing that changed is B's
    // focus membership — same subscriber, same contract, same kind of
    // event — and now the delta flows.
    await light(b, 2, 'op-light-b');
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att-b2',
      expectedStateRev: 3,
      revision: observed('sha-b2'),
      body: { contract: b, summary: 'poked at B again' },
    });
    await harness.curator.sweep();

    const coraDeltas = deltas(await ledger(CORA));
    expect(coraDeltas.length).toBeGreaterThan(0);
    expect(coraDeltas.flatMap((d) => d.refs)).toContain(b);
  });

  it('delivers a class-1 line on an out-of-focus contract while its class-2 stays silent', async () => {
    const a = await authorContract('op-a');
    const b = await authorContract('op-b');
    // cora subscribes to A — the contract we are about to push out of
    // focus. She is the class-2 control: she must hear NOTHING.
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: a, level: 'all' } }, 'PUT'),
    );

    // Light B, so A is out of focus.
    await light(b, 1, 'op-light-b');

    // DRAIN THE SETUP WINDOW before measuring, for the same reason as the
    // test above: the specs are authoritative events that landed while
    // nothing was lit, so they are legitimately owed to a subscriber
    // (membership is judged at arrival). Measuring from zero would count
    // setup traffic as the act under test.
    await harness.curator.sweep();
    const baseline = deltas(await ledger(CORA)).length;
    const sinkBaseline = (sinks.cora?.injections ?? []).length;

    // A terminal lifecycle on A — cancellation — is a class-1 event: it
    // addresses the assignee (rune) and the named verifier (lea). It is
    // ALSO a class-2 event for A's subscribers. A is out of focus.
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-cancel-a',
      expectedStateRev: 1,
      body: { contract: a, state: 'cancelled', reason: 'preempted by the incident' },
    });
    await harness.curator.sweep();

    // CLASS 1 NOT GATED: rune (assignee) and lea (verifier) each get the
    // addressed line, out of focus and all — a contract ending under you
    // reaches you regardless of what is lit. Asserted on both the ledger
    // (structured refs) and the line the member actually reads.
    const runeAddressed = (await ledger(RUNE)).filter((r) => r.kind === 'addressed');
    expect(runeAddressed.flatMap((r) => r.refs)).toContain(a);
    expect(injectionText(sinks.rune as Sink)).toContain(a);
    const leaAddressed = (await ledger(LEA)).filter((r) => r.kind === 'addressed');
    expect(leaAddressed.flatMap((r) => r.refs)).toContain(a);

    // CLASS 2 GATED: cora, subscribed to A, hears nothing about it — A is
    // out of focus, so the ambient delta is silenced even though the same
    // event reached rune and lea as class 1. Nothing in her ledger and
    // nothing in the line she would have read.
    expect(deltas(await ledger(CORA))).toHaveLength(baseline);
    expect(sinks.cora?.injections ?? []).toHaveLength(sinkBaseline);
  });
});

describe('membership is evaluated AT ARRIVAL, not as of the sweep tick', () => {
  /**
   * Both cases found in verification, and both are the batching window
   * leaking into the semantics — the same defect `stateAtArrival` exists
   * to prevent for the parking lifecycle.
   */
  it('announces a contract LEAVING the focus set while others stay lit', async () => {
    const a = await authorContract('op-a');
    const b = await authorContract('op-b');
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: a, level: 'all' } }, 'PUT'),
    );
    await light(a, 1, 'op-light-a');
    await light(b, 1, 'op-light-b');
    await harness.curator.sweep();
    // ENTERING is announced — the control for the assertion below, and
    // proof the subscription itself works.
    const entering = deltas(await ledger(CORA));
    expect(
      entering.flatMap((r) => r.refs),
      'entering focus is announced',
    ).toContain(a);
    const before = entering.length;

    // Take A out. B stays lit, so the filter is still on and A is now
    // out of focus — which used to silence the very event saying so.
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'focus',
      opId: 'op-unlight-a',
      expectedStateRev: 2,
      body: { contract: a, lit: false, reason: 'sprint over' },
    });
    await harness.curator.sweep();
    const after = deltas(await ledger(CORA));
    expect(after.length, 'LEAVING the focus set is announced too').toBe(before + 1);
    expect(after.flatMap((r) => r.refs)).toContain(a);

    // …and everything AFTER it is silent, which is the other half of the
    // at-arrival rule: the event that moves the boundary lands, the ones
    // behind it do not.
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att-after',
      expectedStateRev: 3,
      revision: observed('sha-after'),
      body: { contract: a, summary: 'kept poking after it left the set' },
    });
    await harness.curator.sweep();
    expect(deltas(await ledger(CORA)), 'silent once it is out').toHaveLength(before + 1);
  });

  it('does not retroactively swallow an event that landed before anything was lit', async () => {
    const a = await authorContract('op-a');
    const b = await authorContract('op-b');
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: a, level: 'all' } }, 'PUT'),
    );
    // seq N — an attempt on A while NOTHING is lit: the filter is off,
    // so this is class-2 traffic cora is owed.
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract: a, summary: 'poked at A' },
    });
    // seq N+1, SAME TICK — B is lit, turning the filter on.
    await light(b, 1, 'op-light-b');
    await harness.curator.sweep();

    expect(
      deltas(await ledger(CORA)).flatMap((r) => r.refs),
      'an event that landed before the filter existed is still owed',
    ).toContain(a);
  });
});

describe('the nudge bound holds on an out-of-focus contract', () => {
  it('spends no nudge while out of focus, and one once it is lit — the F16 bound', async () => {
    // A binds rune; B binds cora, so rune's only lease is on A.
    const a = await authorContract('op-a', 'rune');
    const b = await authorContract('op-b', 'cora');

    // rune reads the pack: a lease on A, a receipt at the head.
    await get(app, '/spine/orient', RUNE);

    // Movement lands on A that rune never reads.
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-v',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract: a, criterion: 'c1', decision: 'unmet', evidence: 'still 500ing' },
    });

    // Light B — nothing rune is bound to — so A is out of focus.
    await light(b, 1, 'op-light-b');

    // Age rune's lease well past its TTL.
    harness.clock.ms = T0 + 2 * HOUR;

    // PHASE 1 — out of focus: no nudge, however many times we sweep. A
    // member is not nudged into oblivion about work the team has parked
    // attention on.
    await harness.curator.sweep();
    await harness.curator.sweep();
    expect((await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge')).toHaveLength(0);

    // PHASE 2 — positive control AND the bound. Light A: now it is in
    // focus, the unread verdict is owed again, and the nudge fires.
    await light(a, 2, 'op-light-a');
    await harness.curator.sweep();
    const first = (await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge');
    expect(first, 'in focus, the owed nudge lands').toHaveLength(1);
    expect(first[0]?.refs, 'and it names A').toContain(a);
    // The line rune reads is a pointer at `orient`, not the pack itself.
    expect(injectionText(sinks.rune as Sink)).toContain('orient');

    // THE BOUND: still one, across further sweeps inside the cadence
    // floor — focus silencing it earlier did not spend it, and lighting
    // it did not unspend the epoch cap.
    for (let i = 1; i <= 5; i++) {
      harness.clock.ms = T0 + 2 * HOUR + i * MINUTE;
      await harness.curator.sweep();
    }
    expect((await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge')).toHaveLength(1);

    // Still unread, so the silence was the gate working and not rune
    // having caught up.
    const head = ((await get(app, '/spine/events', ANDREWJON)) as { headSeq: number }).headSeq;
    expect(harness.curatorStore.receipt('rune')?.seq).toBeLessThan(head);
  });
});

describe('every arm of the at-arrival rule, driven on its own', () => {
  /**
   * ADOPTED FROM INDEPENDENT VERIFICATION, which found the rule landed
   * with the suite unable to see three of its four arms. Every other
   * fixture in this file sweeps after each act, so the window is one
   * event and the roll-forward never runs at all; and the "a focus event
   * is never silenced by the membership it changes" exemption only bites
   * when a DARK contract is lit while another is already lit, which
   * nothing drove. Deleting each of those arms left the whole suite
   * green.
   *
   * Two of the three read the rendered line rather than the ledger, for
   * the reason `deltaLine` gives: events that share a tick share an
   * injection, so a row count cannot see inside the batch.
   */

  it('delivers the LIGHT of a dark contract while another is already lit', async () => {
    const a = await authorContract('op-a');
    const b = await authorContract('op-b');
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: a, level: 'all' } }, 'PUT'),
    );
    // B is lit in an EARLIER tick, so the filter is already on and A is
    // genuinely dark when its own lighting arrives. This is the entering
    // direction, and it is the one the exemption exists for: without it,
    // the event announcing that a contract joined the team's push is
    // silenced by the fact that it had not joined it yet.
    await light(b, 1, 'op-light-b');
    await harness.curator.sweep();
    const before = deltas(await ledger(CORA)).length;
    expect(
      ((await get(app, `/spine/contracts/${a}`, RUNE)).contract as SpineContract).inFocus,
      'A must be dark for this to measure the entering direction',
    ).toBe(false);

    await light(a, 1, 'op-light-a');
    await harness.curator.sweep();

    const after = deltas(await ledger(CORA));
    expect(after.length, 'entering the focus set is news').toBe(before + 1);
    expect(after.at(-1)?.refs).toContain(a);
    expect(deltaLine(sinks.cora as Sink, a), 'and the line says what happened').toContain(
      '1 event(s): focus',
    );
  });

  it('binds everything behind a membership change, in the SAME tick', async () => {
    // The roll-forward, in both directions. Every other fixture sweeps
    // between the change and what follows it, so the set is rebuilt from
    // scratch and the roll-forward never has to work; here the change and
    // the event obeying it share a window.
    const a = await authorContract('op-a');
    const b = await authorContract('op-b');
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: a, level: 'all' } }, 'PUT'),
    );
    await light(b, await rev(b), 'op-light-b');
    await harness.curator.sweep();
    const before = deltas(await ledger(CORA)).length;

    // ENTERING: A is lit and then acted on, one tick. The attempt lands
    // after A joined the push, so it is owed — a set frozen at the start
    // of the window would still have A dark and swallow it.
    await light(a, await rev(a), 'op-light-a');
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att-lit',
      expectedStateRev: await rev(a),
      revision: observed('sha-lit'),
      body: { contract: a, summary: 'poked at A once it was lit' },
    });
    await harness.curator.sweep();
    expect(deltas(await ledger(CORA)).length, 'one batch for the tick').toBe(before + 1);
    expect(deltaLine(sinks.cora as Sink, a), 'the light AND the attempt behind it').toContain(
      '2 event(s): focus, attempt',
    );

    // LEAVING: A is unlit and then acted on, one tick. Now the attempt
    // lands after A left, so it is silent — and the unlight itself still
    // is not.
    await unlight(a, await rev(a), 'op-unlight-a');
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att-unlit',
      expectedStateRev: await rev(a),
      revision: observed('sha-unlit'),
      body: { contract: a, summary: 'kept poking after it left' },
    });
    await harness.curator.sweep();
    expect(deltas(await ledger(CORA)).length, 'one more batch').toBe(before + 2);
    const leaving = deltaLine(sinks.cora as Sink, a);
    expect(leaving, 'the unlight is news').toContain('1 event(s): focus');
    expect(leaving, 'and the attempt behind it is not').not.toContain('attempt');
  });

  it('is silent on a contract that ENDED before the window, lit row and all', async () => {
    const a = await authorContract('op-a');
    const b = await authorContract('op-b');
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: a, level: 'all' } }, 'PUT'),
    );
    await light(a, await rev(a), 'op-light-a');
    await light(b, await rev(b), 'op-light-b');
    await harness.curator.sweep();

    // A ends WHILE LIT — and can never be unlit, because every
    // authoritative act on a terminal contract is refused. Its membership
    // row therefore reads lit for good, which is exactly the trap: raw
    // membership would keep A on the plate forever, and everything that
    // lands on it afterwards would flow as though the team were still
    // travelling there. B stays lit, so the filter stays on.
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-cancel-a',
      expectedStateRev: await rev(a),
      body: { contract: a, state: 'cancelled', reason: 'dropped' },
    });
    await harness.curator.sweep();
    const before = deltas(await ledger(CORA)).length;

    // A correction is the only authoritative act a terminal contract
    // still takes, and it lands a whole tick after the ending, so nothing
    // in this window can put A back on the plate.
    await post(app, '/spine/events', LEA, {
      kind: 'correction',
      opId: 'op-corr',
      subject: 'repo:acme',
      staplesTo: a,
      expectedStateRev: await rev(a),
      body: { correction: 'the reason named the wrong incident' },
    });
    await harness.curator.sweep();
    expect(
      deltas(await ledger(CORA)),
      'a contract that ended before the window was not on the plate during it',
    ).toHaveLength(before);
  });

  it('delivers the ENDING and nothing behind it, inside one tick', async () => {
    const a = await authorContract('op-a');
    const b = await authorContract('op-b');
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: a, level: 'all' } }, 'PUT'),
    );
    await light(a, await rev(a), 'op-light-a');
    await light(b, await rev(b), 'op-light-b');
    await harness.curator.sweep();
    const before = deltas(await ledger(CORA)).length;

    // ONE tick: A ends, then a correction lands on it. A was on the plate
    // when the ending arrived — so the ending is owed — and off it by the
    // time the correction did. Both are cora's at level `all`, both batch
    // into a single injection, and the count in that line is the only
    // place the difference between "one of them" and "both" appears.
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-cancel-a',
      expectedStateRev: await rev(a),
      body: { contract: a, state: 'cancelled', reason: 'dropped' },
    });
    await post(app, '/spine/events', LEA, {
      kind: 'correction',
      opId: 'op-corr',
      subject: 'repo:acme',
      staplesTo: a,
      expectedStateRev: await rev(a),
      body: { correction: 'the reason named the wrong incident' },
    });
    await harness.curator.sweep();

    expect(deltas(await ledger(CORA)).length, 'one batch, because one tick').toBe(before + 1);
    const line = deltaLine(sinks.cora as Sink, a);
    expect(line, 'the ending is delivered').toContain('1 event(s): lifecycle');
    expect(line, 'and the correction behind it is not').not.toContain('correction');
  });
});

describe('the membership read is a function of the window, not of the history', () => {
  /**
   * The read this replaces reconstructed membership by walking the focus
   * stream from seq 0 on EVERY tick, and stopped at a ceiling of 20
   * pages × 500. Past it the team's membership froze mid-history —
   * silently, in the OVER-silencing direction, with no later tick able to
   * recover, because every tick restarted from the same cursor and hit
   * the same wall. It is gone: membership is read off the projection the
   * store already maintains and undone back to the window's start, so
   * there is no scan to truncate and no depth at which the answer
   * changes.
   *
   * Two claims, because either one alone passes something broken: the
   * answer is still RIGHT after a long history (a read that returned
   * nothing would also be cheap), and the tick is still CHEAP (a read
   * that replayed history would also be right, until its ceiling).
   */

  it('answers both directions after a history longer than one page', async () => {
    // `lit` stays lit throughout, so any stale prefix of this history is
    // NON-EMPTY and does not contain A — the shape that silences a lit
    // contract rather than the one that lets an unlit one through.
    const lit = await authorContract('op-lit');
    const churn = await authorContract('op-churn');
    const a = await authorContract('op-a');
    const dark = await authorContract('op-dark');
    await light(lit, await rev(lit), 'op-light-lit');

    let churnRev = 1;
    for (let i = 0; i < 260; i++) {
      await light(churn, churnRev++, `op-churn-on-${i}`);
      await unlight(churn, churnRev++, `op-churn-off-${i}`);
    }
    // Past 520 focus events, and only now is A lit.
    await light(a, await rev(a), 'op-light-a');
    for (const contract of [a, dark]) {
      await app.request(
        '/spine/curator',
        authed(CORA, { subscription: { contract, level: 'all' } }, 'PUT'),
      );
    }
    await harness.curator.sweep();
    const before = deltas(await ledger(CORA)).length;

    // A is lit past the depth, so its traffic FLOWS. This is the
    // direction a frozen prefix gets wrong, and it is the expensive one:
    // the contract the team is actually travelling to goes quiet.
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att-a',
      expectedStateRev: await rev(a),
      revision: observed('sha-a'),
      body: { contract: a, summary: 'poked at A' },
    });
    await harness.curator.sweep();
    const flowed = deltas(await ledger(CORA));
    expect(flowed.length, 'a contract lit past the depth is still lit').toBe(before + 1);
    expect(flowed.at(-1)?.refs).toContain(a);

    // And `dark`, never lit, is still silent — so the read is not simply
    // letting everything through.
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att-dark',
      expectedStateRev: await rev(dark),
      revision: observed('sha-dark'),
      body: { contract: dark, summary: 'poked at the dark one' },
    });
    await harness.curator.sweep();
    expect(deltas(await ledger(CORA)), 'a contract nobody lit is still out of focus').toHaveLength(
      flowed.length,
    );
  });

  it('undoes an unswept region deeper than one page', async () => {
    // The read has no ceiling, and this is what that buys. Everything
    // here lands in ONE window — no sweep until the end — so the region
    // the undo has to walk is 520+ focus events long. A read that
    // stopped at a page would undo the oldest 500 and leave A's lighting
    // standing, which puts a contract in the set that was NOT in it when
    // the window opened, and silences everything early in the window
    // that is not A.
    const b = await authorContract('op-b');
    const churn = await authorContract('op-churn');
    const a = await authorContract('op-a');
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: b, level: 'all' } }, 'PUT'),
    );

    // The attempt on B lands FIRST, while nothing is lit — so the filter
    // is off and it is owed.
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att-b',
      expectedStateRev: await rev(b),
      revision: observed('sha-b'),
      body: { contract: b, summary: 'poked at B before anything was lit' },
    });
    // 520 focus events that resolve to nothing — churn ends unlit, so a
    // read that reaches its first event gets the same answer a complete
    // one does. They are here to push what follows past the page.
    let churnRev = 1;
    for (let i = 0; i < 260; i++) {
      await light(churn, churnRev++, `op-churn-on-${i}`);
      await unlight(churn, churnRev++, `op-churn-off-${i}`);
    }
    // Focus event 521, and the only one whose undo changes the answer.
    await light(a, await rev(a), 'op-light-a');

    // ONE sweep over the whole thing.
    await harness.curator.sweep();
    expect(
      deltas(await ledger(CORA)).flatMap((d) => d.refs),
      'nothing was lit when the attempt landed, however deep the region got',
    ).toContain(b);
  });

  it('undoes a window that lit AND unlit the same contract', async () => {
    // The undo walks the window's focus events NEWEST-FIRST, so the
    // oldest one has the last word — it is the one that describes the
    // moment the window began. Walk them oldest-first instead and a
    // contract flipped twice in a tick lands on the wrong answer, which
    // the roll-forward then quietly corrects at the first focus event —
    // so the only place it shows is an event that arrived BEFORE it.
    const a = await authorContract('op-a');
    const b = await authorContract('op-b');
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: a, level: 'all' } }, 'PUT'),
    );
    await light(b, await rev(b), 'op-light-b');
    await harness.curator.sweep();
    const before = deltas(await ledger(CORA)).length;

    // ONE tick, in this order: an attempt on A while A is dark, then A
    // lit, then A unlit again. At the window's start A was NOT in the
    // set, so the attempt is silenced and only the two focus events are
    // owed.
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att-a',
      expectedStateRev: await rev(a),
      revision: observed('sha-a'),
      body: { contract: a, summary: 'poked at A while it was dark' },
    });
    await light(a, await rev(a), 'op-light-a');
    await unlight(a, await rev(a), 'op-unlight-a');
    await harness.curator.sweep();

    expect(deltas(await ledger(CORA)).length, 'one batch, because one tick').toBe(before + 1);
    const line = deltaLine(sinks.cora as Sink, a);
    expect(line, 'both flips are news, and only them').toContain('2 event(s): focus');
    expect(line, 'the attempt landed while A was dark').not.toContain('attempt');
  });

  it('reads none of the focus history on an ordinary tick', async () => {
    // A counting annex over the real one. Only TEAM-WIDE kind-scoped
    // reads are counted — the ones that grow with how long the team has
    // curated. `stateBefore`'s page is scoped to a single contract and is
    // a different question, so it is deliberately not counted here.
    let historyRows = 0;
    let membershipAsked = 0;
    const counting: AnnexStore = {
      ...harness.annex,
      events: (query = {}) => {
        const result = harness.annex.events(query);
        if (query.kind !== undefined && query.contract === undefined) {
          historyRows += result.events.length;
        }
        return result;
      },
      focusMembership: (ids) => {
        membershipAsked += ids.length;
        return harness.annex.focusMembership(ids);
      },
    };

    // A team that has curated a lot AND finished a lot while lit. The
    // finished ones matter: their membership rows still read lit and
    // accumulate one per contract, forever, so a seed built from all of
    // them would put the team's whole history back into every tick by
    // another route.
    const churn = await authorContract('op-churn');
    let churnRev = 1;
    for (let i = 0; i < 260; i++) {
      await light(churn, churnRev++, `op-churn-on-${i}`);
      await unlight(churn, churnRev++, `op-churn-off-${i}`);
    }
    for (let i = 0; i < 12; i++) {
      const done = await authorContract(`op-done-${i}`);
      await light(done, await rev(done), `op-light-done-${i}`);
      await post(app, '/spine/events', ANDREWJON, {
        kind: 'lifecycle',
        opId: `op-end-done-${i}`,
        expectedStateRev: await rev(done),
        body: { contract: done, state: 'cancelled', reason: 'sprint over' },
      });
    }
    const a = await authorContract('op-a');
    await light(a, await rev(a), 'op-light-a');
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: a, level: 'all' } }, 'PUT'),
    );

    // Constructed AFTER the history, so its cursor starts at the head —
    // a curator that is caught up, which is the steady state every tick
    // but the first runs in.
    const caughtUp = createCurator({
      annex: counting,
      store: harness.curatorStore,
      broker: harness.broker,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => harness.clock.ms,
    });
    const before = deltas(await ledger(CORA)).length;

    // One ordinary event, carrying no membership change of its own.
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att-a',
      expectedStateRev: await rev(a),
      revision: observed('sha-a'),
      body: { contract: a, summary: 'poked at A' },
    });
    await caughtUp.sweep();

    // Not vacuous: the tick did the work, against a set it got right.
    expect(deltas(await ledger(CORA)).length, 'the tick delivered what it owed').toBe(before + 1);
    expect(historyRows, 'a tick reads no team-wide focus or lifecycle history').toBe(0);
    expect(membershipAsked, 'and asks after no lit-but-finished contract').toBe(0);
  });
});
