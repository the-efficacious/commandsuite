/**
 * Where a probe may point its camera — the SSRF suite.
 *
 * WHAT WAS ACTUALLY WRONG, because the tests only read correctly if
 * the hole does. An `http_poll` recipe's only destination pin was
 * `https:`. So `https://169.254.169.254/latest/meta-data/iam/…`,
 * `https://10.0.0.5`, `https://127.0.0.1:8443`,
 * `https://vault.internal:8200` and `https://kubernetes.default.svc`
 * were all accepted at authoring AND actually issued — from the
 * server, inside the deployment's network, with the check author's own
 * secret attached as a header, and with up to 8 KiB of the response
 * written into a PERMANENT annex observation readable by every other
 * member at `GET /spine/events`. A server-side request forgery with a
 * durable, team-readable exfiltration channel attached, reachable by an
 * ordinary act of authorship.
 *
 * THREE LAYERS, TESTED SEPARATELY, because each one alone is bypassable
 * and passing on one proves nothing about the others:
 *
 *   1  the authoring pin, on IP literals — the honest mistake and the
 *      obvious attempt, refused at the keyboard where the member is;
 *   2  the fire-time resolution, on NAMES — the load-bearing one,
 *      because `vault.internal` is a well-formed hostname and only a
 *      resolver knows where it goes;
 *   3  the pin travelling with the request — because resolve-then-fetch
 *      is a time-of-check/time-of-use bug and DNS rebinding is its
 *      standard defeat.
 *
 * And each layer has its positive control, because a destination check
 * that refuses everything passes every negative in this file.
 */

import type { SpineEvent } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blockedAddressReason,
  createEgressPolicy,
  createPinnedFetch,
  hostAsIpLiteral,
} from '../src/spine/egress.js';
import {
  authed,
  fakeEgress,
  jsonResponse,
  makeProbeApp,
  type ProbeApp,
  scriptedFetch,
} from './helpers/spine-probe-app.js';

/** The seven the verifier confirmed live, plus the v6 spellings of them. */
const PRIVATE_LITERALS = [
  'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
  'https://10.0.0.5/admin',
  'https://127.0.0.1:8443/',
  'https://192.168.1.1/',
  'https://172.16.0.1/',
  'https://100.64.0.1/',
  'https://0.0.0.0/',
  'https://[::1]:8443/',
  'https://[fd00::1]/',
  'https://[fe80::1]/',
  // A v4-mapped v6 literal is a v4 address wearing a v6 spelling, and
  // treating it as opaque is exactly how a blocklist gets walked round.
  'https://[::ffff:169.254.169.254]/',
];

function tokenFor(who: string): string {
  return `csuite_probe_${who}_token`;
}

async function armPoll(app: ProbeApp, url: string, intervalMs = 60_000): Promise<Response> {
  return app.app.request(
    '/spine/events',
    authed(tokenFor('lea'), {
      kind: 'ask',
      subject: 'repo:acme',
      opId: `ask-${Math.random()}`,
      body: {
        authority: 'andrewjon',
        question: 'is it live?',
        context: 'waiting on the rollout',
        unblocks: 'the announcement',
        check: JSON.stringify({
          kind: 'http_poll',
          url,
          intervalMs,
          when: [{ path: 'state', op: 'eq', value: 'green' }],
        }),
      },
    }),
  );
}

async function registerSubject(app: ProbeApp): Promise<void> {
  const res = await app.app.request(
    '/spine/subjects',
    authed(tokenFor('lea'), { id: 'repo:acme', type: 'repo' }),
  );
  expect(res.status, await res.text()).toBe(201);
}

// ─── Layer 1: the authoring pin ──────────────────────────────────────

describe('a poll at a private address is refused at the keyboard', () => {
  let ctx: ProbeApp;
  beforeEach(async () => {
    ctx = makeProbeApp();
    await registerSubject(ctx);
  });

  it('refuses every private, loopback, link-local and reserved literal', async () => {
    for (const url of PRIVATE_LITERALS) {
      const res = await armPoll(ctx, url);
      expect(res.status, `${url} must be refused at authoring`).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error, `${url}'s refusal must say why`).toMatch(
        /deployment's own network|private|loopback|link-local|reserved/,
      );
    }
    // NOTHING ARMED, and nothing landed. A refusal that left the ask in
    // the annex would leave a recipe a later engine might honour.
    expect(await (await ctx.app.request('/spine/checks', authed(tokenFor('lea')))).json()).toEqual({
      checks: [],
    });
  });

  it('still accepts a public https URL — the control on all of the above', async () => {
    // CONTRIBUTING's second question: would this pass against something
    // that refuses MORE than it should? A destination check that
    // refused every URL satisfies every assertion above.
    for (const url of [
      'https://ci.example.com/status',
      'https://93.184.216.34/status',
      'https://[2606:2800:220:1:248:1893:25c8:1946]/status',
      'https://api.github.com/repos/acme/api/commits',
    ]) {
      const res = await armPoll(ctx, url);
      expect(res.status, `${url} is public and must be accepted: ${await res.clone().text()}`).toBe(
        201,
      );
    }
  });

  it('judges the address, not the spelling', () => {
    // The unit beneath the endpoint suite, enumerated so a range that
    // stops being covered says which one.
    for (const [address, blocked] of [
      ['169.254.169.254', true],
      ['10.255.255.255', true],
      ['172.16.0.1', true],
      ['172.31.255.255', true],
      ['172.32.0.1', false], // just outside 172.16/12 — the classic off-by-one
      ['192.168.0.1', true],
      ['100.64.0.1', true],
      ['100.128.0.1', false], // just outside 100.64/10
      ['127.0.0.1', true],
      ['0.0.0.0', true],
      ['255.255.255.255', true],
      ['224.0.0.1', true],
      ['8.8.8.8', false],
      ['93.184.216.34', false],
      ['::1', true],
      ['::', true],
      ['fc00::1', true],
      ['fd12:3456::1', true],
      ['fe80::1', true],
      ['2606:2800:220:1:248:1893:25c8:1946', false],
      ['::ffff:127.0.0.1', true],
      ['::ffff:8.8.8.8', false],
      // THE HEX SPELLING OF THE SAME THING, which is what `new URL()`
      // normalises a v4-mapped literal to before anything here sees
      // it. A blocklist that read only the dotted form would wave the
      // normalised one straight through — and the normalised one is the
      // only form that ever actually arrives.
      ['::ffff:7f00:1', true], // 127.0.0.1
      ['::ffff:a9fe:a9fe', true], // 169.254.169.254
      ['::ffff:a00:5', true], // 10.0.0.5
      ['::ffff:808:808', false], // 8.8.8.8 — the control on the spelling
    ] as const) {
      expect(
        blockedAddressReason(address) !== null,
        `${address} should be ${blocked ? 'blocked' : 'reachable'}`,
      ).toBe(blocked);
    }
  });

  it('sees through the brackets a URL puts round a v6 literal', () => {
    // `new URL('https://[::1]/').hostname` is `[::1]`, and a check that
    // read that string would find no IP at all and wave it through.
    expect(hostAsIpLiteral('[::1]')).toBe('::1');
    expect(hostAsIpLiteral('::1')).toBe('::1');
    expect(hostAsIpLiteral('10.0.0.5')).toBe('10.0.0.5');
    expect(hostAsIpLiteral('ci.example.com')).toBeNull();
  });
});

// ─── Layer 2: the fire-time resolution ───────────────────────────────

describe('a poll at a NAME is checked against what it resolves to', () => {
  it('refuses a name that resolves into the deployment’s network', async () => {
    // The case the authoring pin structurally cannot catch, and the
    // one the verifier confirmed live: `vault.internal` is a
    // well-formed hostname.
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green' })]);
    const app = makeProbeApp({
      fetchImpl: fetchImpl.impl,
      egress: fakeEgress({ 'vault.internal': ['10.0.7.4'] }),
    });
    await registerSubject(app);
    const armed = await armPoll(app, 'https://vault.internal:8200/v1/secret/data/ci');
    expect(armed.status, 'a name is authorable — it is fire time that judges it').toBe(201);

    await app.probes.sweep();
    expect(fetchImpl.calls, 'the request must never go out').toHaveLength(0);
    const events = (await (
      await app.app.request('/spine/events?limit=500', authed(tokenFor('lea')))
    ).json()) as { events: SpineEvent[] };
    expect(events.events.filter((e) => e.kind === 'observation')).toEqual([]);
    const warned = app.logger.warn.mock.calls.find((c) => c[0] === 'spine: poll failed');
    expect(warned?.[1]).toMatchObject({
      reason: expect.stringContaining('10.0.7.4 is inside 10.0.0.0/8'),
    });
    expect(warned?.[1]).toMatchObject({
      reason: expect.stringContaining('server’s probe allowlist'),
    });
    app.db.close();
  });

  it('refuses a name that does not resolve at all', async () => {
    // `kubernetes.default.svc` resolves inside a cluster and nowhere
    // else. "We could not look it up" is not a reason to hand the name
    // to a socket and find out.
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green' })]);
    const app = makeProbeApp({ fetchImpl: fetchImpl.impl, egress: fakeEgress({}) });
    await registerSubject(app);
    expect((await armPoll(app, 'https://kubernetes.default.svc/api')).status).toBe(201);
    await app.probes.sweep();
    expect(fetchImpl.calls).toHaveLength(0);
    expect(
      app.logger.warn.mock.calls.find((c) => c[0] === 'spine: poll failed')?.[1],
    ).toMatchObject({ reason: expect.stringContaining('did not resolve') });
    app.db.close();
  });

  it('checks EVERY address, not the first', async () => {
    // A name with one public A record and one loopback A record reaches
    // loopback some of the time, and "some of the time" is not a
    // security property.
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green' })]);
    const app = makeProbeApp({
      fetchImpl: fetchImpl.impl,
      egress: fakeEgress({ 'split.example.com': ['93.184.216.34', '127.0.0.1'] }),
    });
    await registerSubject(app);
    expect((await armPoll(app, 'https://split.example.com/status')).status).toBe(201);
    await app.probes.sweep();
    expect(fetchImpl.calls).toHaveLength(0);
    app.db.close();
  });

  it('polls a name that resolves publicly — the control for the layer', async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green' })]);
    const app = makeProbeApp({ fetchImpl: fetchImpl.impl });
    await registerSubject(app);
    expect((await armPoll(app, 'https://ci.example.com/status')).status).toBe(201);
    await app.probes.sweep();
    expect(fetchImpl.calls).toHaveLength(1);
    const events = (await (
      await app.app.request('/spine/events?limit=500', authed(tokenFor('lea')))
    ).json()) as { events: SpineEvent[] };
    expect(events.events.filter((e) => e.kind === 'observation')).toHaveLength(1);
    app.db.close();
  });

  it('never resolves the author’s secret for a destination it refuses', async () => {
    // Ordering, and it is a decision: a refused destination must never
    // be one that has had a credential decrypted for it, even in
    // memory. The check runs before `resolveSecret`.
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green' })]);
    const app = makeProbeApp({
      fetchImpl: fetchImpl.impl,
      egress: fakeEgress({ 'vault.internal': ['10.0.7.4'] }),
    });
    await registerSubject(app);
    const secret = app.secrets.create({
      slug: 'ci-token',
      envName: 'CI_TOKEN',
      allMembers: true,
      creator: 'andrewjon',
    });
    app.secrets.setValue(secret.id, 'Bearer s3cret-value');
    const res = await app.app.request(
      '/spine/events',
      authed(tokenFor('lea'), {
        kind: 'ask',
        subject: 'repo:acme',
        opId: 'ask-secret',
        body: {
          authority: 'andrewjon',
          question: 'live?',
          context: 'x',
          unblocks: 'y',
          check: JSON.stringify({
            kind: 'http_poll',
            url: 'https://vault.internal/v1/x',
            intervalMs: 60_000,
            authSecret: 'ci-token',
            when: [],
          }),
        },
      }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    await app.probes.sweep();
    const reason = app.logger.warn.mock.calls.find((c) => c[0] === 'spine: poll failed')?.[1] as
      | { reason: string }
      | undefined;
    expect(reason?.reason).toContain('refusing to poll vault.internal');
    expect(reason?.reason, 'the refusal must not be about the secret').not.toContain(
      'resolves to nothing',
    );
    app.db.close();
  });
});

// ─── Layer 3: the pin travels with the request ───────────────────────

describe('the socket goes where the check said it could', () => {
  it('hands the transport the checked addresses, not a hostname to re-resolve', async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green' })]);
    const app = makeProbeApp({
      fetchImpl: fetchImpl.impl,
      egress: fakeEgress({ 'ci.example.com': ['93.184.216.34', '93.184.216.35'] }),
    });
    await registerSubject(app);
    await armPoll(app, 'https://ci.example.com/status');
    await app.probes.sweep();
    // BOTH, in order. A transport handed only the first would silently
    // lose the failover the resolver offered; a transport handed the
    // NAME would resolve it again, and the second answer of a
    // one-second-TTL round-robin record is how this control is
    // defeated in the wild.
    expect(fetchImpl.calls[0]?.init?.pinnedAddresses).toEqual(['93.184.216.34', '93.184.216.35']);
    app.db.close();
  });
});

// ─── The allowlist is server config ──────────────────────────────────

describe('an internal host is polled only when the SERVER says so', () => {
  it('refuses an internal name with no allowlist, and polls it with one', async () => {
    const map = { 'metrics.internal': ['10.1.2.3'] };
    const denied = scriptedFetch([() => jsonResponse({ state: 'green' })]);
    const closed = makeProbeApp({ fetchImpl: denied.impl, egress: fakeEgress(map) });
    await registerSubject(closed);
    await armPoll(closed, 'https://metrics.internal/status');
    await closed.probes.sweep();
    expect(denied.calls, 'no allowlist, no poll').toHaveLength(0);
    closed.db.close();

    const allowed = scriptedFetch([() => jsonResponse({ state: 'green' })]);
    const open = makeProbeApp({
      fetchImpl: allowed.impl,
      egress: fakeEgress(map, ['metrics.internal']),
    });
    await registerSubject(open);
    await armPoll(open, 'https://metrics.internal/status');
    await open.probes.sweep();
    expect(allowed.calls, 'the deployment excepted this host, so it polls').toHaveLength(1);
    // STILL PINNED. An allowlisted host is an approved destination, not
    // an unchecked one.
    expect(allowed.calls[0]?.init?.pinnedAddresses).toEqual(['10.1.2.3']);
    open.db.close();
  });

  it('is an exact hostname, never a suffix', async () => {
    // A suffix match is the convenient spelling that re-opens the hole:
    // `internal.example.com` on the allowlist would otherwise admit
    // `evil.internal.example.com`, which an attacker can register.
    const policy = createEgressPolicy({
      allowHosts: ['internal.example.com'],
      resolve: async () => ['10.0.0.9'],
    });
    expect((await policy.check('internal.example.com')).ok).toBe(true);
    expect((await policy.check('evil.internal.example.com')).ok).toBe(false);
    expect((await policy.check('xinternal.example.com')).ok).toBe(false);
  });

  it('cannot be granted from inside the recipe', async () => {
    // The property that makes the control mean anything: a member
    // cannot authorise their own exception in the same breath as
    // making the request. The recipe schema has no field for it, so
    // this is a compile-adjacent fact asserted at the wire — an unknown
    // key is simply not carried into the check.
    const app = makeProbeApp({ egress: fakeEgress({ 'vault.internal': ['10.0.7.4'] }) });
    await registerSubject(app);
    const res = await app.app.request(
      '/spine/events',
      authed(tokenFor('lea'), {
        kind: 'ask',
        subject: 'repo:acme',
        opId: 'ask-selfgrant',
        body: {
          authority: 'andrewjon',
          question: 'live?',
          context: 'x',
          unblocks: 'y',
          check: JSON.stringify({
            kind: 'http_poll',
            url: 'https://vault.internal/v1/x',
            intervalMs: 60_000,
            when: [],
            allowPrivate: true,
            allowHosts: ['vault.internal'],
          }),
        },
      }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const checks = (await (
      await app.app.request('/spine/checks', authed(tokenFor('lea')))
    ).json()) as { checks: { recipe: Record<string, unknown> }[] };
    expect(Object.keys(checks.checks[0]?.recipe ?? {})).not.toContain('allowPrivate');
    expect(Object.keys(checks.checks[0]?.recipe ?? {})).not.toContain('allowHosts');
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green' })]);
    void fetchImpl;
    await app.probes.sweep();
    const events = (await (
      await app.app.request('/spine/events?limit=500', authed(tokenFor('lea')))
    ).json()) as { events: SpineEvent[] };
    expect(events.events.filter((e) => e.kind === 'observation')).toEqual([]);
    app.db.close();
  });
});

// ─── E3: the pin guard, on the REAL transport ────────────────────────
//
// The connection-time half of §layer-3, exercised against
// `createPinnedFetch` itself rather than a scripted stand-in. The guard
// that matters is the one that refuses to hand a socket a hostname when
// the checked-address list came back empty: without it, a poll whose
// egress check somehow yielded zero addresses would fall through to the
// system resolver and undo the entire control. No network happens
// because the guard rejects before any connection is attempted.

describe('the pinned transport refuses to connect with no address (E3)', () => {
  it('rejects an empty pinnedAddresses instead of resolving the name itself', async () => {
    const transport = createPinnedFetch();
    await expect(
      transport(new URL('https://ci.example.com/status'), {
        method: 'GET',
        headers: {},
        redirect: 'manual',
        signal: AbortSignal.timeout(1_000),
        pinnedAddresses: [],
      }),
    ).rejects.toThrow(/no checked address to pin to/);
  });
});

// ─── E4: the secret is never resolved for a refused destination ──────
//
// The ordering claim, checked on the REAL path rather than by reading a
// log string: `resolveSecret` calls `secrets.getBySlug` and
// `secrets.resolveFor`, and neither may run for a destination the egress
// check refused. A refused host that has had a credential decrypted for
// it — even into memory the fetch never uses — is a handling of the
// team's secrets the refusal is supposed to prevent. Spies on the store
// are the direct assertion; the positive control proves the spies fire
// at all.

describe('the author’s secret is not resolved for a refused destination (E4)', () => {
  async function armSecretPoll(app: ProbeApp, url: string, opId: string): Promise<void> {
    const secret = app.secrets.create({
      slug: 'ci-token',
      envName: 'CI_TOKEN',
      allMembers: true,
      creator: 'andrewjon',
    });
    app.secrets.setValue(secret.id, 'Bearer s3cret-value');
    const res = await app.app.request(
      '/spine/events',
      authed(tokenFor('lea'), {
        kind: 'ask',
        subject: 'repo:acme',
        opId,
        body: {
          authority: 'andrewjon',
          question: 'live?',
          context: 'x',
          unblocks: 'y',
          check: JSON.stringify({
            kind: 'http_poll',
            url,
            intervalMs: 60_000,
            authSecret: 'ci-token',
            when: [],
          }),
        },
      }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
  }

  it('never touches the secrets store when egress refuses the host', async () => {
    const app = makeProbeApp({ egress: fakeEgress({ 'vault.internal': ['10.0.7.4'] }) });
    await registerSubject(app);
    await armSecretPoll(app, 'https://vault.internal/v1/x', 'ask-e4-refused');
    const getBySlug = vi.spyOn(app.secrets, 'getBySlug');
    const resolveFor = vi.spyOn(app.secrets, 'resolveFor');
    await app.probes.sweep();
    expect(
      getBySlug,
      'a refused destination must not have its secret looked up',
    ).not.toHaveBeenCalled();
    expect(
      resolveFor,
      'a refused destination must not have any secret resolved',
    ).not.toHaveBeenCalled();
    app.db.close();
  });

  it('DOES resolve the secret for an allowed destination — the control', async () => {
    const fetchImpl = scriptedFetch([() => jsonResponse({ state: 'green' })]);
    const app = makeProbeApp({
      fetchImpl: fetchImpl.impl,
      egress: fakeEgress({ 'ci.example.com': ['93.184.216.34'] }),
    });
    await registerSubject(app);
    await armSecretPoll(app, 'https://ci.example.com/status', 'ask-e4-allowed');
    const getBySlug = vi.spyOn(app.secrets, 'getBySlug');
    await app.probes.sweep();
    expect(
      getBySlug,
      'an allowed destination resolves the secret it was armed with',
    ).toHaveBeenCalledWith('ci-token');
    app.db.close();
  });
});
