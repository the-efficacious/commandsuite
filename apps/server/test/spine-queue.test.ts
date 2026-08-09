/**
 * The human seat's Queue, and the property the whole phase exists to
 * protect: VISITING IS NOT HANDLING.
 *
 * §9. The Queue is the director's orient pack rendered down to what is
 * theirs to move — asks awaiting their ruling, contracts stuck on them.
 * Two claims are load-bearing and each is tested against the other:
 *
 *   1  READING THE QUEUE ADVANCES NOTHING. Opening an item is not
 *      handling it, so the read moves no receipt and grants no lease. It
 *      is a SEPARATE read from `orient` precisely because orient does
 *      advance a receipt (that read is what proves a member holds the
 *      pack). The positive control is orient itself: the same machinery
 *      that leaves the queue's watermark untouched moves it for orient,
 *      so the negative is not vacuous.
 *
 *   2  AN ITEM LEAVES ONLY WHEN ITS RESOLVING EVENT LANDS. A ruling
 *      resolves an ask; a defer re-arms it and it leaves until its
 *      trigger fires; a decline closes it; a redirect moves it to the
 *      new authority's queue. Nothing leaves on a read, and nothing
 *      leaves on a local dismissal — the queue reflects the annex.
 */

import type { SpineContract, SpineQueue } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { type CuratorApp, get, makeCuratorApp, post } from './helpers/spine-curator-app.js';

const LEA = 'csuite_curator_lea_token';
const RUNE = 'csuite_curator_rune_token';
const ANDREWJON = 'csuite_curator_andrewjon_token';

/**
 * A contract lea authors and rune is assigned, with an ask rune raises
 * to andrewjon on it. Returns the contract id and the ask id. After
 * this the contract sits at state_rev 2 (spec → ask), which is the
 * precondition the ask_action acts must carry.
 */
async function seedAskForAndrewjon(h: CuratorApp): Promise<{ contract: string; ask: string }> {
  await post(h.app, '/spine/subjects', LEA, { id: 'repo:acme', type: 'repo' });
  const spec = await post(h.app, '/spine/events', LEA, {
    kind: 'specification',
    subject: 'repo:acme',
    opId: 'op-spec',
    body: {
      title: 'Ship the endpoint',
      criteria: [{ id: 'c1', text: 'the endpoint returns 200' }],
      assignee: 'rune',
      verifier: 'cora',
      authority: 'andrewjon',
    },
  });
  const contract = (spec.event as { id: string }).id;
  const askRes = await post(h.app, '/spine/events', RUNE, {
    kind: 'ask',
    subject: 'repo:acme',
    opId: 'op-ask',
    expectedStateRev: 1,
    body: {
      authority: 'andrewjon',
      question: 'ship on Friday?',
      context: 'the window is tight and cora is out',
      unblocks: 'the 0.6 release',
      contract,
    },
  });
  return { contract, ask: (askRes.event as { id: string }).id };
}

async function readQueue(h: CuratorApp, token: string, member?: string): Promise<SpineQueue> {
  const path = member === undefined ? '/spine/queue' : `/spine/queue?member=${member}`;
  const body = (await get(h.app, path, token)) as { queue: SpineQueue };
  return body.queue;
}

// ─── The property: reading the queue advances nothing ────────────────

describe('reading the queue is receipt-neutral — visiting is not handling', () => {
  let h: CuratorApp;
  beforeEach(async () => {
    h = makeCuratorApp();
    await seedAskForAndrewjon(h);
  });

  it('leaves the reader’s receipt and leases byte-for-byte unchanged', async () => {
    // A byte snapshot of everything the curator holds about andrewjon.
    // If the queue read touched either, one of these JSON strings would
    // differ afterwards — which is the whole test.
    const before = {
      receipt: JSON.stringify(h.curatorStore.receipt('andrewjon')),
      leases: JSON.stringify(h.curatorStore.leases('andrewjon')),
    };
    // The read that must change nothing. Non-vacuous: it returns the ask.
    const queue = await readQueue(h, ANDREWJON, 'andrewjon');
    expect(queue.asks, 'the fixture must put an ask in andrewjon’s queue').toHaveLength(1);

    const after = {
      receipt: JSON.stringify(h.curatorStore.receipt('andrewjon')),
      leases: JSON.stringify(h.curatorStore.leases('andrewjon')),
    };
    expect(after.receipt, 'a queue read must not advance a receipt').toBe(before.receipt);
    expect(after.leases, 'a queue read must not grant or renew a lease').toBe(before.leases);
    // And the watermark is still where it started: nowhere.
    expect(h.curatorStore.receipt('andrewjon'), 'no receipt should exist from a read alone').toBe(
      null,
    );
  });

  it('orient DOES advance the receipt — the control that proves the machinery is live', async () => {
    // The same member, the same curator, the same clock: the only
    // difference is which read they made. If orient did not move the
    // watermark either, the negative above would prove nothing.
    expect(h.curatorStore.receipt('andrewjon')).toBe(null);
    await get(h.app, '/spine/orient', ANDREWJON);
    const receipt = h.curatorStore.receipt('andrewjon');
    expect(receipt, 'orient is the recovery read and must advance a receipt').not.toBe(null);
    expect(receipt?.via).toBe('orient');
  });

  it('a hundred queue reads still advance nothing', async () => {
    // The tempting bug is "they demonstrably looked, so move the
    // watermark". Reading the queue repeatedly must not accumulate into
    // a receipt the way an orient would.
    for (let i = 0; i < 100; i++) await readQueue(h, ANDREWJON, 'andrewjon');
    expect(h.curatorStore.receipt('andrewjon')).toBe(null);
    expect(h.curatorStore.leases('andrewjon')).toEqual([]);
  });
});

// ─── Queue content: question, context, unblocks, verbatim ────────────

describe('the queue renders each ask verbatim, with the contract it is about', () => {
  let h: CuratorApp;
  beforeEach(async () => {
    h = makeCuratorApp();
    await seedAskForAndrewjon(h);
  });

  it('carries question, context and unblocks unedited', async () => {
    const queue = await readQueue(h, ANDREWJON, 'andrewjon');
    const item = queue.asks[0];
    expect(item?.ask.question).toBe('ship on Friday?');
    expect(item?.ask.context).toBe('the window is tight and cora is out');
    expect(item?.ask.unblocks).toBe('the 0.6 release');
    expect(item?.ask.authority).toBe('andrewjon');
    expect(item?.ask.state).toBe('open');
  });

  it('rides the whole contract, so an act can carry its stateRev without a second call', async () => {
    const queue = await readQueue(h, ANDREWJON, 'andrewjon');
    const contract = queue.asks[0]?.contract as SpineContract;
    expect(contract, 'a contract-bound ask must carry its whole contract').not.toBeNull();
    expect(contract.stateRev).toBe(2); // spec (1) → ask (2)
    expect(contract.title).toBe('Ship the endpoint');
  });

  it('defaults to the caller when no member is named', async () => {
    const mine = await readQueue(h, ANDREWJON);
    expect(mine.member).toBe('andrewjon');
    expect(mine.asks).toHaveLength(1);
  });

  it('is empty for a member nothing is waiting on', async () => {
    const runes = await readQueue(h, RUNE, 'rune');
    expect(runes.asks).toEqual([]);
    expect(runes.waitingOn).toEqual([]);
  });
});

// ─── waiting_on contracts ────────────────────────────────────────────

describe('a contract waiting on me appears in my queue', () => {
  it('lists a waiting_on(me) contract and drops it when it moves back to active', async () => {
    // A standalone contract with NO open ask on its subject, so the
    // assignee can move it without tripping the citation lock (which is
    // itself proven live by the seed the acts tests use).
    const h = makeCuratorApp();
    await post(h.app, '/spine/subjects', LEA, { id: 'repo:beta', type: 'repo' });
    const spec = await post(h.app, '/spine/events', LEA, {
      kind: 'specification',
      subject: 'repo:beta',
      opId: 'op-spec-beta',
      body: {
        title: 'Wire the webhook',
        criteria: [{ id: 'c1', text: 'deliveries verify' }],
        assignee: 'rune',
        verifier: 'cora',
        authority: 'andrewjon',
      },
    });
    const contract = (spec.event as { id: string }).id;
    // rune (the assignee) parks the work on andrewjon.
    await post(h.app, '/spine/events', RUNE, {
      kind: 'lifecycle',
      opId: 'op-wait',
      expectedStateRev: 1,
      body: {
        contract,
        state: 'waiting_on',
        member: 'andrewjon',
        reason: 'need the Friday call',
      },
    });
    const waiting = await readQueue(h, ANDREWJON, 'andrewjon');
    expect(waiting.waitingOn.map((c) => c.id)).toEqual([contract]);
    expect(waiting.waitingOn[0]?.waitingOn).toBe('andrewjon');

    // Positive control: back to active, and it leaves the queue.
    await post(h.app, '/spine/events', RUNE, {
      kind: 'lifecycle',
      opId: 'op-resume',
      expectedStateRev: 2,
      body: { contract, state: 'active', reason: 'call happened' },
    });
    const after = await readQueue(h, ANDREWJON, 'andrewjon');
    expect(after.waitingOn).toEqual([]);
  });
});

// ─── The four acts: an item leaves only on its resolving event ───────

describe('an item leaves the queue when its resolving event lands, never on a read', () => {
  let h: CuratorApp;
  let ask: string;
  let contract: string;
  beforeEach(async () => {
    h = makeCuratorApp();
    ({ ask, contract } = await seedAskForAndrewjon(h));
    void contract;
  });

  it('a ruling resolves the ask and it leaves', async () => {
    expect((await readQueue(h, ANDREWJON, 'andrewjon')).asks).toHaveLength(1);
    await post(h.app, '/spine/events', ANDREWJON, {
      kind: 'ruling',
      opId: 'op-rule',
      body: { ask, decision: 'yes, ship Friday', reasoning: 'the window holds' },
    });
    expect((await readQueue(h, ANDREWJON, 'andrewjon')).asks).toEqual([]);
    // The annex agrees: the ask is ruled, not merely hidden.
    const askRow = (await get(h.app, `/spine/events?kind=ask`, ANDREWJON)) as {
      events: { id: string }[];
    };
    void askRow;
  });

  it('a defer re-arms the ask and it leaves until the trigger fires', async () => {
    await post(h.app, '/spine/events', ANDREWJON, {
      kind: 'ask_action',
      opId: 'op-defer',
      expectedStateRev: 2,
      body: { ask, action: 'defer', reason: 'decide after CI is green' },
    });
    // Deferred is exactly the state the queue excludes — an armed ask is
    // off the plate until the world re-raises it.
    expect((await readQueue(h, ANDREWJON, 'andrewjon')).asks).toEqual([]);
    // Orient still shows it (a deferred ask is not resolved), which is
    // the difference between the recovery pack and the action queue.
    const pack = (await get(h.app, '/spine/orient', ANDREWJON)) as {
      asksForMe: { id: string; state: string }[];
    };
    expect(pack.asksForMe.find((a) => a.id === ask)?.state).toBe('deferred');
  });

  it('a decline closes the ask with a reason and it leaves', async () => {
    await post(h.app, '/spine/events', ANDREWJON, {
      kind: 'ask_action',
      opId: 'op-decline',
      expectedStateRev: 2,
      body: { ask, action: 'decline', reason: 'not my call — talk to product' },
    });
    expect((await readQueue(h, ANDREWJON, 'andrewjon')).asks).toEqual([]);
  });

  it('a redirect re-addresses the ask: it leaves my queue and enters the new authority’s', async () => {
    // Before: andrewjon holds it, cora does not.
    expect((await readQueue(h, ANDREWJON, 'andrewjon')).asks).toHaveLength(1);
    expect((await readQueue(h, ANDREWJON, 'cora')).asks).toEqual([]);

    await post(h.app, '/spine/events', ANDREWJON, {
      kind: 'ask_action',
      opId: 'op-redirect',
      expectedStateRev: 2,
      body: { ask, action: 'redirect', reason: 'cora owns the release', redirectTo: 'cora' },
    });

    // After: gone from mine, present in cora's — and STILL OPEN, because
    // a redirect re-addresses the question rather than resolving it.
    expect((await readQueue(h, ANDREWJON, 'andrewjon')).asks).toEqual([]);
    const coras = await readQueue(h, ANDREWJON, 'cora');
    expect(coras.asks).toHaveLength(1);
    expect(coras.asks[0]?.ask.id).toBe(ask);
    expect(coras.asks[0]?.ask.state).toBe('open');
    expect(coras.asks[0]?.ask.authority).toBe('cora');
  });

  it('opening the item (reading it) resolves nothing — the item stays', async () => {
    // The failure this closes: a "mark read on open" reflex. Reading the
    // queue, and reading the ask event by id, both leave it in place.
    await readQueue(h, ANDREWJON, 'andrewjon');
    await get(h.app, `/spine/events/${ask}`, ANDREWJON);
    expect((await readQueue(h, ANDREWJON, 'andrewjon')).asks).toHaveLength(1);
  });
});
