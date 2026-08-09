/**
 * The focus-set-running-dry interrupt (§9), deferred from phase 5 and
 * landed here.
 *
 * When the focus set transitions to EMPTY — the last lit contract leaves,
 * by an unlight OR by going terminal — the allocators (the `spine.focus`
 * holders who set the next one) get one class-1 line, gated on the phone
 * by `focus` in their interrupt whitelist. It is edge-triggered: empty →
 * empty says nothing, and re-emptying after a re-light fires again. A
 * curator-computed transition, on the fixture's injected clock.
 *
 * THE CAST: andrewjon holds every leaf but `spine.author`, so he is the
 * one allocator; rune holds nothing, so a transition rune causes is one
 * the allocator did not, and must hear about.
 */

import type { Message, SpineEvent, SpineInjection } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANDREWJON,
  authed,
  type CuratorApp,
  get,
  injectionText,
  LEA,
  makeCuratorApp,
  post,
  RUNE,
  type Sink,
} from './helpers/spine-curator-app.js';

let harness: CuratorApp;
let app: CuratorApp['app'];
let phone: ReturnType<typeof vi.fn<(m: Message) => void>>;
let andrewjonSink: Sink;

beforeEach(async () => {
  phone = vi.fn<(m: Message) => void>();
  harness = makeCuratorApp({ onPushed: phone });
  app = harness.app;
  andrewjonSink = harness.sinkFor('andrewjon');
  await post(app, '/spine/subjects', LEA, { id: 'repo:acme', type: 'repo' });
});

async function authorContract(opId: string): Promise<string> {
  const res = await post(app, '/spine/events', LEA, {
    kind: 'specification',
    subject: 'repo:acme',
    opId,
    body: {
      title: `Ship ${opId}`,
      criteria: [{ id: 'c1', text: 'the endpoint returns 200' }],
      assignee: 'rune',
      verifier: 'lea',
      authority: 'andrewjon',
    },
  });
  return (res.event as SpineEvent).id;
}

async function light(contract: string, expectedStateRev: number, opId: string): Promise<void> {
  await post(app, '/spine/events', ANDREWJON, {
    kind: 'focus',
    opId,
    expectedStateRev,
    body: { contract, lit: true, reason: 'this sprint' },
  });
}

/** rune cancels a contract — a non-allocator emptying the set by going terminal. */
async function cancel(contract: string, expectedStateRev: number, opId: string): Promise<void> {
  await post(app, '/spine/events', RUNE, {
    kind: 'lifecycle',
    opId,
    expectedStateRev,
    body: { contract, state: 'cancelled', reason: 'preempted for good' },
  });
}

async function runningDry(): Promise<SpineInjection[]> {
  const rows = (await get(app, '/spine/injections', ANDREWJON)).injections as SpineInjection[];
  return rows.filter((r) => r.kind === 'running_dry');
}

// ─────────────────────────────────────────────────────────────────────

describe('the focus set running dry', () => {
  it('fires one class-1 line to the allocator when the last lit contract leaves', async () => {
    const a = await authorContract('op-a');
    await light(a, 1, 'op-light-a'); // set = {a}
    // rune cancels it — a non-allocator empties the set by going terminal.
    await cancel(a, 2, 'op-cancel-a'); // set = {} → running dry

    const dry = await runningDry();
    expect(dry, 'the allocator is told the set ran dry').toHaveLength(1);
    expect(dry[0]?.class).toBe(1);
    // The line names the trigger and points at the plate — a pointer, not
    // a prescription; the system does not pick what to light next.
    const body = injectionText(andrewjonSink);
    expect(body).toContain('run dry');
    expect(body).toContain('orient');
    // The phone buzzed: `focus` is on andrewjon's default whitelist, and
    // this is the only class-1 kind in this test that is.
    expect(phone).toHaveBeenCalledTimes(1);
    expect((phone.mock.calls[0]?.[0] as { to: string }).to).toBe('andrewjon');
  });

  it('says nothing while the set is still non-empty — it fires on the emptying, not every shrink', async () => {
    const a = await authorContract('op-a');
    const b = await authorContract('op-b');
    await light(a, 1, 'op-light-a'); // set = {a}
    await light(b, 1, 'op-light-b'); // set = {a, b}

    // Cancel A — B is still lit, so the set is not empty.
    await cancel(a, 2, 'op-cancel-a'); // set = {b}
    expect(await runningDry(), 'a non-empty set is not dry').toHaveLength(0);

    // Cancel B — now it empties, and exactly now it fires, once.
    await cancel(b, 2, 'op-cancel-b'); // set = {}
    expect(await runningDry(), 'the emptying transition fires once').toHaveLength(1);
  });

  it('fires AGAIN after a re-light re-empties the set — per transition', async () => {
    const a = await authorContract('op-a');
    await light(a, 1, 'op-light-a');
    await cancel(a, 2, 'op-cancel-a'); // empty → fire 1
    expect(await runningDry()).toHaveLength(1);

    // A fresh contract, lit and then emptied again — a new transition.
    const b = await authorContract('op-b');
    await light(b, 1, 'op-light-b'); // non-empty again
    await cancel(b, 2, 'op-cancel-b'); // empty → fire 2
    expect(await runningDry(), 're-emptying after a re-light fires again').toHaveLength(2);
  });

  it('does not tell the allocator who emptied it themselves', async () => {
    const a = await authorContract('op-a');
    await light(a, 1, 'op-light-a');
    // andrewjon — the sole allocator — unlights the last contract himself.
    await app.request(
      '/spine/events',
      authed(ANDREWJON, {
        kind: 'focus',
        opId: 'op-unlight-a',
        expectedStateRev: 2,
        body: { contract: a, lit: false, reason: 'sprint over' },
      }),
    );
    // The set is empty, but the only allocator is the one who emptied it —
    // he already knows, so nobody is told. (Test 1 is the positive
    // control: when someone else empties it, he IS told.)
    expect(await runningDry()).toHaveLength(0);
    expect(phone).not.toHaveBeenCalled();
  });

  it('does not buzz the phone when the allocator has cleared `focus` from their whitelist', async () => {
    // The whitelist gates the PHONE, not the line: andrewjon still gets
    // the running-dry item, he just is not buzzed about it.
    await app.request(
      '/spine/curator',
      authed(ANDREWJON, { policy: { interruptWhitelist: ['ask'] } }, 'PUT'),
    );
    const a = await authorContract('op-a');
    await light(a, 1, 'op-light-a');
    await cancel(a, 2, 'op-cancel-a');

    expect(await runningDry(), 'the line is still delivered and logged').toHaveLength(1);
    expect(phone, 'but focus is off his whitelist, so no phone').not.toHaveBeenCalled();
  });
});
