/**
 * The curator, driven with ZERO floor signals.
 *
 * THE PROPERTY THIS FILE IS. Not a property it asserts — a property it
 * IS, structurally. Every class, every lease, every receipt and every
 * silence rule below is exercised over HTTP and a fake broker
 * subscriber, and nothing in this file ever posts a signal. If the
 * curator needed one, this suite would not go green.
 *
 * The last test in the file is the guard on that claim: it reads this
 * source and asserts the signal surface is absent from it. A doctrine
 * that lives in a header is a doctrine a future edit walks past; a
 * doctrine that greps its own file is one it cannot.
 *
 * `spine-curator-signals.test.ts` is the other half — the same
 * scenarios WITH signals, asserting the end states are identical and
 * only the timing moves.
 *
 * THE CAST is #155's, with the bindings that make the class-1 table
 * exercisable in all four of its arms:
 *
 *   lea        authors the contract (so: originator), and verifies it
 *   rune       assignee, and the member who raises asks
 *   andrewjon  the named authority
 *   cora       bound to nothing — the control for "everyone else is
 *              silent by default", which a fixture where every member
 *              is bound cannot tell from "the curator is broken"
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const HOUR = 60 * 60 * 1000;

let harness: CuratorApp;
let app: CuratorApp['app'];
let sinks: Record<string, Sink>;

const CRITERION_TEXT = 'the endpoint returns 200 with a JSON body and an ETag';
const ASK_QUESTION = 'may we drop the legacy v1 route in this release?';
const ASK_CONTEXT = 'three consumers still call it; two have migrated in staging';
const RULING_REASONING = 'drop it — the third consumer is ours and we own its migration';
const OUTCOME_TEXT = 'shipped the endpoint behind the beta flag';

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

/** lea authors; rune is assignee, lea verifier, andrewjon authority. */
async function authorContract(opId = 'op-spec'): Promise<string> {
  const res = await post(app, '/spine/events', LEA, {
    kind: 'specification',
    subject: 'repo:acme',
    opId,
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

const observed = (value: string) => ({
  subject: 'repo:acme',
  value,
  how: 'observed' as const,
  source: 'integration:github',
  at: new Date(T0).toISOString(),
});

async function ledger(token: string, member?: string): Promise<SpineInjection[]> {
  const path = member === undefined ? '/spine/injections' : `/spine/injections?member=${member}`;
  return (await get(app, path, token)).injections as SpineInjection[];
}

// ─────────────────────────────────────────────────────────────────────

describe('class 1 — addressed, and it never yields', () => {
  it('routes an ask to the authority it names', async () => {
    const contract = await authorContract();
    await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      subject: 'repo:acme',
      opId: 'op-ask',
      expectedStateRev: 1,
      body: {
        authority: 'andrewjon',
        question: ASK_QUESTION,
        context: ASK_CONTEXT,
        unblocks: 'the release cut',
        contract,
      },
    });
    expect(sinks.andrewjon?.injections).toHaveLength(1);
    const body = sinks.andrewjon?.injections[0]?.body ?? '';
    expect(body).toContain('names you as the authority');
    expect(body).toContain(contract);
    expect(body).toContain('Ship the endpoint');
    // Nobody else. The asker included: an act you performed is not an
    // act that addressed you.
    expect(sinks.rune?.injections).toHaveLength(0);
    expect(sinks.cora?.injections).toHaveLength(0);
    expect(sinks.lea?.injections).toHaveLength(0);
  });

  it('routes a verdict to the contract assignee', async () => {
    const contract = await authorContract();
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    expect(sinks.rune?.injections).toHaveLength(1);
    expect(sinks.rune?.injections[0]?.body).toContain('a verdict landed on your contract');
    expect(sinks.cora?.injections).toHaveLength(0);
  });

  it('routes a ruling back to the member who raised the ask', async () => {
    const contract = await authorContract();
    const ask = (
      (
        await post(app, '/spine/events', RUNE, {
          kind: 'ask',
          subject: 'repo:acme',
          opId: 'op-ask',
          expectedStateRev: 1,
          body: {
            authority: 'andrewjon',
            question: ASK_QUESTION,
            context: ASK_CONTEXT,
            unblocks: 'the release cut',
            contract,
          },
        })
      ).event as SpineEvent
    ).id;
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'ruling',
      opId: 'op-ruling',
      expectedStateRev: 2,
      body: { ask, decision: 'drop it', reasoning: RULING_REASONING, contract },
    });
    const runeInjections = sinks.rune?.injections ?? [];
    expect(runeInjections).toHaveLength(1);
    expect(runeInjections[0]?.body).toContain('answers the ask you raised');
  });

  it('routes a redirect to the member it names', async () => {
    const contract = await authorContract();
    const ask = (
      (
        await post(app, '/spine/events', RUNE, {
          kind: 'ask',
          subject: 'repo:acme',
          opId: 'op-ask',
          expectedStateRev: 1,
          body: {
            authority: 'andrewjon',
            question: ASK_QUESTION,
            context: ASK_CONTEXT,
            unblocks: 'the release cut',
            contract,
          },
        })
      ).event as SpineEvent
    ).id;
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'ask_action',
      opId: 'op-redirect',
      expectedStateRev: 2,
      body: {
        ask,
        action: 'redirect',
        reason: 'cora owns the v1 consumers',
        redirectTo: 'cora',
      },
    });
    expect(sinks.cora?.injections).toHaveLength(1);
    expect(sinks.cora?.injections[0]?.body).toContain('an ask was redirected to you');
  });

  it('reaches a member who set the contract to `none` — class 1 never yields', async () => {
    const contract = await authorContract();
    await app.request(
      '/spine/curator',
      authed(RUNE, { subscription: { contract, level: 'none' } }, 'PUT'),
    );
    // The positive control for the write itself: the level really is
    // `none`, so a class-1 line arriving is the class refusing to
    // yield rather than the write having failed.
    const config = (await get(app, '/spine/curator', RUNE)).subscriptions as {
      contract: string;
      level: string;
    }[];
    expect(config.find((s) => s.contract === contract)?.level).toBe('none');

    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    expect(sinks.rune?.injections).toHaveLength(1);
  });

  it('serves class 0 to a member who set every contract to `none`', async () => {
    // Class 0 does not consult a level either, and the reason is
    // structural rather than a policy choice: the pack reaches an album
    // because the member ASKED for it. A subscription that could
    // suppress `orient` would be a member able to switch off their own
    // recovery.
    const contract = await authorContract();
    await app.request(
      '/spine/curator',
      authed(RUNE, { subscription: { contract, level: 'none' } }, 'PUT'),
    );
    const pack = (await get(app, '/spine/orient', RUNE)) as { contracts: unknown[] };
    expect(pack.contracts).toHaveLength(1);
    const rows = await ledger(RUNE);
    expect(rows.map((r) => r.kind)).toEqual(['recovery_pack']);
    expect(harness.curatorStore.leases('rune').map((l) => l.ref)).toEqual([contract]);
  });

  it('spends nothing twice on an idempotent retry', async () => {
    const contract = await authorContract();
    const verdict = {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    };
    await post(app, '/spine/events', LEA, verdict);
    // The replay — same op_id, same payload. 200, one event, and it
    // must not spend rune's album a second time.
    await post(app, '/spine/events', LEA, verdict, 200);
    expect(sinks.rune?.injections).toHaveLength(1);
    expect(await ledger(RUNE)).toHaveLength(1);
  });
});

describe('no full re-sends — the line carries an id, a title, and what changed', () => {
  it('omits the criterion text, the question, the reasoning and the outcome', async () => {
    const contract = await authorContract();
    const ask = (
      (
        await post(app, '/spine/events', RUNE, {
          kind: 'ask',
          subject: 'repo:acme',
          opId: 'op-ask',
          expectedStateRev: 1,
          body: {
            authority: 'andrewjon',
            question: ASK_QUESTION,
            context: ASK_CONTEXT,
            unblocks: 'the release cut',
            contract,
          },
        })
      ).event as SpineEvent
    ).id;
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'ruling',
      opId: 'op-ruling',
      expectedStateRev: 2,
      body: { ask, decision: 'drop it', reasoning: RULING_REASONING, contract },
    });
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 3,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    await harness.curator.sweep();

    // The inverse of the usual grep: name the strings the line must
    // NOT carry. #155 finding 1 measured what re-sending a whole
    // objective on every event costs, and the answer was that an id,
    // a title and what changed suffice.
    const everything = Object.values(sinks).map(injectionText).join('\n');
    expect(everything).not.toContain(CRITERION_TEXT);
    expect(everything).not.toContain(ASK_QUESTION);
    expect(everything).not.toContain(ASK_CONTEXT);
    expect(everything).not.toContain(RULING_REASONING);

    // The positive control. Without it, everything above passes
    // against a curator that pushed nothing at all — which is exactly
    // the shape "assert absent" suites fail in.
    expect(everything).toContain(contract);
    expect(everything).toContain('Ship the endpoint');
    expect(everything).toContain('orient');
  });

  it('keeps the outcome out of a done-state delta', async () => {
    const contract = await authorContract();
    // andrewjon subscribes at `all` so a class-2 line about the
    // completion definitely fires; the assertion is about its content.
    await app.request(
      '/spine/curator',
      authed(ANDREWJON, { subscription: { contract, level: 'all' } }, 'PUT'),
    );
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    const verdictId = (
      (await get(app, `/spine/events?kind=criterion_verdict`, LEA)).events as SpineEvent[]
    )[0]?.id as string;
    await post(app, '/spine/events', LEA, {
      kind: 'lifecycle',
      opId: 'op-done',
      expectedStateRev: 2,
      revision: observed('sha-a'),
      cites: [verdictId],
      body: { contract, state: 'done', result: OUTCOME_TEXT },
    });
    await harness.curator.sweep();
    const text = injectionText(sinks.andrewjon as Sink);
    expect(text).toContain(contract);
    expect(text).toContain('lifecycle');
    expect(text).not.toContain(OUTCOME_TEXT);
  });
});

describe('class 2 — reader-side levels, batched per tick', () => {
  it('collapses N events in one tick into ONE injection', async () => {
    const contract = await authorContract();
    // Drain the founding specification first: this test is about
    // BATCHING, and a backlog in the same tick would make "one
    // injection" true for the wrong reason.
    await harness.curator.sweep();
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract, level: 'all' } }, 'PUT'),
    );
    for (const [i, decision] of ['met', 'unmet', 'met'].entries()) {
      await post(app, '/spine/events', LEA, {
        kind: 'criterion_verdict',
        opId: `op-verdict-${i}`,
        expectedStateRev: 1 + i,
        revision: observed(`sha-${i}`),
        body: { contract, criterion: 'c1', decision, evidence: `run ${i}` },
      });
    }
    await harness.curator.sweep();
    const injections = sinks.cora?.injections ?? [];
    expect(injections).toHaveLength(1);
    // ONE line, and it accounts for all three — a batch that silently
    // dropped two would also be "one injection".
    expect(injections[0]?.body).toContain('3 event(s)');
    const rows = await ledger(CORA);
    expect(rows.filter((r) => r.class === 2)).toHaveLength(1);
  });

  it('gives a `lifecycle` subscriber lifecycle events and nothing else', async () => {
    const contract = await authorContract();
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract, level: 'lifecycle' } }, 'PUT'),
    );
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'unmet', evidence: 'the ETag is missing' },
    });
    await harness.curator.sweep();
    expect(sinks.cora?.injections).toHaveLength(0);

    // The positive control: the same subscriber, a lifecycle event.
    // Without it this passes against a level that admits nothing.
    await post(app, '/spine/events', LEA, {
      kind: 'lifecycle',
      opId: 'op-wait',
      expectedStateRev: 2,
      body: { contract, state: 'waiting_on', member: 'andrewjon', reason: 'needs a call' },
    });
    await harness.curator.sweep();
    expect(sinks.cora?.injections).toHaveLength(1);
    expect(sinks.cora?.injections[0]?.body).toContain('lifecycle');
  });

  it('defaults the originator to `lifecycle` and everyone else to silence', async () => {
    const contract = await authorContract();
    const leaConfig = (await get(app, '/spine/curator', LEA)).subscriptions as {
      contract: string;
      level: string;
      explicit: boolean;
    }[];
    expect(leaConfig.find((s) => s.contract === contract)).toMatchObject({
      level: 'lifecycle',
      explicit: false,
    });
    // cora is bound to nothing, so she has no row for this contract at
    // all — which is the strongest form of "everyone else is silent".
    const coraConfig = (await get(app, '/spine/curator', CORA)).subscriptions as unknown[];
    expect(coraConfig).toHaveLength(0);

    // rune (the ASSIGNEE) defaults to silence too: everything that
    // binds him arrives as class 1, which never yields, and a class-2
    // default as well would spend his album twice on one fact.
    const runeConfig = (await get(app, '/spine/curator', RUNE)).subscriptions as {
      contract: string;
      level: string;
      explicit: boolean;
    }[];
    expect(runeConfig.find((s) => s.contract === contract)).toMatchObject({
      level: 'none',
      explicit: false,
    });

    await post(app, '/spine/events', RUNE, {
      kind: 'lifecycle',
      opId: 'op-wait',
      expectedStateRev: 1,
      body: { contract, state: 'waiting_on', member: 'andrewjon', reason: 'needs a call' },
    });
    await harness.curator.sweep();
    // lea hears it (originator default), cora does not.
    expect(sinks.lea?.injections).toHaveLength(1);
    expect(sinks.cora?.injections).toHaveLength(0);
  });

  it('does not send a class-2 line about an event the member already got as class 1', async () => {
    const contract = await authorContract();
    await harness.curator.sweep();
    await app.request(
      '/spine/curator',
      authed(RUNE, { subscription: { contract, level: 'all' } }, 'PUT'),
    );
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    await harness.curator.sweep();
    const rows = await ledger(RUNE);
    // The class-1 line and NOTHING else. `all` would otherwise send a
    // second line about the same verdict.
    expect(rows.map((r) => r.class)).toEqual([1]);
  });

  it('never sends a member a delta about their own act', async () => {
    const contract = await authorContract();
    await app.request(
      '/spine/curator',
      authed(LEA, { subscription: { contract, level: 'all' } }, 'PUT'),
    );
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    await harness.curator.sweep();
    expect(sinks.lea?.injections).toHaveLength(0);
  });
});

describe('class 3 — silence, and it is silence and not less', () => {
  it('produces zero pushes over four hours of sweeps on a parked contract', async () => {
    const contract = await authorContract();
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract, level: 'all' } }, 'PUT'),
    );
    await post(app, '/spine/events', LEA, {
      kind: 'lifecycle',
      opId: 'op-park',
      expectedStateRev: 1,
      body: { contract, state: 'parked', preemptedBy: 'the incident' },
    });
    // The parking event itself IS delivered — it is the last thing
    // anybody needs to know about this contract, and silencing it
    // would mean a subscriber never learns the work stopped.
    await harness.curator.sweep();
    expect(sinks.cora?.injections).toHaveLength(1);
    const afterPark = sinks.cora?.injections.length ?? 0;

    // Now four hours. Events keep landing on the parked contract
    // (chatter, corrections, an observation) and every one of them
    // must produce nothing.
    for (let hour = 1; hour <= 4; hour++) {
      harness.clock.ms = T0 + hour * HOUR;
      await post(app, '/spine/events', LEA, {
        kind: 'discussion',
        body: { contract, body: `hour ${hour}: still parked` },
      });
      await post(app, '/spine/events', CORA, {
        kind: 'observation',
        subject: 'repo:acme',
        revision: observed(`sha-hour-${hour}`),
        body: { what: 'head moved', output: `sha-hour-${hour}` },
      });
      await harness.curator.sweep();
    }
    expect(sinks.cora?.injections).toHaveLength(afterPark);
    // And nobody else woke up either — silence is silence for every
    // member, not only for the one the assertion names.
    expect(sinks.rune?.injections).toHaveLength(0);
    expect(sinks.andrewjon?.injections).toHaveLength(0);
  });

  it('silences a waiting_for contract the same way', async () => {
    const contract = await authorContract();
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract, level: 'all' } }, 'PUT'),
    );
    await post(app, '/spine/events', LEA, {
      kind: 'lifecycle',
      opId: 'op-waitfor',
      expectedStateRev: 1,
      body: {
        contract,
        state: 'waiting_for',
        event: 'the upstream release',
        check: 'gh release list --limit 1',
      },
    });
    await harness.curator.sweep();
    const baseline = sinks.cora?.injections.length ?? 0;
    harness.clock.ms = T0 + HOUR;
    await post(app, '/spine/events', LEA, {
      kind: 'attempt',
      opId: 'op-attempt',
      expectedStateRev: 2,
      revision: observed('sha-b'),
      body: { contract, summary: 'poked at it anyway' },
    });
    await harness.curator.sweep();
    expect(sinks.cora?.injections).toHaveLength(baseline);
  });
});

describe('leases', () => {
  it('grants on orient, over the whole pack, and grants on an EMPTY plate too', async () => {
    const contract = await authorContract();
    await get(app, '/spine/orient', RUNE);
    const runeLeases = harness.curatorStore.leases('rune');
    expect(runeLeases.map((l) => l.ref)).toEqual([contract]);
    expect(runeLeases[0]?.source).toBe('orient');

    // cora is bound to nothing. The old re-brief path skipped an empty
    // plate entirely — a documented defect, and the reason a member
    // with no contracts could otherwise never hold a lease at all.
    await get(app, '/spine/orient', CORA);
    expect(harness.curatorStore.receipt('cora')).not.toBeNull();
    const coraRows = await ledger(CORA);
    expect(coraRows).toHaveLength(1);
    expect(coraRows[0]).toMatchObject({ class: 0, kind: 'recovery_pack', delivered: true });
    expect(coraRows[0]?.bytes).toBeGreaterThan(0);
  });

  it("renews on the member's own append — the write path is the floor", async () => {
    const contract = await authorContract();
    await get(app, '/spine/orient', RUNE);
    const granted = harness.curatorStore.leases('rune')[0]?.grantedAt;
    expect(granted).toBe(T0);

    harness.clock.ms = T0 + 2 * HOUR;
    await post(app, '/spine/events', RUNE, {
      kind: 'attempt',
      opId: 'op-attempt',
      expectedStateRev: 1,
      revision: observed('sha-b'),
      body: { contract, summary: 'wired the handler' },
    });
    const renewed = harness.curatorStore.leases('rune')[0];
    expect(renewed?.grantedAt).toBe(T0 + 2 * HOUR);
    expect(renewed?.source).toBe('act');
    // And it is live again on a clock that would otherwise have
    // expired it, with no signal, no runner and no cooperation.
    expect(harness.curatorStore.leaseState(renewed as never, 30 * 60 * 1000, T0 + 2 * HOUR)).toBe(
      'live',
    );
  });

  it('buys exactly one nudge, then nothing until the lease state changes', async () => {
    const contract = await authorContract();
    await get(app, '/spine/orient', RUNE);
    // Something happens that rune has not read.
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'unmet', evidence: 'the ETag is missing' },
    });
    const beforeNudge = sinks.rune?.injections.length ?? 0;

    harness.clock.ms = T0 + 2 * HOUR;
    await harness.curator.sweep();
    const nudges = (await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge');
    expect(nudges).toHaveLength(1);
    expect(sinks.rune?.injections).toHaveLength(beforeNudge + 1);
    const nudgeBody = sinks.rune?.injections.at(-1)?.body ?? '';
    expect(nudgeBody).toContain('orient');
    // A nudge is a POINTER. Pushing the pack would be the forced
    // insertion §10 forbids, and the member is the only one who knows
    // whether they need it.
    expect(nudgeBody).not.toContain(CRITERION_TEXT);
    expect(nudgeBody).not.toContain('criteria');

    // Six more hours, six more sweeps, nothing more.
    for (let hour = 3; hour <= 8; hour++) {
      harness.clock.ms = T0 + hour * HOUR;
      await harness.curator.sweep();
    }
    expect((await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge')).toHaveLength(1);

    // The positive control: re-orienting renews the lease, so the next
    // unread act earns a nudge again. Without this, the suite passes
    // against a curator that nudges once and then never again, ever.
    harness.clock.ms = T0 + 9 * HOUR;
    await get(app, '/spine/orient', RUNE);
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict-2',
      expectedStateRev: 2,
      revision: observed('sha-b'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-b' },
    });
    harness.clock.ms = T0 + 12 * HOUR;
    await harness.curator.sweep();
    expect((await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge')).toHaveLength(2);
  });

  it('does not nudge a member whose leases are stale but whose world has not moved', async () => {
    await authorContract();
    await get(app, '/spine/orient', RUNE);
    for (let hour = 1; hour <= 4; hour++) {
      harness.clock.ms = T0 + hour * HOUR;
      await harness.curator.sweep();
    }
    expect((await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge')).toHaveLength(0);
  });

  it('does not nudge about a parked contract', async () => {
    const contract = await authorContract();
    await get(app, '/spine/orient', RUNE);
    await post(app, '/spine/events', LEA, {
      kind: 'lifecycle',
      opId: 'op-park',
      expectedStateRev: 1,
      body: { contract, state: 'parked', preemptedBy: 'the incident' },
    });
    harness.clock.ms = T0 + 4 * HOUR;
    await harness.curator.sweep();
    expect((await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge')).toHaveLength(0);
  });
});

describe('receipts advance on reads and on nothing else', () => {
  it('moves on orient, on a page read, and on a by-id read', async () => {
    await authorContract();
    await get(app, '/spine/orient', CORA);
    const afterOrient = harness.curatorStore.receipt('cora');
    expect(afterOrient?.via).toBe('orient');
    expect(afterOrient?.seq).toBeGreaterThan(0);

    await post(app, '/spine/events', LEA, {
      kind: 'discussion',
      body: { body: 'a thought' },
    });
    const page = (await get(app, '/spine/events', CORA)).events as SpineEvent[];
    const afterPage = harness.curatorStore.receipt('cora');
    expect(afterPage?.via).toBe('annex_read');
    expect(afterPage?.seq).toBe(page.at(-1)?.seq);

    // Reading an OLD event by id must not move the receipt backwards.
    await get(app, `/spine/events/${page[0]?.id}`, CORA);
    expect(harness.curatorStore.receipt('cora')?.seq).toBe(afterPage?.seq);
  });

  it("is NOT advanced by the curator's own pushes", async () => {
    const contract = await authorContract();
    await get(app, '/spine/orient', RUNE);
    const before = harness.curatorStore.receipt('rune')?.seq as number;

    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    harness.clock.ms = T0 + 2 * HOUR;
    await harness.curator.sweep();

    // The positive control first: the pushes really happened. A
    // receipt that did not move because nothing was sent proves
    // nothing at all.
    expect(sinks.rune?.injections.length ?? 0).toBeGreaterThan(0);
    expect(harness.curatorStore.receipt('rune')?.seq).toBe(before);
  });
});

describe('the ledger', () => {
  it('accounts for every class with member, refs, cursor and bytes', async () => {
    const contract = await authorContract();
    await get(app, '/spine/orient', RUNE);
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
    });
    const rows = await ledger(RUNE);
    expect(rows.map((r) => r.kind).sort()).toEqual(['addressed', 'recovery_pack']);
    for (const row of rows) {
      expect(row.member).toBe('rune');
      expect(row.bytes).toBeGreaterThan(0);
      expect(row.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(row.delivered).toBe(true);
    }
    expect(rows.find((r) => r.kind === 'addressed')?.refs).toEqual([contract]);
  });

  it('is self-or-members.manage, and the ledger of a member you are not is refused', async () => {
    await authorContract();
    await get(app, '/spine/orient', RUNE);
    // andrewjon holds members.manage.
    expect(await ledger(ANDREWJON, 'rune')).toHaveLength(1);
    // cora holds nothing.
    const refused = await app.request('/spine/injections?member=rune', authed(CORA));
    expect(refused.status).toBe(403);
    // The positive control: cora can still read her own.
    expect((await app.request('/spine/injections', authed(CORA))).status).toBe(200);
  });
});

describe('policy is data', () => {
  it('takes a cadence change at runtime, with an updated-by/at trail', async () => {
    await authorContract();
    const before = (await get(app, '/spine/curator', RUNE)).policy as Record<string, unknown>;
    expect(before).toMatchObject({ explicit: false, updatedBy: null, updatedAt: null });

    const res = await app.request(
      '/spine/curator',
      authed(ANDREWJON, { member: 'rune', policy: { leaseTtlMs: 60_000 } }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const after = ((await res.json()) as { policy: Record<string, unknown> }).policy;
    expect(after).toMatchObject({ leaseTtlMs: 60_000, explicit: true, updatedBy: 'andrewjon' });
    // A patch touches what it names and nothing else: the nudge floor
    // is still the team default, not zero.
    expect(after.nudgeMinIntervalMs).toBe(15 * 60 * 1000);
  });

  it('refuses an empty write and a level on a contract that does not exist', async () => {
    await authorContract();
    expect((await app.request('/spine/curator', authed(RUNE, {}, 'PUT'))).status).toBe(400);
    expect(
      (
        await app.request(
          '/spine/curator',
          authed(RUNE, { subscription: { contract: 'evt_nope', level: 'all' } }, 'PUT'),
        )
      ).status,
    ).toBe(404);
    // The positive control for both refusals.
    const contract = await authorContract('op-spec-2');
    expect(
      (
        await app.request(
          '/spine/curator',
          authed(RUNE, { subscription: { contract, level: 'all' } }, 'PUT'),
        )
      ).status,
    ).toBe(200);
  });

  it('refuses to read or write another member without members.manage', async () => {
    await authorContract();
    expect((await app.request('/spine/curator?member=rune', authed(CORA))).status).toBe(403);
    expect(
      (
        await app.request(
          '/spine/curator',
          authed(CORA, { member: 'rune', policy: { leaseTtlMs: 1 } }, 'PUT'),
        )
      ).status,
    ).toBe(403);
    // The positive control: members.manage may.
    expect((await app.request('/spine/curator?member=rune', authed(ANDREWJON))).status).toBe(200);
  });
});

describe('the floor property, enforced on this file', () => {
  it('drives every assertion above without reporting a single floor signal', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    // Everything below the marker is this test. Above it is the suite.
    const suite = source.slice(0, source.indexOf('THE FLOOR MARKER'));
    for (const forbidden of ['spine-signals', 'reportSpineSignal', 'onSignal', 'dump_declared']) {
      expect(suite, `the floor-only suite must not use ${forbidden}`).not.toContain(forbidden);
    }
    // The positive control on the guard itself: the marker really is
    // in the file, so the slice above is the suite and not an empty
    // string that trivially contains nothing.
    expect(suite.length).toBeGreaterThan(1000);
    expect(suite).toContain('class 1 — addressed, and it never yields');
  });
});

// THE FLOOR MARKER — everything above this line is the suite the guard reads.
