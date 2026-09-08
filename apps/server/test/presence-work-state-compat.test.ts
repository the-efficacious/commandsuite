/**
 * D6 wire-compat window — `POST /presence/activity` vs
 * `POST /presence/work-state`.
 *
 * D6 finishes the rename PR #194 started in the type layer and
 * deliberately left off the wire. For ONE release the broker serves
 * both paths from one handler and the roster carries both spellings of
 * every renamed field, so a client on either side of the rename reads
 * the same member. This file is the test that has to fail if that stops
 * being true, and it asserts the three things that can silently break:
 *
 *   1. THE TWO ROUTES ARE ONE ROUTE. The same report posted to the old
 *      path and to the new one must produce a deep-equal `Presence` —
 *      not "both produce something", not "both 204" — because the
 *      cheap way to ship a compat alias is a second handler that
 *      drifts. Deep equality over the whole row is what refuses that.
 *
 *   2. THE ROW CARRIES BOTH SPELLINGS, WITH THE SAME VALUE. Emitting
 *      only `workState` breaks every un-upgraded reader; emitting only
 *      `activity` means the rename never happened. Emitting both with
 *      DIFFERENT values is worse than either. So the assertion is on
 *      the pair, and it is `toBe`, not truthiness.
 *
 *   3. THE EXACT KEY SET OF `Presence` ON THE WIRE. A field cannot
 *      vanish and a field cannot appear without this test being
 *      updated. Absence assertions alone would be satisfied by a
 *      broker that emits nothing at all, so the key set is pinned in
 *      both directions — reported and unreported — and each pin is
 *      accompanied by an assertion that the row is genuinely populated.
 *
 * Plus the deprecation signal: the old path answers `Deprecation: true`
 * and a `Link: …; rel="successor-version"` header and logs one warn
 * line naming the member, so a runner still on the old spelling is
 * findable before the path is removed in the next minor. The new path
 * must NOT carry that header — a deprecation signal on the successor
 * would train every operator to ignore it.
 */

import {
  Broker,
  createApp,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
  WORK_STATE_TTL_MS,
} from 'csuite-core';
import { PATHS } from 'csuite-sdk/protocol';
import type { Presence, RosterResponse, Team } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN_TOKEN = 'csuite_ws_compat_admin_token';
const AGENT_TOKEN = 'csuite_ws_compat_agent_token';

const TEAM: Team = { name: 'ws-compat', context: '', permissionPresets: {} };

/**
 * The complete key set of a `Presence` row for a member who has
 * reported a non-idle work state, on this broker's configuration
 * (no capture-health store, no diagnostics store — those two add
 * `captureHealth` / `diagnosticsUnresolved` / `diagnosticsRetention`
 * and have their own suites).
 *
 * `workState` is canonical; `activity` is the pre-D6 spelling and
 * `busy` the older boolean mirror. Both deprecated keys leave in the
 * next minor and this list shrinks by two.
 */
const REPORTED_PRESENCE_KEYS = [
  'activity',
  'authBlocked',
  'busy',
  'clientReports',
  'connected',
  'createdAt',
  'executor',
  'lastSeen',
  'name',
  'role',
  'runnerReports',
  'unreportedConnections',
  'workState',
].sort();

/** The same row for a member who has reported nothing. */
const UNREPORTED_PRESENCE_KEYS = REPORTED_PRESENCE_KEYS.filter(
  (k) => k !== 'workState' && k !== 'activity' && k !== 'busy',
);

interface Harness {
  app: ReturnType<typeof createApp>['app'];
  sessions: SqliteSessionStore;
  warnings: { message: string; fields?: Record<string, unknown> }[];
}

async function makeApp(): Promise<Harness> {
  const now = 1_700_000_000_000;
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => now,
    idFactory: () => 'msg-fixed',
  });
  const members = createMemberStore([
    {
      name: 'alice',
      role: { title: 'admin', description: '' },
      permissions: ['members.manage'],
      token: ADMIN_TOKEN,
    },
    {
      name: 'scout',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: AGENT_TOKEN,
    },
  ]);
  for (const name of ['alice', 'scout']) void broker.register(name);
  const db = openDatabase(':memory:');
  const sessions = new SqliteSessionStore(db);
  const tokens = await createTokenStoreFromMembers(db, members);
  const warnings: Harness['warnings'] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    notice: () => {},
    warn: (message: string, fields?: Record<string, unknown>) => {
      warnings.push(fields === undefined ? { message } : { message, fields });
    },
    error: () => {},
    critical: () => {},
    child() {
      return this;
    },
  };
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    persistMembers: vi.fn(),
    now: () => now,
    logger: logger as unknown as Parameters<typeof createApp>[0]['logger'],
  });
  return { app, sessions, warnings };
}

function report(path: string, state: string): [string, RequestInit] {
  return [
    path,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${AGENT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    },
  ];
}

async function roster(app: Harness['app']): Promise<RosterResponse> {
  const res = await app.request('/roster', {
    method: 'GET',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as RosterResponse;
}

function scoutOf(body: RosterResponse): Presence {
  const scout = body.connected.find((p) => p.name === 'scout');
  // Assert the row exists before asserting anything about its shape —
  // an absent row would satisfy every field assertion below vacuously.
  expect(scout).toBeDefined();
  return scout as Presence;
}

describe('D6 compat window: /presence/activity and /presence/work-state', () => {
  it('both paths are registered under the SDK constants they claim', () => {
    // The two routes below are addressed by literal string in this
    // file so a change to either constant is caught here rather than
    // silently rerouting every assertion to whatever the constant now
    // says.
    expect(PATHS.presenceWorkState).toBe('/presence/work-state');
    expect(PATHS.presenceActivity).toBe('/presence/activity');
  });

  it('the same report on either route yields a deep-equal Presence', async () => {
    const viaOld = await makeApp();
    const viaNew = await makeApp();

    const oldPost = await viaOld.app.request(...report('/presence/activity', 'blocked'));
    const newPost = await viaNew.app.request(...report('/presence/work-state', 'blocked'));
    // Assert the writes landed before comparing what they produced —
    // two 404s also compare equal.
    expect(oldPost.status).toBe(204);
    expect(newPost.status).toBe(204);

    const oldRow = scoutOf(await roster(viaOld.app));
    const newRow = scoutOf(await roster(viaNew.app));

    // The whole row, not a chosen field: a second handler that drifts
    // in any other projection fails here.
    expect(oldRow).toEqual(newRow);
    // And it is a POPULATED row, so the equality above is not two
    // empty objects agreeing.
    expect(newRow.workState).toBe('blocked');
  });

  it('a reported row carries workState, the deprecated activity twin, and busy, in agreement', async () => {
    const { app } = await makeApp();
    expect((await app.request(...report('/presence/work-state', 'blocked'))).status).toBe(204);

    const scout = scoutOf(await roster(app));
    expect(scout.workState).toBe('blocked');
    // Same VALUE, not merely present — a compat field that drifts from
    // its successor is worse than one that is missing.
    expect(scout.activity).toBe(scout.workState);
    // `busy` is the lossy third spelling: it cannot express `blocked`,
    // so it is false here and that is the whole reason `workState`
    // exists.
    expect(scout.busy).toBe(false);
  });

  it('the roster response carries workStateWindowMs and the deprecated twin, in agreement', async () => {
    const { app } = await makeApp();
    const body = await roster(app);
    expect(body.workStateWindowMs).toBe(WORK_STATE_TTL_MS);
    expect(body.activityWindowMs).toBe(body.workStateWindowMs);
  });

  it('pins the exact key set of a reported Presence on the wire', async () => {
    const { app } = await makeApp();
    expect((await app.request(...report('/presence/work-state', 'blocked'))).status).toBe(204);

    const scout = scoutOf(await roster(app));
    // Both directions at once: a key that vanishes and a key that
    // appears both fail. `toEqual` on the sorted list is the whole
    // contract, not a subset check.
    expect(Object.keys(scout).sort()).toEqual(REPORTED_PRESENCE_KEYS);
  });

  it('pins the exact key set of an unreported Presence on the wire', async () => {
    const { app } = await makeApp();
    // alice never reports, so the three work-state keys are absent —
    // and every other key is still there. Asserting only the absence
    // would pass against a broker that emitted an empty row.
    const body = await roster(app);
    const alice = body.connected.find((p) => p.name === 'alice');
    expect(alice).toBeDefined();
    expect(Object.keys(alice as Presence).sort()).toEqual(UNREPORTED_PRESENCE_KEYS);
    expect((alice as Presence).name).toBe('alice');
  });

  it('the deprecated route emits its deprecation signal; the successor does not', async () => {
    const { app, warnings } = await makeApp();

    const old = await app.request(...report('/presence/activity', 'working'));
    expect(old.status).toBe(204);
    expect(old.headers.get('Deprecation')).toBe('true');
    expect(old.headers.get('Link')).toBe('</presence/work-state>; rel="successor-version"');

    // The log line is the half an operator greps for; it has to name
    // the member, or a busy broker tells you a stale client exists and
    // not which one.
    const deprecation = warnings.filter((w) => w.message === 'deprecated route');
    expect(deprecation).toHaveLength(1);
    expect(deprecation[0]?.fields).toMatchObject({
      route: '/presence/activity',
      successor: '/presence/work-state',
      member: 'scout',
    });

    const fresh = await makeApp();
    const next = await fresh.app.request(...report('/presence/work-state', 'working'));
    expect(next.status).toBe(204);
    expect(next.headers.get('Deprecation')).toBeNull();
    expect(next.headers.get('Link')).toBeNull();
    expect(fresh.warnings.filter((w) => w.message === 'deprecated route')).toEqual([]);
  });

  it('the deprecated route still refuses a cookie caller, with the signal attached', async () => {
    const { app, sessions } = await makeApp();
    // The compat alias must not become a hole in the bearer-only rule.
    // A cookie caller authenticates, reaches the handler, and is
    // refused there — so it gets BOTH the 403 and the header telling
    // it which path is going away. (An unauthenticated caller is
    // refused by the auth middleware before the route runs and
    // therefore carries no deprecation header; that is the assertion
    // below, and it is deliberate — the signal belongs to callers the
    // broker actually served.)
    const session = await sessions.create('alice', null);
    const cookie = await app.request('/presence/activity', {
      method: 'POST',
      headers: { Cookie: `csuite_session=${session.id}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'working' }),
    });
    expect(cookie.status).toBe(403);
    expect(((await cookie.json()) as { error: string }).error).toMatch(/runner-only/i);
    expect(cookie.headers.get('Deprecation')).toBe('true');

    const anon = await app.request('/presence/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'working' }),
    });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('Deprecation')).toBeNull();
  });
});
