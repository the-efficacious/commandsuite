/**
 * The probe engine, end to end.
 *
 * §7's claim is a chain, and every link is somewhere a defect can hide:
 * a member authors a recipe inside the thing it discharges → a signed
 * delivery reaches the inbox → HMAC and dedupe accept it → the member's
 * predicate matches → an observation lands with honest provenance → the
 * thing the check was armed on discharges → exactly one line reaches
 * exactly one member. So the suite drives the whole chain through HTTP
 * wherever HTTP is what a member would use, and asserts SHAPE — the
 * whole caption, the exact line — rather than presence.
 *
 * Every negative here has its positive control beside it, and several
 * of the positives exist only for that reason: "predicate false lands
 * nothing" is satisfied by an engine that never fires at all.
 */

import type { SpineAsk, SpineCheck, SpineContract, SpineEvent } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createAnnexWritePath } from '../src/spine/index.js';
import { sliceOf } from '../src/spine/probes.js';
import { createSqliteAnnexStore } from '../src/spine/store.js';
import {
  authed,
  HOOK_SLUG,
  jsonResponse,
  makeProbeApp,
  type ProbeApp,
  scriptedFetch,
  settle,
  signedHook,
} from './helpers/spine-probe-app.js';

let ctx: ProbeApp;

/** A green CI payload, in roughly GitHub's shape. */
const GREEN = {
  action: 'completed',
  check_run: { conclusion: 'success', head_sha: 'sha-green', name: 'build' },
  repository: { full_name: 'acme/api' },
};
const RED = {
  action: 'completed',
  check_run: { conclusion: 'failure', head_sha: 'sha-red', name: 'build' },
  repository: { full_name: 'acme/api' },
};

/** The recipe a member writes into an ask's `check` field. */
const CI_RECIPE = JSON.stringify({
  kind: 'webhook',
  endpoint: HOOK_SLUG,
  when: [{ path: 'check_run.conclusion', op: 'eq', value: 'success' }],
  revisionPath: 'check_run.head_sha',
});

async function post(app: ProbeApp, who: string, body: unknown): Promise<Response> {
  return app.app.request('/spine/events', authed(tokenFor(who), body));
}

function tokenFor(who: string): string {
  return `csuite_probe_${who}_token`;
}

async function registerSubject(app: ProbeApp, id: string, type = 'repo'): Promise<void> {
  const res = await app.app.request('/spine/subjects', authed(tokenFor('lea'), { id, type }));
  expect(res.status, await res.text()).toBe(201);
}

/** A contract lea authors, rune assigned. Returns its id. */
async function authorContract(app: ProbeApp, subject = 'repo:acme'): Promise<string> {
  const res = await post(app, 'lea', {
    kind: 'specification',
    subject,
    opId: `spec-${Math.random()}`,
    body: {
      title: 'Ship the endpoint',
      criteria: [{ id: 'c1', text: 'returns 200' }],
      assignee: 'rune',
      verifier: 'lea',
      authority: 'andrewjon',
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { event: SpineEvent }).event.id;
}

async function contractOf(app: ProbeApp, id: string): Promise<SpineContract> {
  const res = await app.app.request(`/spine/contracts/${id}`, authed(tokenFor('lea')));
  return ((await res.json()) as { contract: SpineContract }).contract;
}

async function askOf(app: ProbeApp, id: string): Promise<SpineAsk> {
  const events = await listEvents(app);
  const ask = events.find((e) => e.id === id);
  expect(ask?.kind).toBe('ask');
  const packs = await app.app.request('/spine/orient', authed(tokenFor('andrewjon')));
  const pack = (await packs.json()) as { asksForMe: SpineAsk[]; myOpenAsks: SpineAsk[] };
  const found = [...pack.asksForMe, ...pack.myOpenAsks].find((a) => a.id === id);
  // `orient` only carries UNRESOLVED asks, so a discharged one has to
  // come off the store — which is also the honest read of "did it
  // leave the authority's queue".
  return found ?? (app.annex.ask(id) as SpineAsk);
}

async function listEvents(app: ProbeApp): Promise<SpineEvent[]> {
  const res = await app.app.request('/spine/events?limit=500', authed(tokenFor('lea')));
  return ((await res.json()) as { events: SpineEvent[] }).events;
}

async function listChecks(app: ProbeApp): Promise<SpineCheck[]> {
  const res = await app.app.request('/spine/checks', authed(tokenFor('rune')));
  expect(res.status).toBe(200);
  return ((await res.json()) as { checks: SpineCheck[] }).checks;
}

/** An ask by lea to andrewjon, armed with `recipe`. Returns the ask event id. */
async function armedAsk(
  app: ProbeApp,
  recipe: string | undefined,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return post(app, 'lea', {
    kind: 'ask',
    subject: 'repo:acme',
    opId: `ask-${Math.random()}`,
    body: {
      authority: 'andrewjon',
      question: 'may we cut the release once CI is green?',
      context: 'the branch is ready; only the build is outstanding',
      unblocks: 'the 0.6 release',
      ...(recipe === undefined ? {} : { check: recipe }),
      ...extra,
    },
  });
}

async function deliver(app: ProbeApp, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const res = await app.app.request(`/hooks/${HOOK_SLUG}`, signedHook(body));
  await settle();
  return res;
}

beforeEach(() => {
  ctx = makeProbeApp();
});

// ─── Arming ──────────────────────────────────────────────────────────

describe('a check is born from the event that carries it', () => {
  it('arms from an ask, with the whole provenance shape', async () => {
    await registerSubject(ctx, 'repo:acme');
    const res = await armedAsk(ctx, CI_RECIPE);
    expect(res.status, await res.clone().text()).toBe(201);
    const askId = ((await res.json()) as { event: SpineEvent }).event.id;

    const checks = await listChecks(ctx);
    expect(checks).toHaveLength(1);
    const check = checks[0] as SpineCheck;
    // WHOLE, not field-by-field. A caption that is right in four
    // places and wrong in the fifth is the failure this shape exists
    // to make impossible to miss.
    expect({
      sourceEvent: check.sourceEvent,
      carrier: check.carrier,
      subject: check.subject,
      contract: check.contract,
      ask: check.ask,
      authoredBy: check.authoredBy,
      state: check.state,
      firedEvent: check.firedEvent,
      recipe: check.recipe,
    }).toEqual({
      sourceEvent: askId,
      carrier: 'ask',
      subject: 'repo:acme',
      contract: null,
      ask: askId,
      // The ASKER, not the authority: the member who wrote the recipe
      // is the member the photograph will be attributed to.
      authoredBy: 'lea',
      state: 'armed',
      firedEvent: null,
      recipe: JSON.parse(CI_RECIPE),
    });
  });

  it('arms from a lifecycle moving a contract to waiting_for', async () => {
    await registerSubject(ctx, 'repo:acme');
    const contract = await authorContract(ctx);
    const res = await post(ctx, 'rune', {
      kind: 'lifecycle',
      opId: 'life-1',
      expectedStateRev: 1,
      body: {
        contract,
        state: 'waiting_for',
        event: 'the CI build on this branch',
        check: CI_RECIPE,
      },
    });
    expect(res.status, await res.clone().text()).toBe(201);

    const checks = await listChecks(ctx);
    expect(checks).toHaveLength(1);
    expect({
      carrier: checks[0]?.carrier,
      contract: checks[0]?.contract,
      ask: checks[0]?.ask,
      authoredBy: checks[0]?.authoredBy,
      subject: checks[0]?.subject,
    }).toEqual({
      carrier: 'waiting_for',
      contract,
      ask: null,
      authoredBy: 'rune',
      subject: 'repo:acme',
    });
  });

  it('leaves prose as prose: it arms nothing and refuses nothing', async () => {
    // The positive control for every refusal below. A store that
    // refused prose would break every ask phase 2 could author, and
    // the refusals would all still pass.
    await registerSubject(ctx, 'repo:acme');
    const res = await armedAsk(ctx, 'when CI goes green on the release branch');
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await listChecks(ctx)).toEqual([]);
  });

  it('refuses a declaration it cannot arm, and the ask does not land', async () => {
    await registerSubject(ctx, 'repo:acme');
    const before = (await listEvents(ctx)).length;
    const res = await armedAsk(ctx, '{"kind":"webhook"');
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('not valid JSON'),
    });
    expect(
      (await listEvents(ctx)).length,
      'a refused append must leave the annex exactly as it was',
    ).toBe(before);
  });

  it('refuses a recipe pointing nowhere — a flash is always OF somewhere', async () => {
    // No subject on the ask and no contract named: the observation it
    // would produce would be of nothing.
    const res = await post(ctx, 'lea', {
      kind: 'ask',
      opId: 'ask-nowhere',
      body: {
        authority: 'andrewjon',
        question: 'q',
        context: 'c',
        unblocks: 'u',
        check: CI_RECIPE,
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('of nowhere');
  });

  it('supersedes a prior arming when a defer re-arms the same ask', async () => {
    await registerSubject(ctx, 'repo:acme');
    const askRes = await armedAsk(ctx, CI_RECIPE);
    const askId = ((await askRes.json()) as { event: SpineEvent }).event.id;
    const deferred = await post(ctx, 'andrewjon', {
      kind: 'ask_action',
      opId: 'defer-1',
      body: {
        ask: askId,
        action: 'defer',
        reason: 'come back when the build has run',
        trigger: CI_RECIPE,
      },
    });
    expect(deferred.status, await deferred.clone().text()).toBe(201);

    const checks = await listChecks(ctx);
    expect(checks).toHaveLength(2);
    // ONE ANSWER, still. The first arming is superseded rather than
    // left running beside the second — two cameras on one ask would
    // make "did the thing I armed happen" ambiguous.
    expect(checks.filter((c) => c.state === 'armed')).toHaveLength(1);
    expect(checks.find((c) => c.state === 'disarmed')?.disarmedReason).toContain(
      'superseded by a new arming',
    );
    expect(checks.find((c) => c.state === 'armed')?.authoredBy).toBe('andrewjon');
  });
});

// ─── The http_poll security pins, at authoring ──────────────────────

describe('an http_poll recipe is refused at the keyboard, not at fire time', () => {
  const poll = (patch: Record<string, unknown>): string =>
    JSON.stringify({
      kind: 'http_poll',
      url: 'https://ci.example.com/status',
      intervalMs: 300_000,
      when: [{ path: 'state', op: 'eq', value: 'green' }],
      ...patch,
    });

  beforeEach(async () => {
    await registerSubject(ctx, 'repo:acme');
  });

  it('accepts a compliant recipe — the positive control for every pin', async () => {
    const res = await armedAsk(ctx, poll({}));
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await listChecks(ctx)).toHaveLength(1);
  });

  it('refuses an http:// URL', async () => {
    const res = await armedAsk(ctx, poll({ url: 'http://ci.example.com/status' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('cleartext');
  });

  it('refuses a non-absolute URL and a non-http scheme', async () => {
    for (const url of ['/status', 'file:///etc/passwd', 'ftp://ci.example.com/x']) {
      const res = await armedAsk(ctx, poll({ url }));
      expect(res.status, `${url} must be refused`).toBe(400);
    }
  });

  it('refuses an interval under the floor, and accepts the floor itself', async () => {
    expect((await armedAsk(ctx, poll({ intervalMs: 59_999 }))).status).toBe(400);
    // THE NEAREST VALID THING. A rule tested only by what it rejects
    // passes just as happily against one that rejects everything.
    expect((await armedAsk(ctx, poll({ intervalMs: 60_000 }))).status).toBe(201);
  });

  it('refuses a secret written as a value rather than named as a slug', async () => {
    // The pin is that a token can never enter a permanent event. A
    // slug-shaped name is accepted; anything carrying the shape of a
    // credential is not.
    expect((await armedAsk(ctx, poll({ authSecret: 'ghp_AbC123XYZ' }))).status).toBe(400);
    expect((await armedAsk(ctx, poll({ authSecret: 'ci-token' }))).status).toBe(201);
  });

  it('refuses a predicate that is not filter rules', async () => {
    expect((await armedAsk(ctx, poll({ when: 'conclusion == success' }))).status).toBe(400);
    expect((await armedAsk(ctx, poll({ when: [{ path: 'x', op: 'wat' }] }))).status).toBe(400);
    // Empty rules are legitimate: "any delivery at all" is a real
    // thing to arm, and refusing it would be the validity check doing
    // too much.
    expect((await armedAsk(ctx, poll({ when: [] }))).status).toBe(201);
  });
});

// ─── The ask discharge, end to end ──────────────────────────────────

describe('a check firing on an ask discharges it, and nobody typed anything', () => {
  let askId: string;

  beforeEach(async () => {
    await registerSubject(ctx, 'repo:acme');
    const res = await armedAsk(ctx, CI_RECIPE);
    askId = ((await res.json()) as { event: SpineEvent }).event.id;
  });

  it('lands one observation with the whole provenance caption', async () => {
    await deliver(ctx, GREEN);

    const observations = (await listEvents(ctx)).filter((e) => e.kind === 'observation');
    expect(observations).toHaveLength(1);
    const obs = observations[0] as SpineEvent;
    const check = (await listChecks(ctx))[0] as SpineCheck;

    expect({
      kind: obs.kind,
      class: obs.class,
      actor: obs.actor,
      authoredBy: obs.authoredBy,
      subject: obs.subject,
      staplesTo: obs.staplesTo,
      revision: obs.revision === null ? null : { ...obs.revision, id: '<id>' },
    }).toEqual({
      kind: 'observation',
      class: 'ambient',
      // The camera and the photographer, both, permanently.
      actor: `probe:${check.id}`,
      authoredBy: 'lea',
      subject: 'repo:acme',
      staplesTo: askId,
      revision: {
        id: '<id>',
        subject: 'repo:acme',
        value: 'sha-green',
        // OBSERVED. The probe looked; nobody is recounting.
        how: 'observed',
        source: `probe:${check.id}`,
        at: expect.any(String),
      },
    });

    // The slice is the paths the member's own predicate named, so a
    // reader can check the claim rather than take it.
    const body = obs.body as { what: string; output: string };
    expect(body.what).toBe(`check ${check.id}, armed by lea, fired on webhook ${HOOK_SLUG}`);
    expect(JSON.parse(body.output)).toEqual({
      'check_run.conclusion': 'success',
      'check_run.head_sha': 'sha-green',
    });
  });

  it('closes the ask as discharged, citing the observation', async () => {
    await deliver(ctx, GREEN);
    const obs = (await listEvents(ctx)).find((e) => e.kind === 'observation') as SpineEvent;
    const ask = await askOf(ctx, askId);
    expect({ state: ask.state, resolvedBy: ask.resolvedBy }).toEqual({
      state: 'discharged',
      resolvedBy: obs.id,
    });

    // AND IT LEFT THE AUTHORITY'S QUEUE, which is the point of the
    // class: andrewjon never typed a thing.
    const pack = await ctx.app.request('/spine/orient', authed(tokenFor('andrewjon')));
    const body = (await pack.json()) as { asksForMe: SpineAsk[] };
    expect(body.asksForMe.map((a) => a.id)).not.toContain(askId);
  });

  it('tells the asker AND the authority when the asker armed the check', async () => {
    const lea = ctx.sinkFor('lea');
    const andrewjon = ctx.sinkFor('andrewjon');
    await deliver(ctx, GREEN);
    await settle();

    const obs = (await listEvents(ctx)).find((e) => e.kind === 'observation') as SpineEvent;
    const check = (await listChecks(ctx))[0] as SpineCheck;

    expect(lea.injections).toHaveLength(1);
    // THE EXACT LINE. This is the deliverable a member actually sees,
    // so it is asserted whole rather than grepped for a substring.
    expect((lea.injections[0]?.body ?? '').split('Since seq')[0]).toBe(
      `spine: observation ${obs.id} by probe:${check.id} — the check you armed fired — ` +
        `this ask is discharged, nobody had to answer it. On subject repo:acme. ` +
        `ask ${askId} is discharged, resolved by this observation. `,
    );
    expect(lea.injections[0]?.body).toContain('run `orient` for the pack');

    // AND THE AUTHORITY, because LEA armed this check. andrewjon was
    // asked to decide something and the decision was taken off their
    // queue by a mechanism they never saw. Being silently released
    // from a decision somebody asked you to make is not the absence of
    // news, and the record of what released you is a photograph they
    // can go and look at.
    expect(andrewjon.injections).toHaveLength(1);
    expect((andrewjon.injections[0]?.body ?? '').split('Since seq')[0]).toBe(
      `spine: observation ${obs.id} by probe:${check.id} — an ask you were asked to rule on ` +
        `discharged itself — the asker armed a check and the world answered it, so this is off ` +
        `your queue without you deciding anything. On subject repo:acme. ` +
        `ask ${askId} is discharged, resolved by this observation. `,
    );

    // AND IT IS ON THE LEDGER. "What did the system spend of my album
    // this week" has to include what a probe spent, or the account is
    // complete only for the injections a member could already see
    // coming.
    const ledger = (await (
      await ctx.app.request('/spine/injections', authed(tokenFor('lea')))
    ).json()) as {
      injections: { class: number; kind: string; refs: string[]; delivered: boolean }[];
    };
    const discharge = ledger.injections.filter((row) => row.refs.includes(obs.id));
    expect(discharge).toHaveLength(1);
    expect({
      class: discharge[0]?.class,
      kind: discharge[0]?.kind,
      delivered: discharge[0]?.delivered,
    }).toEqual({ class: 1, kind: 'addressed', delivered: true });

    lea.close();
    andrewjon.close();
  });

  it('tells the asker ALONE when the authority armed it by deferring', async () => {
    // The other side of the split, and the control on it. andrewjon
    // deferred with a trigger, so andrewjon CHOSE this mechanism: the
    // queue item going away is the thing they asked for, and telling
    // them about it is the ceremony §10 forbids by name.
    const deferred = await post(ctx, 'andrewjon', {
      kind: 'ask_action',
      opId: 'defer-arm',
      body: {
        ask: askId,
        action: 'defer',
        reason: 'come back when the build has run',
        trigger: CI_RECIPE,
      },
    });
    expect(deferred.status, await deferred.clone().text()).toBe(201);
    const lea = ctx.sinkFor('lea');
    const andrewjon = ctx.sinkFor('andrewjon');
    await deliver(ctx, GREEN);
    await settle();

    const armed = (await listChecks(ctx)).find((c) => c.state === 'fired') as SpineCheck;
    expect(armed.authoredBy, 'the defer is what armed the firing check').toBe('andrewjon');
    expect(lea.injections).toHaveLength(1);
    expect(andrewjon.injections).toHaveLength(0);
    lea.close();
    andrewjon.close();
  });

  it('predicate false lands nothing at all — with its positive control', async () => {
    const lea = ctx.sinkFor('lea');
    await deliver(ctx, RED);

    expect((await listEvents(ctx)).filter((e) => e.kind === 'observation')).toEqual([]);
    expect((await askOf(ctx, askId)).state).toBe('open');
    expect(lea.injections).toHaveLength(0);
    // The check is still armed, and the ENGINE DID LOOK: the
    // evaluation stamp is the only trace a failed shot leaves.
    const after = (await listChecks(ctx))[0] as SpineCheck;
    expect(after.state).toBe('armed');
    expect(after.lastEvaluatedAt).not.toBeNull();

    // The positive control, on the same check and the same endpoint:
    // the shot the member composed comes out, and everything lands.
    await deliver(ctx, GREEN);
    expect((await listEvents(ctx)).filter((e) => e.kind === 'observation')).toHaveLength(1);
    expect(lea.injections).toHaveLength(1);
    lea.close();
  });

  it('claims the shutter atomically: only the first caller wins', async () => {
    // TWO MECHANISMS HOLD "one fire per arming" and only one of them is
    // visible from the delivery path: `armedForEndpoint` stops
    // returning a check the moment it leaves `armed`, so a second
    // delivery never reaches the claim at all. That makes the claim
    // untestable end-to-end and it does NOT make it decoration — it is
    // what holds if any caller ever lists checks and then fires them
    // across an await, which the poll sweep does by construction. So
    // the transition is asserted where it lives.
    await deliver(ctx, GREEN);
    const check = (await listChecks(ctx))[0] as SpineCheck;
    expect(ctx.checks.claimForFiring(check.id), 'a fired check cannot be claimed again').toBe(
      false,
    );

    // The positive control: an armed check yields exactly one winner.
    const second = await armedAsk(ctx, CI_RECIPE);
    expect(second.status, await second.clone().text()).toBe(201);
    const fresh = (await listChecks(ctx)).find((c) => c.state === 'armed') as SpineCheck;
    expect(ctx.checks.claimForFiring(fresh.id)).toBe(true);
    expect(ctx.checks.claimForFiring(fresh.id)).toBe(false);
  });

  it('fires once per arming: a second matching delivery adds nothing', async () => {
    await deliver(ctx, GREEN);
    const first = (await listEvents(ctx)).find((e) => e.kind === 'observation') as SpineEvent;
    await deliver(ctx, { ...GREEN, check_run: { ...GREEN.check_run, head_sha: 'sha-later' } });

    const observations = (await listEvents(ctx)).filter((e) => e.kind === 'observation');
    expect(observations.map((e) => e.id)).toEqual([first.id]);
    const check = (await listChecks(ctx))[0] as SpineCheck;
    expect({ state: check.state, firedEvent: check.firedEvent }).toEqual({
      state: 'fired',
      firedEvent: first.id,
    });
  });

  it('never sees an unverified delivery — with the signed one as control', async () => {
    const body = JSON.stringify(GREEN);
    const forged = await ctx.app.request(`/hooks/${HOOK_SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' },
      body,
    });
    await settle();
    expect(forged.status).toBe(401);
    expect((await listEvents(ctx)).filter((e) => e.kind === 'observation')).toEqual([]);

    expect((await deliver(ctx, GREEN)).status).toBe(202);
    expect((await listEvents(ctx)).filter((e) => e.kind === 'observation')).toHaveLength(1);
  });
});

// ─── The waiting_for discharge ──────────────────────────────────────

describe('a check firing on a waiting_for contract re-lights it', () => {
  let contract: string;

  beforeEach(async () => {
    await registerSubject(ctx, 'repo:acme');
    contract = await authorContract(ctx);
    const res = await post(ctx, 'rune', {
      kind: 'lifecycle',
      opId: 'life-wait',
      expectedStateRev: 1,
      body: { contract, state: 'waiting_for', event: 'the CI build', check: CI_RECIPE },
    });
    expect(res.status, await res.clone().text()).toBe(201);
  });

  it('appends the lifecycle back to active, citing the observation', async () => {
    await deliver(ctx, GREEN);
    const events = await listEvents(ctx);
    const obs = events.find((e) => e.kind === 'observation') as SpineEvent;
    const relight = events.filter((e) => e.kind === 'lifecycle').at(-1) as SpineEvent;
    const check = (await listChecks(ctx))[0] as SpineCheck;

    expect({
      actor: relight.actor,
      authoredBy: relight.authoredBy,
      cites: relight.cites,
      state: (relight.body as { state: string }).state,
    }).toEqual({
      actor: `probe:${check.id}`,
      authoredBy: 'rune',
      cites: [obs.id],
      state: 'active',
    });

    const after = await contractOf(ctx, contract);
    expect({ state: after.state, waitingFor: after.waitingFor }).toEqual({
      state: 'active',
      waitingFor: null,
    });
    // The counter moved, so a member who wrote against the waiting
    // state is refused with the delta rather than silently accepted.
    expect(after.stateRev).toBeGreaterThan(2);
  });

  it('nags nobody — no class-1 line for the re-light', async () => {
    const rune = ctx.sinkFor('rune');
    const lea = ctx.sinkFor('lea');
    await deliver(ctx, GREEN);
    await settle();
    // §7: "nobody nagged, nobody had to notice". `active` is a report
    // on progress, it recurs, and class 2's `lifecycle` level is what
    // it is for; the assignee discovers it at their next orient like
    // every other movement of the room.
    expect(rune.injections).toHaveLength(0);
    expect(lea.injections).toHaveLength(0);
    rune.close();
    lea.close();
  });

  it('does not re-light a contract that has moved on, but keeps the photograph', async () => {
    // A member cancelled while the world was still working. The
    // observation is still true and still lands; the transition does
    // not, and the check is no longer armed to take a second one.
    const cancelled = await post(ctx, 'lea', {
      kind: 'lifecycle',
      opId: 'life-cancel',
      expectedStateRev: 2,
      body: { contract, state: 'cancelled', reason: 'superseded by the hotfix' },
    });
    expect(cancelled.status, await cancelled.clone().text()).toBe(201);

    await deliver(ctx, GREEN);
    expect((await listEvents(ctx)).filter((e) => e.kind === 'observation')).toEqual([]);
    expect((await contractOf(ctx, contract)).state).toBe('cancelled');
    const check = (await listChecks(ctx))[0] as SpineCheck;
    expect(check.state).toBe('disarmed');
    expect(check.disarmedReason).toContain('cancelled');
  });
});

// ─── Disarming ──────────────────────────────────────────────────────

describe('a check dies with the thing it was armed on', () => {
  beforeEach(async () => {
    await registerSubject(ctx, 'repo:acme');
  });

  it('withdrawing the ask disarms it, and a later delivery fires nothing', async () => {
    const askId = ((await (await armedAsk(ctx, CI_RECIPE)).json()) as { event: SpineEvent }).event
      .id;
    const withdrawn = await post(ctx, 'lea', {
      kind: 'ask_action',
      opId: 'withdraw-1',
      body: { ask: askId, action: 'withdraw', reason: 'we shipped without it' },
    });
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(201);

    const check = (await listChecks(ctx))[0] as SpineCheck;
    expect(check.state).toBe('disarmed');
    expect(check.disarmedReason).toContain('withdrawn');

    await deliver(ctx, GREEN);
    expect((await listEvents(ctx)).filter((e) => e.kind === 'observation')).toEqual([]);
  });

  it('a ruling disarms it — the authority answered, so nothing is left to confirm', async () => {
    const askId = ((await (await armedAsk(ctx, CI_RECIPE)).json()) as { event: SpineEvent }).event
      .id;
    const ruled = await post(ctx, 'andrewjon', {
      kind: 'ruling',
      opId: 'rule-1',
      body: { ask: askId, decision: 'cut it now', reasoning: 'the risk is acceptable' },
    });
    expect(ruled.status, await ruled.clone().text()).toBe(201);
    expect((await listChecks(ctx))[0]?.state).toBe('disarmed');
    await deliver(ctx, GREEN);
    expect((await listEvents(ctx)).filter((e) => e.kind === 'observation')).toEqual([]);
  });

  it('a REDIRECT leaves it armed — the question is unanswered, just re-addressed', async () => {
    // The control on the disarm set not being over-broad. A redirect
    // that disarmed would silently drop the arming at the one moment
    // the asker is least likely to be watching.
    const askId = ((await (await armedAsk(ctx, CI_RECIPE)).json()) as { event: SpineEvent }).event
      .id;
    const redirected = await post(ctx, 'andrewjon', {
      kind: 'ask_action',
      opId: 'redirect-1',
      body: { ask: askId, action: 'redirect', reason: 'rune owns releases', redirectTo: 'rune' },
    });
    expect(redirected.status, await redirected.clone().text()).toBe(201);
    expect((await listChecks(ctx))[0]?.state).toBe('armed');

    await deliver(ctx, GREEN);
    expect((await listEvents(ctx)).filter((e) => e.kind === 'observation')).toHaveLength(1);
  });

  it('a contract leaving waiting_for by a member disarms its check', async () => {
    const contract = await authorContract(ctx);
    await post(ctx, 'rune', {
      kind: 'lifecycle',
      opId: 'w-1',
      expectedStateRev: 1,
      body: { contract, state: 'waiting_for', event: 'CI', check: CI_RECIPE },
    });
    const back = await post(ctx, 'rune', {
      kind: 'lifecycle',
      opId: 'w-2',
      expectedStateRev: 2,
      body: { contract, state: 'active', reason: 'picked it back up by hand' },
    });
    expect(back.status, await back.clone().text()).toBe(201);
    expect((await listChecks(ctx))[0]?.state).toBe('disarmed');
    await deliver(ctx, GREEN);
    expect((await listEvents(ctx)).filter((e) => e.kind === 'observation')).toEqual([]);
  });
});

// ─── What a probe may author ────────────────────────────────────────

describe('a probe can author nothing but its two allowed shapes', () => {
  it('refuses a member who claims authoredBy, over HTTP', async () => {
    await registerSubject(ctx, 'repo:acme');
    const forged = await post(ctx, 'rune', {
      kind: 'observation',
      subject: 'repo:acme',
      authoredBy: 'lea',
      body: { what: 'ci', output: 'green' },
    });
    expect(forged.status).toBe(403);
    expect(((await forged.json()) as { error: string }).error).toContain(
      "filing their own observation under a colleague's name",
    );

    // The nearest valid thing must still be accepted: the same
    // observation, without the borrowed authorship.
    const honest = await post(ctx, 'rune', {
      kind: 'observation',
      subject: 'repo:acme',
      body: { what: 'ci', output: 'green' },
    });
    expect(honest.status, await honest.clone().text()).toBe(201);
  });

  it('refuses every non-observation from a probe actor, and allows the two', () => {
    // Driven at the STORE rather than over HTTP, and that is itself
    // part of the property: no HTTP caller can present a `probe:`
    // identity, because the route takes the actor from the
    // authenticated member and member names cannot contain `:`. The
    // engine is the only thing that can hold one, so the store is where
    // the rule has to bind.
    const db = openDatabase(':memory:');
    const annex = createSqliteAnnexStore(db);
    annex.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea');
    const spec = annex.append(
      {
        kind: 'specification',
        subject: 'repo:acme',
        opId: 'op-spec',
        body: {
          title: 'Ship it',
          criteria: [{ id: 'c1', text: 'returns 200' }],
          assignee: 'rune',
        },
      },
      { actor: 'lea' },
    );
    const contract = spec.event.id;
    annex.append(
      {
        kind: 'lifecycle',
        opId: 'op-wait',
        expectedStateRev: 1,
        body: { contract, state: 'waiting_for', event: 'CI', check: 'prose' },
      },
      { actor: 'rune' },
    );
    const probe = 'probe:chk_1';

    // THE POSITIVE CONTROLS FIRST. A store that refused every probe
    // write would satisfy every negative below it.
    const observation = annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        authoredBy: 'rune',
        body: { what: 'ci', output: 'green' },
      },
      { actor: probe },
    );
    expect(observation.event.actor).toBe(probe);
    const relight = annex.append(
      {
        kind: 'lifecycle',
        opId: 'op-relight',
        expectedStateRev: 2,
        cites: [observation.event.id],
        authoredBy: 'rune',
        body: { contract, state: 'active' },
      },
      { actor: probe },
    );
    expect((relight.contract as SpineContract).state).toBe('active');

    // A JUDGEMENT, in every shape the registry offers. Enumerated
    // rather than sampled: closing one route establishes nothing about
    // the others.
    const refusals: [string, () => unknown][] = [
      [
        'a discussion post',
        () =>
          annex.append(
            { kind: 'discussion', authoredBy: 'rune', body: { body: 'looks green' } },
            { actor: probe },
          ),
      ],
      [
        'testimony',
        () =>
          annex.append(
            {
              kind: 'testimony',
              subject: 'repo:acme',
              authoredBy: 'rune',
              body: { what: 'ci', account: 'rune said so', observer: 'rune' },
            },
            { actor: probe },
          ),
      ],
      [
        'a specification',
        () =>
          annex.append(
            {
              kind: 'specification',
              subject: 'repo:acme',
              opId: 'op-probe-spec',
              authoredBy: 'rune',
              body: { title: 'x', criteria: [{ id: 'c1', text: 'y' }], assignee: 'rune' },
            },
            { actor: probe },
          ),
      ],
      [
        'a verdict',
        () =>
          annex.append(
            {
              kind: 'criterion_verdict',
              opId: 'op-probe-verdict',
              expectedStateRev: 3,
              revision: {
                subject: 'repo:acme',
                value: 'sha',
                how: 'observed',
                source: probe,
              },
              authoredBy: 'rune',
              body: { contract, criterion: 'c1', decision: 'met', evidence: 'green' },
            },
            { actor: probe },
          ),
      ],
    ];
    for (const [what, act] of refusals) {
      expect(act, `a probe must not author ${what}`).toThrow(/may only append observations/);
    }

    // AND THE LIFECYCLE IS FENCED ON EVERY SIDE, one side at a time.
    expect(
      () =>
        annex.append(
          {
            kind: 'lifecycle',
            opId: 'op-probe-cancel',
            expectedStateRev: 3,
            cites: [observation.event.id],
            authoredBy: 'rune',
            body: { contract, state: 'cancelled', reason: 'the build failed' },
          },
          { actor: probe },
        ),
      'a probe may only move a contract to active',
    ).toThrow(/may only move a contract to active/);

    expect(
      () =>
        annex.append(
          {
            kind: 'lifecycle',
            opId: 'op-probe-again',
            expectedStateRev: 3,
            cites: [observation.event.id],
            authoredBy: 'rune',
            body: { contract, state: 'active' },
          },
          { actor: probe },
        ),
      'the contract is active, not waiting_for: there is nothing a probe may change',
    ).toThrow(/only re-light a contract that is waiting_for/);

    // Back to waiting_for, so the last two negatives are about the
    // citation rather than about the state.
    annex.append(
      {
        kind: 'lifecycle',
        opId: 'op-wait-2',
        expectedStateRev: 3,
        body: { contract, state: 'waiting_for', event: 'CI again', check: 'prose' },
      },
      { actor: 'rune' },
    );
    expect(
      () =>
        annex.append(
          {
            kind: 'lifecycle',
            opId: 'op-probe-nocite',
            expectedStateRev: 4,
            authoredBy: 'rune',
            body: { contract, state: 'active' },
          },
          { actor: probe },
        ),
      'a discharge citing nothing is a state change with no evidence behind it',
    ).toThrow(/must cite its OWN firing observation/);

    const otherProbe = annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        authoredBy: 'lea',
        body: { what: 'something else', output: 'x' },
      },
      { actor: 'probe:chk_2' },
    );
    expect(
      () =>
        annex.append(
          {
            kind: 'lifecycle',
            opId: 'op-probe-borrowed',
            expectedStateRev: 4,
            cites: [otherProbe.event.id],
            authoredBy: 'rune',
            body: { contract, state: 'active' },
          },
          { actor: probe },
        ),
      "citing another probe's observation is a check claiming a photograph it did not take",
    ).toThrow(/must cite its OWN firing observation/);

    // And a probe with no `authoredBy` at all: an unattributed
    // photograph is the system composing a shot on its own judgement.
    expect(() =>
      annex.append(
        { kind: 'observation', subject: 'repo:acme', body: { what: 'x', output: 'y' } },
        { actor: probe },
      ),
    ).toThrow(/must carry authoredBy/);

    db.close();
  });
});

// ─── http_poll ──────────────────────────────────────────────────────

describe('the outbound poll, and every pin on it', () => {
  const pollRecipe = (patch: Record<string, unknown> = {}): string =>
    JSON.stringify({
      kind: 'http_poll',
      url: 'https://ci.example.com/status',
      intervalMs: 60_000,
      when: [{ path: 'state', op: 'eq', value: 'green' }],
      revisionPath: 'sha',
      ...patch,
    });

  async function armPoll(
    app: ProbeApp,
    patch: Record<string, unknown> = {},
    who = 'lea',
  ): Promise<string> {
    await registerSubject(app, 'repo:acme');
    const res = await app.app.request(
      '/spine/events',
      authed(tokenFor(who), {
        kind: 'ask',
        subject: 'repo:acme',
        opId: `ask-poll-${Math.random()}`,
        body: {
          authority: 'andrewjon',
          question: 'is the deploy live?',
          context: 'waiting on the rollout',
          unblocks: 'the announcement',
          check: pollRecipe(patch),
        },
      }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { event: SpineEvent }).event.id;
  }

  it('fires on a compliant poll — the positive control for the pins below', async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green', sha: 'sha-poll' })]);
    const app = makeProbeApp({ fetchImpl: fetchImpl.impl });
    const askId = await armPoll(app);
    await app.probes.sweep();

    const events = await listEvents(app);
    const obs = events.find((e) => e.kind === 'observation') as SpineEvent;
    expect(obs.revision?.value).toBe('sha-poll');
    expect(app.annex.ask(askId)?.state).toBe('discharged');

    // GET, no redirects, and PINNED — the request itself, asserted.
    // `pinnedAddresses` is the load-bearing one: a transport handed a
    // hostname would resolve it again and the egress check would be a
    // time-of-check/time-of-use bug rather than a control.
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]?.url).toBe('https://ci.example.com/status');
    expect({
      method: fetchImpl.calls[0]?.init?.method,
      redirect: fetchImpl.calls[0]?.init?.redirect,
      pinned: fetchImpl.calls[0]?.init?.pinnedAddresses,
    }).toEqual({ method: 'GET', redirect: 'manual', pinned: ['93.184.216.34'] });
    // The transport signature has no `body` at all — a probe observes
    // and does not act on the world, and that is a type rather than a
    // convention.
    expect('body' in (fetchImpl.calls[0]?.init ?? {})).toBe(false);
    app.db.close();
  });

  it('does not follow a redirect, and says so', async () => {
    const fetchImpl = scriptedFetch([
      () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/x' } }),
    ]);
    const app = makeProbeApp({ fetchImpl: fetchImpl.impl });
    await armPoll(app);
    await app.probes.sweep();

    expect((await listEvents(app)).filter((e) => e.kind === 'observation')).toEqual([]);
    // ONE request. A followed redirect would show as a second call to
    // a URL nobody authored — with the auth header attached.
    expect(fetchImpl.calls.map((c) => c.url)).toEqual(['https://ci.example.com/status']);
    expect((await listChecks(app))[0]?.state).toBe('armed');

    // THE REASON, not merely the absence of an observation. `!ok`
    // catches a 302 as "HTTP 302" all on its own, so an engine with no
    // redirect branch at all passes every assertion above — and would
    // then follow the redirect the moment `redirect: 'manual'` came
    // off. Naming the refusal is what separates "we declined to
    // follow it" from "it happened not to be a 200".
    const warned = app.logger.warn.mock.calls.find((c) => c[0] === 'spine: poll failed');
    expect(warned?.[1]).toMatchObject({
      reason: expect.stringContaining('refused to follow a 302 redirect'),
    });
    expect(warned?.[1]).toMatchObject({
      reason: expect.stringContaining('a followed redirect is one nobody authored'),
    });
    app.db.close();
  });

  it('enforces the response size cap', async () => {
    const huge = { state: 'green', sha: 'x'.repeat(300 * 1024) };
    const fetchImpl = scriptedFetch([() => jsonResponse(huge)]);
    const app = makeProbeApp({ fetchImpl: fetchImpl.impl });
    await armPoll(app);
    await app.probes.sweep();
    expect((await listEvents(app)).filter((e) => e.kind === 'observation')).toEqual([]);
    expect((await listChecks(app))[0]?.state).toBe('armed');
    app.db.close();
  });

  it('refuses a non-JSON body and a non-2xx status', async () => {
    const fetchImpl = scriptedFetch([
      () => new Response('<html>down</html>', { status: 200 }),
      () => new Response('{}', { status: 503 }),
    ]);
    const app = makeProbeApp({ fetchImpl: fetchImpl.impl });
    await armPoll(app);
    await app.probes.sweep();
    app.clock.ms += 120_000;
    await app.probes.sweep();
    expect((await listEvents(app)).filter((e) => e.kind === 'observation')).toEqual([]);
    expect(fetchImpl.calls).toHaveLength(2);
    app.db.close();
  });

  it('does not double-poll when a slow sweep overlaps the next tick', async () => {
    // THE GUARD THE CLAIM DOES NOT COVER. `claimForFiring` protects the
    // OBSERVATION; it is taken after the network call comes back. Two
    // overlapping sweeps therefore issue two outbound requests — with
    // the author's secret on both — before either claims anything, and
    // an endpoint slower than the tick makes that the normal case
    // rather than a race.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const app = makeProbeApp({
      fetchImpl: async () => {
        calls += 1;
        await gate;
        // NOT MATCHING, deliberately: a firing poll leaves the check
        // terminal and the positive control below could never run,
        // which would leave "the guard is stuck on forever" untested.
        return jsonResponse({ state: 'red', sha: 'x' });
      },
    });
    await armPoll(app);

    const first = app.probes.sweep();
    // A second tick lands while the first is still in flight. Both are
    // awaited before anything is counted, so the assertion is about
    // what the pair of them DID rather than about when the first one
    // happened to reach the socket.
    const second = app.probes.sweep();
    await second;
    (release as () => void)();
    await first;
    expect(calls, 'two overlapping sweeps must issue one request, not two').toBe(1);

    // THE POSITIVE CONTROL: once the first sweep is done the guard is
    // released, and a later due poll goes out normally. A guard stuck
    // on would pass the assertion above forever.
    app.clock.ms += 120_000;
    await app.probes.sweep();
    expect(calls).toBe(2);
    app.db.close();
  });

  it('honours the interval on an injected clock', async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'red', sha: 'a' })]);
    const app = makeProbeApp({ fetchImpl: fetchImpl.impl });
    await armPoll(app, { intervalMs: 300_000 });

    // Due immediately — the member armed it because they expect the
    // world to be looked at, not to wait out one interval first.
    await app.probes.sweep();
    expect(fetchImpl.calls).toHaveLength(1);

    app.clock.ms += 299_000;
    await app.probes.sweep();
    expect(fetchImpl.calls, 'a poll must not run before its interval has elapsed').toHaveLength(1);

    app.clock.ms += 2_000;
    await app.probes.sweep();
    expect(fetchImpl.calls).toHaveLength(2);
    app.db.close();
  });

  it('refuses a non-https poll at fire time, not only at authoring', async () => {
    // A DEAD BRANCH IS A CLAIM NO TEST CAN CHECK, and the standard this
    // repo already set for one (`coveringCitation`) is explain-or-test.
    // The authoring pin means no http row can be authored — so the row
    // is injected directly, which is the case the branch exists for: a
    // migration, an import, or a future caller that does not pass the
    // schema.
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green', sha: 'x' })]);
    const app = makeProbeApp({ fetchImpl: fetchImpl.impl });
    await registerSubject(app, 'repo:acme');
    app.checks.arm({
      id: 'chk_smuggled',
      sourceEvent: 'evt_smuggled',
      carrier: 'ask',
      subject: 'repo:acme',
      contract: null,
      ask: null,
      recipe: {
        kind: 'http_poll',
        url: 'http://ci.example.com/status',
        intervalMs: 60_000,
        when: [],
      },
      authoredBy: 'lea',
      at: new Date(app.clock.ms).toISOString(),
    });
    await app.probes.sweep();
    expect(fetchImpl.calls, 'cleartext must not go out however the row arrived').toHaveLength(0);
    expect(
      app.logger.warn.mock.calls.find((c) => c[0] === 'spine: poll failed')?.[1],
    ).toMatchObject({ reason: expect.stringContaining('https only') });
    expect(app.checks.get('chk_smuggled')?.state).toBe('armed');
    app.db.close();
  });

  it('resolves the auth secret server-side, as its author, and never stores it', async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green', sha: 'sha-auth' })]);
    const app = makeProbeApp({ fetchImpl: fetchImpl.impl });
    const secret = app.secrets.create({
      slug: 'ci-token',
      envName: 'CI_TOKEN',
      allMembers: false,
      creator: 'andrewjon',
    });
    app.secrets.setValue(secret.id, 'Bearer s3cret-value');
    app.secrets.bind(secret.id, 'lea');
    await armPoll(app, { authSecret: 'ci-token', authHeader: 'Authorization' });
    await app.probes.sweep();

    const headers = fetchImpl.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer s3cret-value');
    // THE VALUE IS NOWHERE PERMANENT. The recipe holds the slug; the
    // annex holds the recipe; a token written into an append-only
    // event could never be rotated, redacted, or unseen.
    const check = (await listChecks(app))[0] as SpineCheck;
    expect(JSON.stringify(check.recipe)).toContain('ci-token');
    expect(JSON.stringify(check.recipe)).not.toContain('s3cret-value');
    const events = JSON.stringify(await listEvents(app));
    expect(events).not.toContain('s3cret-value');
    app.db.close();
  });

  it('will not borrow access its author does not have', async () => {
    // ARMED BY RUNE, BOUND TO LEA, and the two names have to be
    // different members for this to say anything. With `lea` doing
    // both the arming and the binding, an implementation that resolved
    // secrets as a HARD-CODED `lea` — or as the endpoint's creator, or
    // as the first member on the roster — would pass identically. The
    // author is the only name that should work here, so the fixture
    // makes every other name wrong.
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green', sha: 'x' })]);
    const app = makeProbeApp({ fetchImpl: fetchImpl.impl });
    const secret = app.secrets.create({
      slug: 'ci-token',
      envName: 'CI_TOKEN',
      allMembers: false,
      creator: 'andrewjon',
    });
    app.secrets.setValue(secret.id, 'Bearer s3cret-value');
    app.secrets.bind(secret.id, 'lea');
    await armPoll(app, { authSecret: 'ci-token' }, 'rune');
    expect((await listChecks(app))[0]?.authoredBy, 'rune armed it').toBe('rune');
    await app.probes.sweep();

    expect(fetchImpl.calls, 'rune cannot reach lea’s secret, so nothing goes out').toHaveLength(0);
    expect((await listEvents(app)).filter((e) => e.kind === 'observation')).toEqual([]);

    // The positive control: bind RUNE — the author — and the same
    // check goes out with the value. Binding anyone else would not.
    app.secrets.bind(secret.id, 'rune');
    app.clock.ms += 120_000;
    await app.probes.sweep();
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]?.init?.headers?.Authorization).toBe('Bearer s3cret-value');
    app.db.close();
  });
});

describe('the slice a firing observation carries', () => {
  it('is the paths the predicate named, and is bounded when it is everything', () => {
    const payload = { a: { b: 'x' }, big: 'y'.repeat(64 * 1024), other: 1 };

    // The normal case: named paths, so the reader can check the claim
    // rather than take it.
    expect(
      JSON.parse(
        sliceOf(payload, {
          kind: 'webhook',
          endpoint: 'ci',
          when: [{ path: 'a.b', op: 'eq', value: 'x' }],
          revisionPath: 'other',
        }),
      ),
    ).toEqual({ 'a.b': 'x', other: 1 });

    // A path that is not there renders as null rather than vanishing:
    // "the predicate looked here and found nothing" and "the predicate
    // never looked" are different facts.
    expect(
      JSON.parse(
        sliceOf(payload, {
          kind: 'webhook',
          endpoint: 'ci',
          when: [{ path: 'missing.path', op: 'exists' }],
        }),
      ),
    ).toEqual({ 'missing.path': null });

    // No predicate at all: "relevant" is honestly the whole payload,
    // and an annex event is permanent, so it is bounded.
    const whole = sliceOf(payload, { kind: 'webhook', endpoint: 'ci', when: [] });
    expect(whole.length).toBeLessThan(16 * 1024);
    expect(whole).toContain('[truncated at');
    // The positive control: a small payload with no predicate rides
    // whole and is NOT marked truncated.
    const small = sliceOf({ a: 1 }, { kind: 'webhook', endpoint: 'ci', when: [] });
    expect(JSON.parse(small)).toEqual({ a: 1 });
    expect(small).not.toContain('truncated');
  });
});

// ─── What discharges an ask, and what does not ──────────────────────

describe('only a probe discharges an ask, and only an unresolved one', () => {
  it('a member stapling an observation to an ask does not close it', () => {
    // The staple is the MECHANISM of the discharge, and a mechanism
    // anybody can operate is a way to answer your own question with a
    // photograph. A member may absolutely staple an observation to an
    // ask — that is evidence, and it is what stapling is for — but the
    // ask stays open until somebody with standing resolves it.
    const db = openDatabase(':memory:');
    const annex = createSqliteAnnexStore(db);
    annex.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea');
    const ask = annex.append(
      {
        kind: 'ask',
        subject: 'repo:acme',
        opId: 'op-ask',
        body: {
          authority: 'andrewjon',
          question: 'ship it?',
          context: 'ready',
          unblocks: 'the release',
        },
      },
      { actor: 'lea' },
    );

    annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        staplesTo: ask.event.id,
        body: { what: 'ci', output: 'green, I looked myself' },
      },
      { actor: 'lea' },
    );
    expect(annex.ask(ask.event.id)?.state).toBe('open');
    db.close();
  });

  it('spends nobody’s class-1 budget on a member’s staple', async () => {
    // THE OTHER HALF OF THE SAME GATE, and it is the half that costs a
    // member something. The fold's probe check keeps the ask open; the
    // CURATOR's probe check is what keeps a member from spending
    // somebody else's never-yields budget with a line that says
    // "discharged" about an ask that is not. Two guards, two tests —
    // the store one passes happily while the curator one is missing.
    await registerSubject(ctx, 'repo:acme');
    const askId = ((await (await armedAsk(ctx, undefined)).json()) as { event: SpineEvent }).event
      .id;
    const lea = ctx.sinkFor('lea');
    const andrewjon = ctx.sinkFor('andrewjon');
    lea.messages.length = 0;
    andrewjon.messages.length = 0;

    const stapled = await post(ctx, 'rune', {
      kind: 'observation',
      subject: 'repo:acme',
      staplesTo: askId,
      body: { what: 'ci', output: 'looks green to me' },
    });
    expect(stapled.status, await stapled.clone().text()).toBe(201);
    await settle();

    expect(lea.injections, 'a member’s staple must not spend the asker’s budget').toHaveLength(0);
    expect(andrewjon.injections).toHaveLength(0);
    expect(ctx.annex.ask(askId)?.state).toBe('open');
    lea.close();
    andrewjon.close();
  });

  it('a member stapling an observation still records the evidence', () => {
    // The positive control on the two negatives above: stapling is a
    // legitimate act and it is what stapling is FOR. What it does not
    // do is resolve somebody else's question.
    const db = openDatabase(':memory:');
    const annex = createSqliteAnnexStore(db);
    annex.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea');
    const ask = annex.append(
      {
        kind: 'ask',
        subject: 'repo:acme',
        opId: 'op-ask',
        body: {
          authority: 'andrewjon',
          question: 'ship it?',
          context: 'ready',
          unblocks: 'the release',
        },
      },
      { actor: 'lea' },
    );
    const evidence = annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        staplesTo: ask.event.id,
        body: { what: 'ci', output: 'green, I looked myself' },
      },
      { actor: 'lea' },
    );
    expect(annex.event(evidence.event.id)?.staplesTo).toBe(ask.event.id);

    // The positive control, on the same ask and the same staple: a
    // probe's observation closes it.
    const fired = annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        staplesTo: ask.event.id,
        authoredBy: 'lea',
        body: { what: 'ci', output: 'green' },
      },
      { actor: 'probe:chk_1' },
    );
    expect(annex.ask(ask.event.id)).toMatchObject({
      state: 'discharged',
      resolvedBy: fired.event.id,
    });
    db.close();
  });

  it('a late fire does not overwrite the resolution a member gave', () => {
    // The first answer is the one that happened. A probe arriving
    // after a withdrawal must not rewrite the record to say the world
    // answered a question the asker had already taken back.
    const db = openDatabase(':memory:');
    const annex = createSqliteAnnexStore(db);
    annex.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea');
    const ask = annex.append(
      {
        kind: 'ask',
        subject: 'repo:acme',
        opId: 'op-ask',
        body: {
          authority: 'andrewjon',
          question: 'ship it?',
          context: 'ready',
          unblocks: 'the release',
        },
      },
      { actor: 'lea' },
    );
    const withdrawal = annex.append(
      {
        kind: 'ask_action',
        opId: 'op-withdraw',
        body: { ask: ask.event.id, action: 'withdraw', reason: 'we shipped without it' },
      },
      { actor: 'lea' },
    );
    annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        staplesTo: ask.event.id,
        authoredBy: 'lea',
        body: { what: 'ci', output: 'green' },
      },
      { actor: 'probe:chk_1' },
    );
    expect(annex.ask(ask.event.id)).toMatchObject({
      state: 'withdrawn',
      resolvedBy: withdrawal.event.id,
    });
    db.close();
  });
});

// ─── A replay arms nothing ──────────────────────────────────────────

describe('a replayed append does not arm a second camera', () => {
  it('returns the original event and leaves one check', async () => {
    // Idempotency has to hold for the REGISTRY as well as for the
    // annex. A retry after a lost response is a miniature album dump —
    // the whole reason `op_id` exists — and arming a second check on
    // it would point two cameras at one thing and give "did the thing
    // I armed happen" two answers. The engine's own guard is
    // `result.replayed`; the registry's UNIQUE index is the backstop,
    // and a retry should not depend on a constraint to be a no-op.
    await registerSubject(ctx, 'repo:acme');
    const body = {
      kind: 'ask' as const,
      subject: 'repo:acme',
      opId: 'op-replayed-ask',
      body: {
        authority: 'andrewjon',
        question: 'ship when green?',
        context: 'ready',
        unblocks: 'the release',
        check: CI_RECIPE,
      },
    };
    const first = await post(ctx, 'lea', body);
    expect(first.status, await first.clone().text()).toBe(201);
    const firstId = ((await first.json()) as { event: SpineEvent }).event.id;

    const replay = await post(ctx, 'lea', body);
    // 200, not 201: the retry created nothing, which is the honest
    // answer to "did my write land twice".
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as { event: SpineEvent; replayed: boolean };
    expect({ id: replayed.event.id, replayed: replayed.replayed }).toEqual({
      id: firstId,
      replayed: true,
    });

    const checks = await listChecks(ctx);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.sourceEvent).toBe(firstId);

    // And the check still fires exactly once, which is the property
    // the count above exists to protect.
    await deliver(ctx, GREEN);
    expect((await listEvents(ctx)).filter((e) => e.kind === 'observation')).toHaveLength(1);
  });
});

// ─── The read surface is a facade, not an argument ──────────────────

describe('the annex handed to consumers genuinely cannot append', () => {
  it('has no append to cast to', () => {
    // THE DEFEAT-TEST ON THE CLAIM ITSELF. `AnnexStore` having no
    // `append` is a compile-time claim, and a compile-time claim about
    // an object is defeated by one cast:
    //
    //   (path.store as unknown as { append: … }).append(evt, ctx)
    //
    // which imports nothing but types, is invisible to the scanner, and
    // — while `store` was the writer wearing a narrower type — reached
    // the annex and bypassed every post-commit hook. The event landed,
    // no check armed, no curator line went out.
    //
    // So the object handed out does not have the method, and this is
    // what says so.
    const db = openDatabase(':memory:');
    const path = createAnnexWritePath({
      db,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    const smuggled = path.store as unknown as { append?: unknown };
    expect(smuggled.append, 'the facade must not carry the method at all').toBeUndefined();
    expect(Object.keys(path.store)).not.toContain('append');
    expect(Object.getPrototypeOf(path.store), 'nor reach it up the prototype chain').toBe(
      Object.prototype,
    );

    // AND IT IS STILL A REAL ANNEX. A facade that lost the reads would
    // pass every assertion above and break the whole server.
    path.store.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea');
    expect(path.store.subject('repo:acme')?.type).toBe('repo');
    expect(path.store.events().events).toEqual([]);
    expect(path.store.orient('lea').contracts).toEqual([]);

    // Frozen, so a caller holding a writer cannot re-fit the facade
    // with one. Not the attack this exists for, but a read-only
    // surface that can be assigned to is not read-only.
    expect(Object.isFrozen(path.store)).toBe(true);
    db.close();
  });

  it('does not expose the raw writer on the write-path object either', () => {
    // THE PHASE-4 CARRY-FORWARD, PINNED. The facade above closes the
    // cast hole for `path.store`; this closes it for the path object
    // itself. `private readonly writer` is a TYPE-only private — erased
    // at runtime — so `(path as unknown as { writer }).writer.append(
    // evt, ctx)` reached an append-capable handle by a cast, bypassing
    // every post-commit hook, invisible to the scanner. `#writer` is a
    // real JS private: it is not a property on the object, no cast
    // reaches it, and `in` from outside the class is false. Revert the
    // field to `private readonly writer` and both assertions below die —
    // which is the whole point of writing them down.
    const db = openDatabase(':memory:');
    const path = createAnnexWritePath({
      db,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    expect('writer' in (path as unknown as object), 'no `writer` key to reach through').toBe(false);
    expect(
      (path as unknown as { writer?: unknown }).writer,
      'and no append-capable handle behind a cast',
    ).toBeUndefined();
    // Still a real write path — the private handle is unreachable, not
    // absent (the control on the negatives above).
    path.store.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea');
    expect(path.store.subject('repo:acme')?.type).toBe('repo');
    db.close();
  });

  it('routes a write made through the path — the control on the facade', async () => {
    // The positive control: the write path still works, and its hooks
    // still run. A facade that broke the writer would satisfy the
    // negatives above perfectly.
    const db = openDatabase(':memory:');
    const path = createAnnexWritePath({
      db,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    const seen: string[] = [];
    path.onAppend(async (result) => {
      seen.push(result.event.id);
    });
    path.store.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea');
    const result = await path.append(
      { kind: 'observation', subject: 'repo:acme', body: { what: 'ci', output: 'green' } },
      { actor: 'lea' },
    );
    expect(seen).toEqual([result.event.id]);
    db.close();
  });
});

// ─── A probe observes; it cannot assert ─────────────────────────────

describe('a probe cannot caption an event with an asserted revision', () => {
  it('refuses at the store, and accepts the observed one beside it', () => {
    // D2 and §10. `asserted` means a member named the value by hand,
    // which is authored intent, and the system has none — it holds the
    // camera. It is not cosmetic either: only OBSERVED revisions move a
    // subject's head, so an asserted one from a probe would be the
    // system claiming the world is at a state nobody looked at, and
    // every contract bound to the real head would render stale against
    // a fiction.
    const db = openDatabase(':memory:');
    const annex = createSqliteAnnexStore(db);
    annex.registerSubject({ id: 'repo:acme', type: 'repo' }, 'lea');

    expect(() =>
      annex.append(
        {
          kind: 'observation',
          subject: 'repo:acme',
          authoredBy: 'lea',
          revision: {
            subject: 'repo:acme',
            value: 'sha-invented',
            how: 'asserted',
            source: 'probe:chk_1',
          },
          body: { what: 'ci', output: 'green' },
        },
        { actor: 'probe:chk_1' },
      ),
    ).toThrow(/A probe LOOKS; it cannot assert/);

    // THE NEAREST VALID THING, still accepted — and the head moves,
    // which is the property the refusal is protecting.
    const observed = annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        authoredBy: 'lea',
        revision: {
          subject: 'repo:acme',
          value: 'sha-seen',
          how: 'observed',
          source: 'probe:chk_1',
        },
        body: { what: 'ci', output: 'green' },
      },
      { actor: 'probe:chk_1' },
    );
    expect(observed.event.revision?.how).toBe('observed');

    // And a MEMBER may still assert — the rule is about who is holding
    // the camera, not about the field.
    const asserted = annex.append(
      {
        kind: 'observation',
        subject: 'repo:acme',
        revision: {
          subject: 'repo:acme',
          value: 'sha-by-hand',
          how: 'asserted',
          source: 'member:lea',
        },
        body: { what: 'ci', output: 'I checked the console' },
      },
      { actor: 'lea' },
    );
    expect(asserted.event.revision?.how).toBe('asserted');
    db.close();
  });
});

// ─── The registry is a projection ───────────────────────────────────

describe('the check registry can be dropped and refolded from the stream', () => {
  it('rebuilds armed, fired and disarmed states from the events alone', async () => {
    await registerSubject(ctx, 'repo:acme');
    // A varied sequence: one armed, one fired, one disarmed, one prose.
    const contract = await authorContract(ctx);
    await post(ctx, 'rune', {
      kind: 'lifecycle',
      opId: 'r-1',
      expectedStateRev: 1,
      body: { contract, state: 'waiting_for', event: 'CI', check: CI_RECIPE },
    });
    const withdrawnAsk = ((await (await armedAsk(ctx, CI_RECIPE)).json()) as { event: SpineEvent })
      .event.id;
    await post(ctx, 'lea', {
      kind: 'ask_action',
      opId: 'wd',
      body: { ask: withdrawnAsk, action: 'withdraw', reason: 'no longer needed' },
    });
    await armedAsk(ctx, 'prose only');
    await deliver(ctx, GREEN);

    const before = await listChecks(ctx);
    expect(before.map((c) => c.state).sort()).toEqual(['disarmed', 'fired']);

    ctx.probes.rebuildChecks();
    const after = await listChecks(ctx);
    // EVERYTHING BUT THE BOOKKEEPING COLUMN. `lastEvaluatedAt` is a
    // fact about the engine, not about the team, and losing it costs
    // one redundant evaluation — the same trade a lost lease makes.
    const strip = (checks: SpineCheck[]) =>
      checks.map(({ lastEvaluatedAt: _drop, id: _id, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before));
    expect(after.map((c) => c.firedEvent)).toEqual(before.map((c) => c.firedEvent));
  });
});
