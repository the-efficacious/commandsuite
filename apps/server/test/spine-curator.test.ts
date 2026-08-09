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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCurator } from '../src/spine/index.js';
import {
  ANDREWJON,
  assertNoSignalsWereUsed,
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

// THE FLOOR PROPERTY, ON EVERY TEST IN THIS FILE, BEHAVIOURALLY.
//
// The marker check at the bottom reads this file's own source for the
// signal vocabulary; this reads the SYSTEM. The source check shipped
// first on its own and was defeated in review by routing an
// invalidation through a harness helper — thirty tests green, guard
// silent. A name check is a claim about spelling; this is a claim
// about what happened.
afterEach(() => {
  assertNoSignalsWereUsed(harness);
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

describe('class 1 — a terminal or parked lifecycle addresses the people carrying it', () => {
  it('reaches the assignee on every one of the four states, even at `none`', async () => {
    // The four transitions that CHANGE WHAT SOMEBODY OWES rather than
    // report on it. Each driven separately: a loop asserting "some
    // state reached them" would pass with three of the four wired.
    for (const state of ['done', 'cancelled', 'superseded', 'parked']) {
      const fresh = makeCuratorApp();
      harness = fresh;
      app = fresh.app;
      sinks = {
        lea: fresh.sinkFor('lea'),
        rune: fresh.sinkFor('rune'),
        andrewjon: fresh.sinkFor('andrewjon'),
        cora: fresh.sinkFor('cora'),
      };
      await post(app, '/spine/subjects', LEA, { id: 'repo:acme', type: 'repo' });
      const contract = await authorContract();
      // A real successor for the supersession arm — the store refuses
      // a contract superseding itself, and rightly.
      const successor =
        state === 'superseded' ? await authorContract('op-spec-successor') : contract;
      // The strongest form: the assignee has explicitly asked for
      // silence on this contract, and still hears that it ended.
      await app.request(
        '/spine/curator',
        authed(RUNE, { subscription: { contract, level: 'none' } }, 'PUT'),
      );
      await harness.curator.sweep();

      // `done` has to earn its way there: a named verifier means
      // completion needs verdicts covering every criterion at one
      // revision. Driving it through the real gate rather than around
      // it is the point — this arm must be the SAME transition a
      // member reaches in practice.
      let stateRev = 1;
      const cites: string[] = [];
      if (state === 'done') {
        const verdict = (
          await post(app, '/spine/events', LEA, {
            kind: 'criterion_verdict',
            opId: 'op-verdict-for-done',
            expectedStateRev: 1,
            revision: observed('sha-a'),
            body: { contract, criterion: 'c1', decision: 'met', evidence: 'green at sha-a' },
          })
        ).event as SpineEvent;
        cites.push(verdict.id);
        stateRev = 2;
      }
      const extra =
        state === 'superseded'
          ? { successor }
          : state === 'parked'
            ? { preemptedBy: 'the incident' }
            : state === 'done'
              ? { result: OUTCOME_TEXT }
              : {};
      // Count the DELTA. The `done` arm's prerequisite verdict is
      // itself a class-1 line to the assignee, and a bare length
      // assertion would silently be measuring that one instead.
      const before = sinks.rune?.injections.length ?? 0;
      await post(app, '/spine/events', ANDREWJON, {
        kind: 'lifecycle',
        opId: `op-${state}`,
        expectedStateRev: stateRev,
        ...(cites.length > 0 ? { cites, revision: observed('sha-a') } : {}),
        body: { contract, state, reason: 'the team decided', ...extra },
      });
      expect(
        (sinks.rune?.injections.length ?? 0) - before,
        `${state} must reach the assignee`,
      ).toBe(1);
      const body = sinks.rune?.injections.at(-1)?.body ?? '';
      expect(body).toContain(contract);
      expect(body).toContain('Ship the endpoint');
      // And the outcome text is still not in it — this is a new class-1
      // arm, not a new exemption from the no-re-send rule.
      expect(body).not.toContain(OUTCOME_TEXT);
      expect(body).not.toContain(CRITERION_TEXT);
    }
  });

  it('reaches the NAMED verifier too, and nobody who is merely watching', async () => {
    const contract = await authorContract();
    await harness.curator.sweep();
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-cancel',
      expectedStateRev: 1,
      body: { contract, state: 'cancelled', reason: 'the team decided' },
    });
    expect(sinks.rune?.injections, 'assignee').toHaveLength(1);
    expect(sinks.lea?.injections, 'named verifier').toHaveLength(1);
    expect(sinks.cora?.injections).toHaveLength(0);
    expect(sinks.lea?.injections[0]?.body).toContain(contract);
  });

  it('does not invent a verifier for a contract that named none', async () => {
    const contract = (
      (
        await post(app, '/spine/events', LEA, {
          kind: 'specification',
          subject: 'repo:acme',
          opId: 'op-spec-solo',
          body: {
            title: 'Ship the endpoint',
            criteria: [{ id: 'c1', text: CRITERION_TEXT }],
            assignee: 'rune',
          },
        })
      ).event as SpineEvent
    ).id;
    await harness.curator.sweep();
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-cancel-solo',
      expectedStateRev: 1,
      body: { contract, state: 'cancelled', reason: 'deprioritised' },
    });
    expect(sinks.rune?.injections).toHaveLength(1);
    // A contract with no verifier has nobody holding that obligation,
    // and inventing a recipient is how a queue fills with items nobody
    // owns.
    expect(sinks.lea?.injections).toHaveLength(0);
    expect(sinks.cora?.injections).toHaveLength(0);
  });

  it('leaves active and waiting transitions to class 2', async () => {
    // The amendment is four states, not "lifecycle events". `active`
    // and the waiting states are progress reports: they recur, and
    // they are exactly what a `lifecycle` subscription is for.
    const contract = await authorContract();
    await harness.curator.sweep();
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-waiting',
      expectedStateRev: 1,
      body: { contract, state: 'waiting_on', member: 'cora', reason: 'needs a call' },
    });
    expect(sinks.rune?.injections, 'waiting_on is not a class-1 event').toHaveLength(0);
    await harness.curator.sweep();
    // The positive control, in the same test: lea hears it as class 2
    // (originator default), so the event is reaching the curator and
    // the silence above is the class boundary rather than a dead path.
    expect(sinks.lea?.injections).toHaveLength(1);
  });

  it('does not address an actor for their own act', async () => {
    // Reachable, and now obviously so: the assignee cancelling their
    // own contract is the ordinary way a contract gets cancelled.
    const contract = await authorContract();
    await harness.curator.sweep();
    await post(app, '/spine/events', RUNE, {
      kind: 'lifecycle',
      opId: 'op-self-cancel',
      expectedStateRev: 1,
      body: { contract, state: 'cancelled', reason: 'I am not going to get to this' },
    });
    expect(sinks.rune?.injections, 'nobody is told about their own act').toHaveLength(0);
    // The positive control: the OTHER recipient still hears it, so the
    // silence above is the actor rule and not a broken arm.
    expect(sinks.lea?.injections).toHaveLength(1);
    expect(sinks.lea?.injections[0]?.body).toContain(contract);
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

  it('locates a contract-less ask by its subject, and always says what it unblocks', async () => {
    // The standing-authority ask is exactly this shape: no contract,
    // just a question for whoever holds the decision. It rendered as
    // "On no contract. Since seq 0" — a line indistinguishable from
    // every other such line, which is the same failure as two facts
    // printing identically.
    await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      subject: 'repo:acme',
      opId: 'op-standing-ask',
      body: {
        authority: 'andrewjon',
        question: ASK_QUESTION,
        context: ASK_CONTEXT,
        unblocks: 'the release cut',
      },
    });
    const body = sinks.andrewjon?.injections[0]?.body ?? '';
    expect(body).toContain('repo:acme');
    // `unblocks` is required on every ask precisely so an authority
    // triaging a queue knows what is stopped.
    expect(body).toContain('unblocks: the release cut');
    expect(body).not.toContain('no contract or subject named');
    // And the rest of the ask still stays out.
    expect(body).not.toContain(ASK_QUESTION);
    expect(body).not.toContain(ASK_CONTEXT);
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

  it('SILENCES a `none` subscriber — the control the whole class exists for', async () => {
    // #155 finding 1 is fanout with no reader control, and `none` is
    // the answer to it. Everything else in this file asserts what
    // still ARRIVES at `none` (class 0 and class 1 never yield), which
    // is the finding's own polarity: a suite built entirely of "this
    // still gets through" passes against a level that admits
    // everything. This is the arm that fails if `none` does nothing.
    const contract = await authorContract();
    await harness.curator.sweep();
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract, level: 'none' } }, 'PUT'),
    );
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-waiting',
      expectedStateRev: 1,
      body: { contract, state: 'waiting_on', member: 'lea', reason: 'needs a call' },
    });
    await harness.curator.sweep();
    expect(sinks.cora?.injections, '`none` must mean nothing').toHaveLength(0);
    expect(await ledger(CORA)).toHaveLength(0);

    // THE POSITIVE CONTROL, on the same subscriber and the same event
    // class: flip to `all` and the very next lifecycle event arrives.
    // Without it, this passes against a curator that pushes to nobody.
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract, level: 'all' } }, 'PUT'),
    );
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-active',
      expectedStateRev: 2,
      body: { contract, state: 'active', reason: 'call happened' },
    });
    await harness.curator.sweep();
    expect(sinks.cora?.injections).toHaveLength(1);
  });

  it('silences `none` for an ORIGINATOR, overriding the default', async () => {
    // The default is `lifecycle` for whoever authored the contract, so
    // this is the arm where an explicit `none` has to beat a derived
    // level rather than merely agree with an absent one.
    const contract = await authorContract();
    await harness.curator.sweep();
    await app.request(
      '/spine/curator',
      authed(LEA, { subscription: { contract, level: 'none' } }, 'PUT'),
    );
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-waiting',
      expectedStateRev: 1,
      body: { contract, state: 'waiting_on', member: 'cora', reason: 'needs a call' },
    });
    await harness.curator.sweep();
    expect(sinks.lea?.injections).toHaveLength(0);
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
    // Parked by the AUTHORITY, not by the assignee or the verifier, so
    // both class-1 recipients are somebody other than the actor — an
    // actor is never addressed by their own act, and a fixture where
    // the parker is also a recipient cannot tell that rule from a
    // missing one.
    await post(app, '/spine/events', ANDREWJON, {
      kind: 'lifecycle',
      opId: 'op-park',
      expectedStateRev: 1,
      body: { contract, state: 'parked', preemptedBy: 'the incident' },
    });
    // The parking event itself IS delivered — it is the last thing
    // anybody needs to know about this contract, and silencing it
    // would mean a subscriber never learns the work stopped. It
    // reaches cora as a class-2 delta (she subscribed) and rune and lea
    // as class 1 (assignee and named verifier: `parked` means stop
    // work, and finding that out at your next orient means work done
    // against a contract that no longer wanted it).
    await harness.curator.sweep();
    expect(sinks.cora?.injections).toHaveLength(1);
    expect(sinks.rune?.injections).toHaveLength(1);
    expect(sinks.lea?.injections).toHaveLength(1);
    const afterPark = {
      cora: sinks.cora?.injections.length ?? 0,
      rune: sinks.rune?.injections.length ?? 0,
      lea: sinks.lea?.injections.length ?? 0,
    };

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
    // NOTHING MORE, for anybody. Silence is about what a parked
    // contract generates from here on, and it is silence for every
    // member and not only for the one the assertion names.
    expect(sinks.cora?.injections).toHaveLength(afterPark.cora);
    expect(sinks.rune?.injections).toHaveLength(afterPark.rune);
    expect(sinks.lea?.injections).toHaveLength(afterPark.lea);
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

  it('is NOT moved by a by-id read, so the events below it stay owed', async () => {
    // The defect this replaces, measured: reading ONE event by id took
    // the watermark from 1 to 4 and silently discharged the two
    // never-read authoritative events at 2 and 3. And the path is the
    // likely one — a class-1 line hands the member an event id, so
    // fetching that id is the natural next call.
    const contract = await authorContract();
    await get(app, '/spine/orient', RUNE);
    const readTo = harness.curatorStore.receipt('rune')?.seq as number;

    for (const [i, decision] of ['unmet', 'unmet'].entries()) {
      await post(app, '/spine/events', LEA, {
        kind: 'criterion_verdict',
        opId: `op-verdict-${i}`,
        expectedStateRev: 1 + i,
        revision: observed(`sha-${i}`),
        body: { contract, criterion: 'c1', decision, evidence: `run ${i}` },
      });
    }
    const events = (await get(app, `/spine/events?contract=${contract}`, ANDREWJON))
      .events as SpineEvent[];
    const newest = events.at(-1) as SpineEvent;
    expect(newest.seq).toBeGreaterThan(readTo + 1);

    const res = await app.request(`/spine/events/${newest.id}`, authed(RUNE));
    expect(res.status, 'the by-id read must still WORK').toBe(200);
    expect(harness.curatorStore.receipt('rune')?.seq, 'a by-id read moves no watermark').toBe(
      readTo,
    );

    // And the consequence that makes it matter: the unread middle is
    // still owed, so the nudge still fires.
    harness.clock.ms = T0 + 2 * HOUR;
    await harness.curator.sweep();
    expect((await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge')).toHaveLength(1);
  });

  it('advances a page read only through its LAST RETURNED seq', async () => {
    // A short page proves only as far as it got. Framing the receipt on
    // `headSeq` would mark a member caught up on a page they were never
    // sent.
    const contract = await authorContract();
    await get(app, '/spine/orient', RUNE);
    for (const [i, decision] of ['unmet', 'unmet', 'met'].entries()) {
      await post(app, '/spine/events', LEA, {
        kind: 'criterion_verdict',
        opId: `op-verdict-${i}`,
        expectedStateRev: 1 + i,
        revision: observed(`sha-${i}`),
        body: { contract, criterion: 'c1', decision, evidence: `run ${i}` },
      });
    }
    const page = (await get(app, '/spine/events?since_seq=1&limit=1', RUNE)) as {
      events: SpineEvent[];
      headSeq: number;
      nextCursor: number | null;
    };
    // A page-FULL property, not an id-absence one: limit 1 must return
    // exactly one, and there must be more behind it.
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect(page.headSeq).toBeGreaterThan(page.events[0]?.seq as number);
    expect(harness.curatorStore.receipt('rune')?.seq).toBe(page.events[0]?.seq);

    harness.clock.ms = T0 + 2 * HOUR;
    await harness.curator.sweep();
    expect(
      (await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge'),
      'everything beyond the page read is still owed',
    ).toHaveLength(1);
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

describe('a nudge is per lease EPOCH, and a member returning starts a new one', () => {
  it('re-arms for a member who was nudged into the void and came back', async () => {
    // The failure this closes: `nudged_at` is cleared only by a lease
    // grant, and a grant needs a CONFIRMED delivery — so the member who
    // could not be reached was exactly the member never reached again.
    // Permanently dark, for the offline floor population this design is
    // entirely for.
    const contract = await authorContract();
    await get(app, '/spine/orient', RUNE);
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'unmet', evidence: 'the ETag is missing' },
    });

    // rune goes offline: no sink, so nothing is confirmed to him.
    sinks.rune?.close();
    harness.clock.ms = T0 + 2 * HOUR;
    await harness.curator.sweep();
    const attempted = (await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge');
    expect(attempted, 'the nudge was attempted').toHaveLength(1);
    expect(attempted[0]?.delivered, 'and it did not land').toBe(false);

    // He comes back and ACTS without reading — the floor's own liveness
    // proof, needing no signal and no runner cooperation.
    //
    // The act deliberately names NO CONTRACT. An append that touches
    // the contract renews the lease, and a lease grant clears the
    // spent-nudge flag on its own — so a fixture using one would pass
    // with the epoch re-arm deleted, which is exactly what the first
    // draft of this test did (the mutation survived). A contract-less
    // discussion isolates the property: liveness proven, no lease
    // granted, no receipt moved.
    sinks.rune = harness.sinkFor('rune');
    harness.clock.ms = T0 + 3 * HOUR;
    await post(app, '/spine/events', RUNE, {
      kind: 'discussion',
      body: { body: 'back at this' },
    });
    harness.clock.ms = T0 + 6 * HOUR;
    await harness.curator.sweep();
    const after = (await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge');
    expect(after, 'a return is a new epoch').toHaveLength(2);
    expect(after[0]?.delivered, 'and this one landed').toBe(true);

    // Then silence again: one per epoch, not one per sweep.
    for (let hour = 7; hour <= 12; hour++) {
      harness.clock.ms = T0 + hour * HOUR;
      await harness.curator.sweep();
    }
    expect((await ledger(RUNE)).filter((r) => r.kind === 'recovery_nudge')).toHaveLength(2);
  });

  it('names what moved, with ids and titles and no outcome text', async () => {
    const contract = await authorContract();
    await get(app, '/spine/orient', RUNE);
    await post(app, '/spine/events', LEA, {
      kind: 'criterion_verdict',
      opId: 'op-verdict',
      expectedStateRev: 1,
      revision: observed('sha-a'),
      body: { contract, criterion: 'c1', decision: 'unmet', evidence: 'the ETag is missing' },
    });
    harness.clock.ms = T0 + 2 * HOUR;
    await harness.curator.sweep();
    const nudge = sinks.rune?.injections.at(-1)?.body ?? '';
    // A bare count is a line a member cannot triage — they cannot tell
    // the contract they are mid-way through from one they parked last
    // week, so the cheapest correct response is always a whole pack.
    expect(nudge).toContain(contract);
    expect(nudge).toContain('Ship the endpoint');
    // Still a POINTER, though.
    expect(nudge).toContain('orient');
    expect(nudge).not.toContain(CRITERION_TEXT);
    expect(nudge).not.toContain(OUTCOME_TEXT);
  });
});

describe('a lease is recorded on CONFIRMED delivery and on nothing less', () => {
  it('logs the injection but grants no lease when nothing took it', async () => {
    const contract = await authorContract();
    // cora has no sink in this arm, so the push reaches no live
    // subscriber. A lease granted here would be a claim that an offline
    // member holds something nothing ever handed them.
    sinks.cora?.close();
    await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      subject: 'repo:acme',
      opId: 'op-ask',
      expectedStateRev: 1,
      body: {
        authority: 'cora',
        question: ASK_QUESTION,
        context: ASK_CONTEXT,
        unblocks: 'the release cut',
        contract,
      },
    });
    const rows = await ledger(CORA);
    expect(rows, 'the spend is still accounted for').toHaveLength(1);
    expect(rows[0]?.delivered).toBe(false);
    expect(harness.curatorStore.leases('cora'), 'nothing confirmed, so nothing held').toEqual([]);

    // The positive control: with a sink, the same act grants the lease.
    sinks.cora = harness.sinkFor('cora');
    await post(app, '/spine/events', RUNE, {
      kind: 'ask',
      subject: 'repo:acme',
      opId: 'op-ask-2',
      expectedStateRev: 2,
      body: {
        authority: 'cora',
        question: ASK_QUESTION,
        context: ASK_CONTEXT,
        unblocks: 'the release cut',
        contract,
      },
    });
    expect(harness.curatorStore.leases('cora').map((l) => l.ref)).toEqual([contract]);
    expect((await ledger(CORA))[0]?.delivered).toBe(true);
  });
});

describe('a restarted curator does not replay the backlog', () => {
  it('starts its sweep cursor at the annex head', async () => {
    const contract = await authorContract();
    await app.request(
      '/spine/curator',
      authed(CORA, { subscription: { contract, level: 'all' } }, 'PUT'),
    );
    for (const [i, decision] of ['unmet', 'met'].entries()) {
      await post(app, '/spine/events', LEA, {
        kind: 'criterion_verdict',
        opId: `op-verdict-${i}`,
        expectedStateRev: 1 + i,
        revision: observed(`sha-${i}`),
        body: { contract, criterion: 'c1', decision, evidence: `run ${i}` },
      });
    }
    // A SECOND curator over the same stores — a process restart, with a
    // full backlog sitting unswept in front of it.
    const restarted = createCurator({
      annex: harness.spine,
      store: harness.curatorStore,
      broker: harness.broker,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      now: () => harness.clock.ms,
    });
    await restarted.sweep();
    expect(
      sinks.cora?.injections,
      'a restart must not deliver every delta since the team began',
    ).toHaveLength(0);

    // The positive control: it sweeps what happens AFTER it, so the
    // silence above is a cursor and not a dead curator.
    await post(app, '/spine/events', LEA, {
      kind: 'lifecycle',
      opId: 'op-wait',
      expectedStateRev: 3,
      body: { contract, state: 'waiting_on', member: 'andrewjon', reason: 'needs a call' },
    });
    await restarted.sweep();
    expect(sinks.cora?.injections).toHaveLength(1);
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

  it('pages BACKWARD through a full ledger and reaches the oldest row', async () => {
    // The defect this replaces: `WHERE id > ?` under `ORDER BY id
    // DESC`. It reads plausibly and cannot page — feeding back a page's
    // last id returns rows entirely NEWER than the page you just read,
    // and the older rows are unreachable at any page size.
    const contract = await authorContract();
    await get(app, '/spine/orient', RUNE);
    for (const [i, decision] of ['unmet', 'unmet', 'met', 'unmet'].entries()) {
      await post(app, '/spine/events', LEA, {
        kind: 'criterion_verdict',
        opId: `op-verdict-${i}`,
        expectedStateRev: 1 + i,
        revision: observed(`sha-${i}`),
        body: { contract, criterion: 'c1', decision, evidence: `run ${i}` },
      });
    }
    const all = await ledger(RUNE);
    expect(all.length, 'the fixture must be bigger than one page').toBe(5);
    expect(all.map((r) => r.id)).toEqual([...all.map((r) => r.id)].sort((a, b) => b - a));

    // Walk it two at a time and assert PAGE FULLNESS, not id-absence: a
    // short page while rows remain is the failure a "the id I paged
    // past is gone" assertion cannot see.
    const walked: number[] = [];
    let before: number | undefined;
    for (let page = 0; page < 10; page++) {
      const qs = before === undefined ? 'limit=2' : `limit=2&before_id=${before}`;
      const rows = (await get(app, `/spine/injections?${qs}`, RUNE)).injections as SpineInjection[];
      if (rows.length === 0) break;
      const remaining = all.length - walked.length;
      expect(rows.length, `page ${page} must be full while ${remaining} remain`).toBe(
        Math.min(2, remaining),
      );
      walked.push(...rows.map((r) => r.id));
      before = rows.at(-1)?.id;
    }
    // Every row, once, in order — including the oldest, which the
    // broken cursor could never reach.
    expect(walked).toEqual(all.map((r) => r.id));
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
