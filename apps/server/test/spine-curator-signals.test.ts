/**
 * Floor signals — the other half of the floor property.
 *
 * THE CLAIM, stated precisely rather than flatteringly:
 *
 *   NO CORRECTNESS PROPERTY DEPENDS ON A SIGNAL. A signal may spend at
 *   most one additional nudge. The owed end state is identical.
 *
 * The middle clause is a real divergence, it is accepted, and it has
 * its own named test below. An earlier draft of this header said the
 * end states were identical and only the timing moved. That was
 * overstated in exactly the direction that makes a design sound better
 * than it is, and the ledger can tell the difference: a member who was
 * going to read on their own in five minutes, whose runner declares a
 * dump at one minute, gets a line they would otherwise never have got.
 *
 * What that costs is one nudge — a pointer at `orient`, the cheapest
 * thing the curator can spend, and bounded at one however many signals
 * arrive. What it cannot cost is a missed obligation, because nothing
 * a signal touches is an input to what a member is OWED, only to when
 * the curator stops assuming they still hold it.
 *
 * The comparison is on the LEDGER, not on the sink. The ledger is
 * what the system says it spent — kinds, classes and refs — so two
 * runs that agree there agree about everything a member experienced,
 * minus the clock.
 */

import type { SpineEvent, SpineInjection } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';
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
  type Sink,
  T0,
} from './helpers/spine-curator-app.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const CRITERION_TEXT = 'the endpoint returns 200 with a JSON body and an ETag';

interface Arm {
  harness: CuratorApp;
  sinks: Record<string, Sink>;
}

async function setUpArm(): Promise<Arm> {
  const harness = makeCuratorApp();
  const sinks = {
    lea: harness.sinkFor('lea'),
    rune: harness.sinkFor('rune'),
    andrewjon: harness.sinkFor('andrewjon'),
    cora: harness.sinkFor('cora'),
  };
  await post(harness.app, '/spine/subjects', LEA, { id: 'repo:acme', type: 'repo' });
  return { harness, sinks };
}

const observed = (value: string) => ({
  subject: 'repo:acme',
  value,
  how: 'observed' as const,
  source: 'integration:github',
  at: new Date(T0).toISOString(),
});

async function authorContract(arm: Arm): Promise<string> {
  const res = await post(arm.harness.app, '/spine/events', LEA, {
    kind: 'specification',
    subject: 'repo:acme',
    opId: 'op-spec',
    body: {
      title: 'Ship the endpoint',
      criteria: [{ id: 'c1', text: CRITERION_TEXT }],
      assignee: 'rune',
      verifier: 'lea',
      authority: 'andrewjon',
    },
  });
  return (res.event as SpineEvent).id;
}

/**
 * rune orients, then a verdict he never reads lands on his contract.
 * The state a nudge is owed from — reached identically in both arms.
 */
async function reachTheOwedState(arm: Arm): Promise<string> {
  const contract = await authorContract(arm);
  await get(arm.harness.app, '/spine/orient', RUNE);
  await post(arm.harness.app, '/spine/events', LEA, {
    kind: 'criterion_verdict',
    opId: 'op-verdict',
    expectedStateRev: 1,
    revision: observed('sha-a'),
    body: { contract, criterion: 'c1', decision: 'unmet', evidence: 'the ETag is missing' },
  });
  return contract;
}

async function ledgerOf(arm: Arm, token: string): Promise<SpineInjection[]> {
  return (await get(arm.harness.app, '/spine/injections', token)).injections as SpineInjection[];
}

/**
 * What a member experienced, with the clock stripped out — and with
 * the contract's ULID normalised, since two arms mint different ids
 * for the same contract and an id comparison would fail for a reason
 * that has nothing to do with the property.
 */
function shapeOf(
  rows: SpineInjection[],
  contract: string,
): { class: number; kind: string; refs: string[] }[] {
  return rows.map((row) => ({
    class: row.class,
    kind: row.kind,
    refs: row.refs.map((ref) => (ref === contract ? '<contract>' : ref)),
  }));
}

async function signal(
  arm: Arm,
  token: string,
  name: string,
  body: Record<string, unknown>,
  expected = 200,
): Promise<Record<string, unknown>> {
  const res = await arm.harness.app.request(`/members/${name}/spine-signals`, authed(token, body));
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status !== expected) {
    throw new Error(`signal returned ${res.status}, expected ${expected}: ${JSON.stringify(json)}`);
  }
  return json;
}

let arm: Arm;
beforeEach(async () => {
  arm = await setUpArm();
});

// ─────────────────────────────────────────────────────────────────────

describe('a declared dump buys latency and nothing else', () => {
  it('reaches the same end state as the clock does, sooner', async () => {
    // ARM A — no signal. The lease runs out on its own clock, and the
    // nudge lands on the first sweep after the TTL.
    const quiet = await setUpArm();
    const slowContract = await reachTheOwedState(quiet);
    quiet.harness.clock.ms = T0 + 5 * MINUTE;
    await quiet.harness.curator.sweep();
    expect(
      (await ledgerOf(quiet, RUNE)).filter((r) => r.kind === 'recovery_nudge'),
      'five minutes in, the lease is still live and nothing is owed',
    ).toHaveLength(0);
    quiet.harness.clock.ms = T0 + 2 * HOUR;
    await quiet.harness.curator.sweep();

    // ARM B — the runner declares a dump one minute in. The same
    // nudge, on the sweep two minutes later instead of two hours.
    const fastContract = await reachTheOwedState(arm);
    arm.harness.clock.ms = T0 + MINUTE;
    const reported = await signal(arm, RUNE, 'rune', {
      signal: 'dump_declared',
      source: 'compact',
    });
    expect(reported).toEqual({ accepted: true, leasesInvalidated: 1 });
    arm.harness.clock.ms = T0 + 2 * MINUTE;
    await arm.harness.curator.sweep();

    // The nudge arrived 118 minutes earlier, and it is the SAME nudge.
    const fast = await ledgerOf(arm, RUNE);
    const slow = await ledgerOf(quiet, RUNE);
    expect(shapeOf(fast, fastContract)).toEqual(shapeOf(slow, slowContract));
    expect(fast.filter((r) => r.kind === 'recovery_nudge')).toHaveLength(1);
    // The same nudge once the two arms' contract ULIDs are normalised —
    // the nudge NAMES what moved, so the ids differ for a reason that
    // has nothing to do with the property.
    const normalise = (body: string | undefined, contract: string): string =>
      (body ?? '').split(contract).join('<contract>');
    expect(
      normalise(arm.sinks.rune?.injections.at(-1)?.body, fastContract),
      'the accelerated nudge is the same nudge the clock produces',
    ).toBe(normalise(quiet.sinks.rune?.injections.at(-1)?.body, slowContract));

    // And no EXTRA spend: the signalled arm did not earn a second
    // nudge by having been signalled.
    arm.harness.clock.ms = T0 + 4 * HOUR;
    await arm.harness.curator.sweep();
    expect((await ledgerOf(arm, RUNE)).filter((r) => r.kind === 'recovery_nudge')).toHaveLength(1);
  });

  it('ACCEPTED DIVERGENCE: a signal can spend one nudge a quiet clock would not', async () => {
    // Named, measured, and left in place rather than argued away.
    //
    // ARM A — no signal. The member reads on their own before the TTL
    // runs out, so the lease never becomes nudgeable and no nudge is
    // ever owed.
    const quiet = await setUpArm();
    await reachTheOwedState(quiet);
    quiet.harness.clock.ms = T0 + 5 * MINUTE;
    await get(quiet.harness.app, '/spine/events', RUNE);
    quiet.harness.clock.ms = T0 + 4 * HOUR;
    await quiet.harness.curator.sweep();
    expect((await ledgerOf(quiet, RUNE)).filter((r) => r.kind === 'recovery_nudge')).toHaveLength(
      0,
    );

    // ARM B — the same member, the same reading habit, but the runner
    // declares a dump at one minute. The signal moves the lease before
    // the read moves the receipt, so one nudge lands.
    await reachTheOwedState(arm);
    arm.harness.clock.ms = T0 + MINUTE;
    await signal(arm, RUNE, 'rune', { signal: 'dump_declared', source: 'compact' });
    arm.harness.clock.ms = T0 + 2 * MINUTE;
    await arm.harness.curator.sweep();
    arm.harness.clock.ms = T0 + 5 * MINUTE;
    await get(arm.harness.app, '/spine/events', RUNE);
    arm.harness.clock.ms = T0 + 4 * HOUR;
    await arm.harness.curator.sweep();
    expect(
      (await ledgerOf(arm, RUNE)).filter((r) => r.kind === 'recovery_nudge'),
      'the divergence is exactly one nudge',
    ).toHaveLength(1);

    // AND IT IS BOUNDED AT ONE. The clause is "at most one additional
    // nudge", so a member who keeps signalling must not keep earning
    // them — otherwise a chatty runner could spend an unbounded amount
    // of somebody's album, and that would be a signal with teeth.
    for (let i = 1; i <= 4; i++) {
      arm.harness.clock.ms = T0 + (4 + i) * HOUR;
      await signal(arm, RUNE, 'rune', { signal: 'dump_declared', source: 'compact' });
      await arm.harness.curator.sweep();
    }
    expect(
      (await ledgerOf(arm, RUNE)).filter((r) => r.kind === 'recovery_nudge'),
      'four more signals must not buy four more nudges',
    ).toHaveLength(1);

    // THE OWED END STATE IS IDENTICAL. Both members have read
    // everything; neither is owed anything further. That is the half of
    // the claim that is not negotiable, and it survives.
    const owed = async (a: Arm): Promise<number> => {
      const head = ((await get(a.harness.app, '/spine/events', ANDREWJON)) as { headSeq: number })
        .headSeq;
      return head - (a.harness.curatorStore.receipt('rune')?.seq ?? 0);
    };
    expect(await owed(arm)).toBe(await owed(quiet));
  });

  it('spends at most ONE extra nudge across six signals to a member who has NOT read', async () => {
    // The bound, on a member for whom it can actually fail.
    //
    // The arm pinned two commits ago used a member who had READ
    // everything, so `hasUnreadMovement` gated every case identically
    // and the pass and the fail failed the same way — a statement
    // about the harness rather than the logic. Measured on an unread
    // member before the fix: six signals in six minutes produced six
    // nudges, because each one re-armed the nudge already spent AND
    // erased the cadence floor's only input.
    const contract = await authorContract(arm);
    await get(arm.harness.app, '/spine/orient', RUNE);
    await post(arm.harness.app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'unmet', evidence: 'the ETag is missing' },
    });
    arm.harness.clock.ms = T0 + 2 * HOUR;
    await arm.harness.curator.sweep();
    const nudges = async (): Promise<number> =>
      (await ledgerOf(arm, RUNE)).filter((r) => r.kind === 'recovery_nudge').length;
    const afterFirst = await nudges();
    expect(afterFirst, 'the first nudge is owed').toBe(1);

    for (let i = 1; i <= 6; i++) {
      arm.harness.clock.ms = T0 + 2 * HOUR + i * MINUTE;
      await signal(arm, RUNE, 'rune', { signal: 'dump_declared', source: 'compact' });
      await arm.harness.curator.sweep();
    }
    expect(
      (await nudges()) - afterFirst,
      'six signals may buy at most one more nudge',
    ).toBeLessThanOrEqual(1);

    // And the member is STILL unread, so the silence above is the
    // gates holding and not the member having caught up.
    const head = ((await get(arm.harness.app, '/spine/events', ANDREWJON)) as { headSeq: number })
      .headSeq;
    expect(arm.harness.curatorStore.receipt('rune')?.seq).toBeLessThan(head);
  });

  it('invents nothing when there is nothing unread', async () => {
    await authorContract(arm);
    await get(arm.harness.app, '/spine/orient', RUNE);
    arm.harness.clock.ms = T0 + MINUTE;
    // The most aggressive signal there is, on a member who has read
    // everything. A signal that could conjure an injection out of an
    // empty annex would be a signal correctness depended on.
    await signal(arm, RUNE, 'rune', { signal: 'dump_declared', source: 'clear' });
    arm.harness.clock.ms = T0 + 2 * MINUTE;
    await arm.harness.curator.sweep();
    expect(await ledgerOf(arm, RUNE)).toHaveLength(1);
    expect((await ledgerOf(arm, RUNE))[0]?.kind).toBe('recovery_pack');
  });

  it('reports zero when a signal arrives with nothing held', async () => {
    // Not an error, and not silence: "the signal landed and there was
    // nothing to invalidate" is a different fact from "the signal was
    // dropped", and the response is where they stay apart.
    const res = await signal(arm, CORA, 'cora', { signal: 'bridge_disconnect' });
    expect(res).toEqual({ accepted: true, leasesInvalidated: 0 });
  });

  it('counts only LIVE leases, so a signal cannot claim the clock’s work', async () => {
    await reachTheOwedState(arm);
    // Two hours in, the lease has already expired on its own.
    arm.harness.clock.ms = T0 + 2 * HOUR;
    const res = await signal(arm, RUNE, 'rune', { signal: 'session_end' });
    expect(res).toEqual({ accepted: true, leasesInvalidated: 0 });
  });
});

describe('every signal in the union brackets a context', () => {
  it('invalidates on a fresh attachment as well as on a departure', async () => {
    for (const kind of ['bridge_connect', 'session_start', 'bridge_disconnect', 'session_end']) {
      const fresh = await setUpArm();
      await reachTheOwedState(fresh);
      const res = await signal(fresh, RUNE, 'rune', { signal: kind });
      expect(res, `${kind} must invalidate the lease rune was holding`).toEqual({
        accepted: true,
        leasesInvalidated: 1,
      });
      fresh.harness.clock.ms = T0 + MINUTE;
      await fresh.harness.curator.sweep();
      expect(
        (await ledgerOf(fresh, RUNE)).filter((r) => r.kind === 'recovery_nudge'),
        `${kind} should have brought the nudge forward`,
      ).toHaveLength(1);
    }
  });
});

describe('declared capabilities are the ceiling, and nothing reads them', () => {
  it('reports what a runner declared, and null for one that declared nothing', async () => {
    await authorContract(arm);
    const before = (await get(arm.harness.app, '/spine/curator', RUNE)).capabilities;
    expect(before).toBeNull();

    await signal(arm, RUNE, 'rune', {
      signal: 'session_start',
      capabilities: { dumpSignal: true, tokenUsage: false },
    });
    expect((await get(arm.harness.app, '/spine/curator', RUNE)).capabilities).toEqual({
      dumpSignal: true,
      tokenUsage: false,
    });
    // A different member's runner declared nothing, and stays null —
    // the map is per member, not a team-wide flag.
    expect((await get(arm.harness.app, '/spine/curator', CORA)).capabilities).toBeNull();
  });

  it('behaves identically for a runner that declares nothing', async () => {
    const declaring = await setUpArm();
    const declaringContract = await reachTheOwedState(declaring);
    await signal(declaring, RUNE, 'rune', {
      signal: 'session_start',
      capabilities: { dumpSignal: true, tokenUsage: true },
    });
    declaring.harness.clock.ms = T0 + MINUTE;
    await declaring.harness.curator.sweep();

    const silent = await setUpArm();
    const silentContract = await reachTheOwedState(silent);
    await signal(silent, RUNE, 'rune', { signal: 'session_start' });
    silent.harness.clock.ms = T0 + MINUTE;
    await silent.harness.curator.sweep();

    expect(shapeOf(await ledgerOf(silent, RUNE), silentContract)).toEqual(
      shapeOf(await ledgerOf(declaring, RUNE), declaringContract),
    );
  });
});

describe('the signals route is runner-auth and self-only', () => {
  it('refuses a member reporting for somebody else', async () => {
    const res = await arm.harness.app.request(
      '/members/rune/spine-signals',
      authed(CORA, { signal: 'session_end' }),
    );
    expect(res.status).toBe(403);
    // The positive control: cora may report for herself.
    await signal(arm, CORA, 'cora', { signal: 'session_end' });
  });

  it('refuses a browser session — a UI cannot observe a compaction', async () => {
    const session = arm.harness.sessions.create('rune', 'test');
    const res = await arm.harness.app.request('/members/rune/spine-signals', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${session.id}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ signal: 'dump_declared', source: 'compact' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'spine signals are reported by the runner, not by a session',
    });
  });

  it('refuses a signal outside the closed union, and accepts the nearest valid one', async () => {
    const res = await arm.harness.app.request(
      '/members/rune/spine-signals',
      authed(RUNE, { signal: 'context_compacted' }),
    );
    expect(res.status).toBe(400);
    await signal(arm, RUNE, 'rune', { signal: 'dump_declared' });
  });

  it('404s the whole surface when no curator is wired', async () => {
    // The annex without a curator is a perfectly good read-only spine,
    // and the signals endpoint is the curator's, not the annex's.
    const { makeSpineApp, LEA: PLAIN_LEA } = await import('./helpers/spine-app.js');
    const bare = makeSpineApp().app;
    for (const path of ['/spine/curator', '/spine/injections', '/members/lea/spine-signals']) {
      const res = await bare.request(path, authed(PLAIN_LEA));
      expect(res.status, path).toBe(404);
    }
    // The positive control: the annex surface is still up on that app.
    expect((await bare.request('/spine/orient', authed(PLAIN_LEA))).status).toBe(200);
  });
});

describe('every class still works with signals in the stream', () => {
  it('delivers class 1 across a dump, because class 1 does not consult a lease', async () => {
    const contract = await authorContract(arm);
    await signal(arm, RUNE, 'rune', { signal: 'dump_declared', source: 'compact' });
    await post(arm.harness.app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    expect(arm.sinks.rune?.injections).toHaveLength(1);
    expect(arm.sinks.rune?.injections[0]?.body).toContain('a verdict landed on your contract');
  });

  it('keeps class 3 silent no matter how many signals arrive', async () => {
    const contract = await authorContract(arm);
    await arm.harness.app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract, level: 'all' } }, 'PUT'),
    );
    await post(arm.harness.app, '/spine/events', LEA, {
      kind: 'lifecycle',
      opId: 'op-park',
      expectedStateRev: 1,
      body: { contract, state: 'parked', preemptedBy: 'the incident' },
    });
    await arm.harness.curator.sweep();
    const afterPark = arm.sinks.cora?.injections.length ?? 0;
    for (let i = 1; i <= 4; i++) {
      arm.harness.clock.ms = T0 + i * HOUR;
      await signal(arm, CORA, 'cora', { signal: 'dump_declared', source: 'compact' });
      await signal(arm, ANDREWJON, 'andrewjon', { signal: 'bridge_connect' });
      await arm.harness.curator.sweep();
    }
    expect(arm.sinks.cora?.injections).toHaveLength(afterPark);
  });
});
