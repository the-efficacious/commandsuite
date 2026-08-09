/**
 * The interrupt whitelist: THE WHITELIST GATES THE PHONE, NOT THE QUEUE.
 *
 * §9/§6. Every addressed event is always in the durable queue — that is
 * free, it is a read — and every class-1 event still reaches a live
 * session over the WS fanout. The whitelist decides only which of them
 * ALSO spend the rarest budget there is: a push to a member who is away
 * from their screen. Conflating the two — gating the queue on the
 * whitelist — is #155 finding 1 wearing a new schema, so the tests below
 * assert BOTH directions of the gate while proving the queue item is
 * present either way.
 *
 * And the phone rides the EXISTING push path: the curator hands
 * `onPushed` the same message the broker push produced, `dispatchPush`
 * fans it out, and `shouldPush` applies its standing rules (never to a
 * live subscriber, never to the sender). The whitelist is one more gate
 * on top, not a second push path.
 */

import type { Message } from 'csuite-sdk/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchPush } from '../src/push/dispatch.js';
import { PushSubscriptionStore } from '../src/push/store.js';
import {
  ANDREWJON,
  authed,
  type CuratorApp,
  LEA,
  makeCuratorApp,
  post,
  RUNE,
  type Sink,
} from './helpers/spine-curator-app.js';

/** PUT the curator config for `member`, asserting a 200. */
async function putCurator(h: CuratorApp, token: string, body: unknown): Promise<void> {
  const res = await h.app.request('/spine/curator', authed(token, body, 'PUT'));
  if (res.status !== 200) {
    throw new Error(`PUT /spine/curator returned ${res.status}: ${await res.text()}`);
  }
}

// web-push mocked so no real network traffic happens — the same idiom
// push.test.ts uses. `vi.mock` is hoisted, so the spy is staged in
// `vi.hoisted`.
const mocks = vi.hoisted(() => {
  const sendNotification = vi.fn();
  const namespace = {
    sendNotification,
    generateVAPIDKeys: () => ({ publicKey: `BK${'A'.repeat(85)}`, privateKey: 'A'.repeat(43) }),
    setVapidDetails: vi.fn(),
    WebPushError: class extends Error {},
  };
  return { sendNotification, namespace };
});
vi.mock('web-push', () => ({ default: mocks.namespace, ...mocks.namespace }));
const sendNotification = mocks.sendNotification;

afterEach(() => {
  sendNotification.mockReset();
});

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** lea authors the contract rune is assigned; andrewjon is the authority. */
async function seedContract(h: CuratorApp): Promise<string> {
  await post(h.app, '/spine/subjects', LEA, { id: 'repo:acme', type: 'repo' });
  const spec = await post(h.app, '/spine/events', LEA, {
    kind: 'specification',
    subject: 'repo:acme',
    opId: 'op-spec',
    body: {
      title: 'Ship the endpoint',
      criteria: [{ id: 'c1', text: 'returns 200' }],
      assignee: 'rune',
      verifier: 'cora',
      authority: 'andrewjon',
    },
  });
  return (spec.event as { id: string }).id;
}

async function raiseAsk(h: CuratorApp, contract: string): Promise<string> {
  const res = await post(h.app, '/spine/events', RUNE, {
    kind: 'ask',
    subject: 'repo:acme',
    opId: 'op-ask',
    expectedStateRev: 1,
    body: {
      authority: 'andrewjon',
      question: 'ship on Friday?',
      context: 'tight window',
      unblocks: 'the 0.6 release',
      contract,
    },
  });
  return (res.event as { id: string }).id;
}

async function queueAsks(h: CuratorApp, member: string): Promise<unknown[]> {
  const res = await h.app.request(`/spine/queue?member=${member}`, {
    headers: { Authorization: `Bearer ${ANDREWJON}` },
  });
  const body = (await res.json()) as { queue: { asks: unknown[] } };
  return body.queue.asks;
}

// ─── The gate: same kind, same recipient, toggled by the whitelist ───

describe('the interrupt whitelist, both directions', () => {
  it('an on-list kind buzzes the phone, and the item is in the queue', async () => {
    const phone = vi.fn();
    const h = makeCuratorApp({ onPushed: phone });
    const contract = await seedContract(h);
    await raiseAsk(h, contract);

    // andrewjon's default whitelist includes `ask`, so the phone fired
    // once — with a DM to andrewjon from the system, exactly the shape
    // shouldPush treats as "push to this member and nobody else".
    expect(phone, 'a whitelisted ask must reach the phone path').toHaveBeenCalledTimes(1);
    const msg = phone.mock.calls[0]?.[0] as Message;
    expect(msg.to).toBe('andrewjon');
    expect(msg.from).toBe('csuite');
    // And the queue holds it regardless — the free read.
    expect(await queueAsks(h, 'andrewjon')).toHaveLength(1);
    h.db.close();
  });

  it('an off-list kind does NOT buzz the phone, and the item is STILL in the queue', async () => {
    const phone = vi.fn();
    const h = makeCuratorApp({ onPushed: phone });
    const contract = await seedContract(h);
    // andrewjon clears their whitelist: never buzz me. An empty array is
    // an authored choice, not a patch that leaves the default in place.
    await putCurator(h, ANDREWJON, { policy: { interruptWhitelist: [] } });
    await raiseAsk(h, contract);

    // Same kind, same recipient — the ONLY difference is the whitelist.
    expect(phone, 'an off-list kind must not spend the phone budget').not.toHaveBeenCalled();
    // But the queue still holds it: the whitelist never touches the queue.
    expect(
      await queueAsks(h, 'andrewjon'),
      'the queue item survives an empty whitelist',
    ).toHaveLength(1);
    h.db.close();
  });

  it('a proceeding past my ask reaches me — the whitelist’s other default', async () => {
    const phone = vi.fn();
    const h = makeCuratorApp({ onPushed: phone });
    const sink: Sink = h.sinkFor('andrewjon');
    const contract = await seedContract(h);
    const ask = await raiseAsk(h, contract);
    phone.mockClear();

    // rune (the asker) proceeds past their own open ask rather than
    // waiting for andrewjon's ruling. `proceeding` is on the default
    // whitelist, so the authority hears it — on the wire and on the phone.
    await post(h.app, '/spine/events', RUNE, {
      kind: 'proceeding',
      subject: 'repo:acme',
      opId: 'op-proceed',
      expectedStateRev: 2,
      body: { ask, reason: 'the CVE is exploitable today' },
    });

    expect(phone, 'a proceed past the ask must reach the authority’s phone').toHaveBeenCalledTimes(
      1,
    );
    // And the class-1 WS line reached andrewjon too.
    const lines = sink.injections.map((m) => m.body).join('\n');
    expect(lines).toContain('proceeded past your ask');
    sink.close();
    h.db.close();
  });

  it('reports the whitelist through GET /spine/curator, default and authored', async () => {
    const h = makeCuratorApp();
    // The team default, for a member who has authored nothing.
    const before = (await (
      await h.app.request('/spine/curator', {
        headers: { Authorization: `Bearer ${ANDREWJON}` },
      })
    ).json()) as { policy: { interruptWhitelist: string[]; explicit: boolean } };
    expect(before.policy.interruptWhitelist).toEqual(['ask', 'proceeding', 'focus']);
    expect(before.policy.explicit).toBe(false);

    // An authored choice: only criterion_verdict.
    await putCurator(h, ANDREWJON, { policy: { interruptWhitelist: ['criterion_verdict'] } });
    const after = (await (
      await h.app.request('/spine/curator', {
        headers: { Authorization: `Bearer ${ANDREWJON}` },
      })
    ).json()) as { policy: { interruptWhitelist: string[]; explicit: boolean } };
    expect(after.policy.interruptWhitelist).toEqual(['criterion_verdict']);
    expect(after.policy.explicit).toBe(true);
    h.db.close();
  });

  it('refuses a whitelist naming a kind that is not a kind', async () => {
    const h = makeCuratorApp();
    const res = await h.app.request('/spine/curator', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ANDREWJON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy: { interruptWhitelist: ['not_a_kind'] } }),
    });
    expect(res.status).toBe(400);
    h.db.close();
  });
});

// ─── End-to-end through the real dispatchPush + shouldPush ───────────

describe('the phone rides the existing shouldPush machinery', () => {
  /** Wire the curator's phone hook to the REAL dispatchPush, web-push mocked. */
  function makeWithRealPush(live: Set<string>) {
    // Late-bound so the closure can see the store + members the helper
    // builds; the holder is set before any push can fire.
    let deliver: ((m: Message) => void) | undefined;
    const h = makeCuratorApp({ onPushed: (m) => deliver?.(m) });
    const store = new PushSubscriptionStore(h.db);
    store.upsert({
      memberName: 'andrewjon',
      endpoint: 'https://fcm.example/andrewjon',
      p256dh: 'x',
      auth: 'x',
      userAgent: null,
    });
    deliver = (m: Message): void => {
      void dispatchPush(m, {
        sessions: store,
        members: h.members,
        logger: noopLogger,
        isLive: (name) => live.has(name),
      });
    };
    return h;
  }

  const flush = () => new Promise((r) => setImmediate(r));

  it('buzzes an OFFLINE whitelisted recipient (sendNotification fires)', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const h = makeWithRealPush(new Set()); // nobody live
    const contract = await seedContract(h);
    await raiseAsk(h, contract);
    await flush();
    expect(
      sendNotification,
      'an offline director on the whitelist gets a real push',
    ).toHaveBeenCalledTimes(1);
    h.db.close();
  });

  it('does NOT buzz a LIVE recipient — shouldPush’s live rule still holds', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const h = makeWithRealPush(new Set(['andrewjon'])); // andrewjon has a live tab
    const contract = await seedContract(h);
    await raiseAsk(h, contract);
    await flush();
    expect(
      sendNotification,
      'a whitelisted kind still must not buzz a member sitting in front of it',
    ).not.toHaveBeenCalled();
    h.db.close();
  });
});
