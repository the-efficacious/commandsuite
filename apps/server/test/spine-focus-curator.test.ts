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

import type { SpineEvent, SpineInjection } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
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

describe('the membership read is not truncated by a page', () => {
  /**
   * `events()` walks seq ASC from the beginning, so reading focus history
   * with a single page returns the OLDEST events. A team that has curated
   * more than a page's worth would have had its silence computed against
   * membership frozen at its first sprints — the "short page while live
   * rows existed" defect this repository names, in the one read where
   * being wrong is silent.
   *
   * The state under test is only reachable past the page size, so this
   * fixture pays for the events rather than shrinking the constant: a
   * smaller page in the test would be a different mechanism from the one
   * that ships.
   */
  it('sees a contract lit past the first page of focus history', async () => {
    const a = await authorContract('op-a');
    const noise = await authorContract('op-noise');
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: a, level: 'all' } }, 'PUT'),
    );

    // Cycle an unrelated contract's membership past one page (500), so a
    // single-page read cannot reach what follows.
    let rev = 1;
    for (let i = 0; i < 260; i++) {
      await light(noise, rev++, `op-noise-on-${i}`);
      await unlight(noise, rev++, `op-noise-off-${i}`);
    }

    // NOW light A. Its focus event sits far beyond the first page.
    await light(a, 1, 'op-light-a');
    await harness.curator.sweep();
    const baseline = deltas(await ledger(CORA)).length;

    // B is out of focus (only A is lit), so an event on it must be silent
    // — which is only true if the membership read reached A's lighting.
    // A truncated read sees an empty set, calls focus inactive, and lets
    // every delta through.
    const b = await authorContract('op-b');
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract: b, level: 'all' } }, 'PUT'),
    );
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att-b',
      expectedStateRev: 1,
      revision: observed('sha-b1'),
      body: { contract: b, summary: 'poked at B' },
    });
    await harness.curator.sweep();
    expect(deltas(await ledger(CORA))).toHaveLength(baseline);

    // POSITIVE CONTROL: the same subscriber still hears about A, which IS
    // lit past the page — so the read is not merely refusing everything.
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-att-a',
      expectedStateRev: 2,
      revision: observed('sha-a1'),
      body: { contract: a, summary: 'poked at A' },
    });
    await harness.curator.sweep();
    const after = deltas(await ledger(CORA));
    expect(after.length).toBeGreaterThan(baseline);
    expect(after.flatMap((d) => d.refs)).toContain(a);
  });
});
