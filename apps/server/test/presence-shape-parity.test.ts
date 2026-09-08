/**
 * `GET /roster` and `GET /team/status` owe the SAME `Presence`.
 *
 * Both routes put a value typed `Presence` on the wire. Until D9 they
 * populated it differently: the roster enriched each registry record
 * with live state, capture health and completeness diagnostics inline in
 * its handler, and `composeTeamStatus` forwarded the registry record
 * untouched. Five axes were therefore absent on every `/team/status`
 * member, always — and two of the five have an absence rule that turns
 * the omission into a false statement. `captureHealth` absent means
 * "this broker has no opinion", never "healthy"
 * (`packages/sdk/src/types.ts`); `diagnosticsUnresolved` absent means
 * "this broker retains no diagnostics", never "this member is clean". A
 * broker answering `gap` on one route said "no opinion" on the other,
 * for the same member on the same tick.
 *
 * These two tests are shape tests on purpose. `toMatchObject` is a
 * subset assertion and passes against exactly the response that has the
 * bug, so:
 *
 *   1. the two presence objects are compared with `toEqual` — field for
 *      field, absences included;
 *   2. the key set is pinned exactly, on BOTH routes, so a roster-only
 *      field added to one handler fails here rather than shipping as a
 *      silent absence on the other.
 */

import type { CaptureHealth, CaptureHealthStore } from 'csuite-core';
import {
  Broker,
  createApp,
  createDiagnosticStore,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import { PATHS } from 'csuite-sdk/protocol';
import type { Presence, RosterResponse, Team, TeamStatusResponse } from 'csuite-sdk/types';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { silentLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN_TOKEN = 'csuite_parity_test_admin_token';
const BUILDER_TOKEN = 'csuite_parity_test_builder_token';
const NOW = 1_700_000_000_000;
const TEAM: Team = { name: 'parity', context: '', permissionPresets: {} };

/**
 * Every field a wired broker publishes on a non-idle member. Written
 * out rather than derived, because a derived expectation would move
 * with the bug it is supposed to catch.
 */
const ENRICHED_PRESENCE_KEYS = [
  'activity',
  'authBlocked',
  'busy',
  'captureHealth',
  'clientReports',
  'connected',
  'createdAt',
  'diagnosticsRetention',
  'diagnosticsUnresolved',
  'executor',
  'lastSeen',
  'name',
  'role',
  'runnerReports',
  'unreportedConnections',
];

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

/** A store that answers from a fixed map — the detector has its own tests. */
function fixedHealth(byMember: Record<string, CaptureHealth>): CaptureHealthStore {
  return { forMember: (name) => byMember[name] ?? { state: 'ok' } };
}

/**
 * One broker with capture health and diagnostics wired, two registered
 * members, and `builder` reporting `blocked` — the state in which every
 * enriched axis has something to say.
 */
async function fixture() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => NOW,
    idFactory: () => 'msg-fixed',
  });
  const members = createMemberStore([
    {
      name: 'admin',
      role: { title: 'lead', description: 'runs the team' },
      permissions: ['members.manage'],
      token: ADMIN_TOKEN,
    },
    {
      name: 'builder',
      role: { title: 'engineer', description: 'builds' },
      permissions: [],
      token: BUILDER_TOKEN,
    },
  ]);
  await broker.register('admin');
  await broker.register('builder');
  const diagnostics = createDiagnosticStore(db);
  diagnostics.emit.correlatorRawCaptureFailed('builder', new Error('capture died'));
  const { app } = createApp({
    broker,
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore(TEAM),
    captureHealth: fixedHealth({ builder: { state: 'gap', unmatchedMarkers: 3, since: 1 } }),
    diagnostics,
    version: '1.0.0',
    logger: silentLogger(),
    now: () => NOW,
  });
  // A runner report, so `activity`/`busy` are populated rather than
  // omitted-because-idle on both routes.
  const reported = await app.request(PATHS.presenceActivity, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BUILDER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state: 'blocked' }),
  });
  expect(reported.status).toBe(204);
  return app;
}

async function rosterPresence(app: Awaited<ReturnType<typeof fixture>>, name: string) {
  const res = await app.request(PATHS.roster, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as RosterResponse;
  return body.connected.find((p) => p.name === name);
}

async function teamStatusPresence(app: Awaited<ReturnType<typeof fixture>>, name: string) {
  const res = await app.request(PATHS.teamStatus, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as TeamStatusResponse;
  return body.members.find((row) => row.member.name === name)?.presence ?? undefined;
}

describe('presence shape parity across /roster and /team/status', () => {
  it('returns the same presence object field for field for the same member', async () => {
    const app = await fixture();

    const fromRoster = await rosterPresence(app, 'builder');
    const fromStatus = await teamStatusPresence(app, 'builder');

    // Deep equality, not a subset match: an axis present on one route
    // and absent on the other is the defect, and `toMatchObject` cannot
    // see it.
    expect(fromStatus).toEqual(fromRoster);
    // The state that made the absence a lie, spelled out so a future
    // reader can see this fixture is not trivially equal-because-empty.
    expect(fromStatus?.captureHealth).toBe('gap');
    expect(fromStatus?.diagnosticsUnresolved).toBe(1);
    expect(fromStatus?.activity).toBe('blocked');
    expect(fromStatus?.busy).toBe(false);
  });

  it('pins the full enriched key set on both routes', async () => {
    const app = await fixture();

    const fromRoster = await rosterPresence(app, 'builder');
    const fromStatus = await teamStatusPresence(app, 'builder');

    // Exact sets, on both. A roster-only field added to one handler
    // fails here instead of shipping as a silent absence on the other.
    expect(Object.keys(fromRoster ?? {}).sort()).toEqual(ENRICHED_PRESENCE_KEYS);
    expect(Object.keys(fromStatus ?? {}).sort()).toEqual(ENRICHED_PRESENCE_KEYS);
  });

  it('agrees on an idle member too, where the omitted axes are the load-bearing ones', async () => {
    const app = await fixture();

    // `admin` filed no runner report, so `activity`/`busy` are absent
    // by the rule that says absence reads as idle — while capture
    // health and diagnostics stay EXPLICIT, because their absence rule
    // is the opposite one.
    const fromRoster = await rosterPresence(app, 'admin');
    const fromStatus = await teamStatusPresence(app, 'admin');

    expect(fromStatus).toEqual(fromRoster);
    const idleKeys: Array<keyof Presence | string> = ENRICHED_PRESENCE_KEYS.filter(
      (key) => key !== 'activity' && key !== 'busy',
    );
    expect(Object.keys(fromStatus ?? {}).sort()).toEqual(idleKeys);
    expect(fromStatus?.captureHealth).toBe('ok');
    expect(fromStatus?.diagnosticsUnresolved).toBe(0);
  });
});
