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

  it('sends the asker exactly one class-1 line, naming the observation', async () => {
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

    // NOT THE AUTHORITY. Their queue item went away, which is the
    // absence of a demand rather than a new one — announcing it would
    // be the ceremony §10 forbids.
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

  async function armPoll(app: ProbeApp, patch: Record<string, unknown> = {}): Promise<string> {
    await registerSubject(app, 'repo:acme');
    const res = await app.app.request(
      '/spine/events',
      authed(tokenFor('lea'), {
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

    // GET, no body, no redirects — the request itself, asserted.
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]?.url).toBe('https://ci.example.com/status');
    expect({
      method: fetchImpl.calls[0]?.init?.method,
      redirect: fetchImpl.calls[0]?.init?.redirect,
      body: fetchImpl.calls[0]?.init?.body ?? null,
    }).toEqual({ method: 'GET', redirect: 'manual', body: null });
    app.db.close();
  });

  it('does not follow a redirect, and stays armed', async () => {
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
    // The secret exists and has a value, and lea is not bound to it.
    // A check that could still send it would make arming a probe a
    // privilege-escalation surface with a permanent record.
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green', sha: 'x' })]);
    const app = makeProbeApp({ fetchImpl: fetchImpl.impl });
    const secret = app.secrets.create({
      slug: 'ci-token',
      envName: 'CI_TOKEN',
      allMembers: false,
      creator: 'andrewjon',
    });
    app.secrets.setValue(secret.id, 'Bearer s3cret-value');
    app.secrets.bind(secret.id, 'rune');
    await armPoll(app, { authSecret: 'ci-token' });
    await app.probes.sweep();

    expect(fetchImpl.calls, 'the poll must not go out at all').toHaveLength(0);
    expect((await listEvents(app)).filter((e) => e.kind === 'observation')).toEqual([]);

    // The positive control: bind lea, and the same check goes out.
    app.secrets.bind(secret.id, 'lea');
    app.clock.ms += 120_000;
    await app.probes.sweep();
    expect(fetchImpl.calls).toHaveLength(1);
    app.db.close();
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
