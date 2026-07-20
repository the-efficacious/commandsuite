/**
 * `POST /presence/activity` + roster integration tests.
 *
 * Pins:
 *   - Bearer-auth subscriber can report an activity state and it
 *     surfaces on `/roster` as `connected[i].activity` plus the
 *     back-compat `busy` mirror (busy === activity === 'working').
 *   - `blocked` surfaces distinctly and reads as NOT busy.
 *   - Cookie-auth (web UI) callers receive 403 — the runner is the
 *     only thing that should be filing activity reports.
 *   - Reporting `state: 'idle'` clears the entry immediately.
 *   - Stale entries (past the TTL) auto-resolve to idle on the next
 *     roster read.
 *   - Member deletion forgets any pending activity entry.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { RosterResponse, Team } from 'csuite-sdk/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_TTL_MS } from '../src/activity-tracker.js';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN_TOKEN = 'csuite_activity_test_admin_token';
const AGENT_TOKEN = 'csuite_activity_test_agent_token';

const TEAM: Team = {
  name: 'activity-test',
  directive: 'Verify activity presence flow.',
  context: '',
  permissionPresets: {},
};

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface Harness {
  app: ReturnType<typeof createApp>['app'];
  sessions: SessionStore;
  advance: (ms: number) => void;
}

function makeApp(): Harness {
  let now = 1_700_000_000_000;
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
  // Register so /roster sees them as recognized presences.
  for (const name of ['alice', 'scout']) void broker.register(name);
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const persistMembers = vi.fn();
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    persistMembers,
    now: () => now,
    logger: silentLogger(),
  });
  return {
    app,
    sessions,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function authBearer(token: string, body?: unknown, method = 'POST'): RequestInit {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

async function rosterScout(
  app: Harness['app'],
): Promise<RosterResponse['connected'][number] | undefined> {
  const roster = await app.request('/roster', {
    method: 'GET',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  expect(roster.status).toBe(200);
  const body = (await roster.json()) as RosterResponse;
  return body.connected.find((p) => p.name === 'scout');
}

afterEach(() => vi.restoreAllMocks());

describe('POST /presence/activity', () => {
  it('accepts a working report and surfaces activity + busy on /roster', async () => {
    const { app } = makeApp();

    const post = await app.request(
      '/presence/activity',
      authBearer(AGENT_TOKEN, { state: 'working' }),
    );
    expect(post.status).toBe(204);

    const scout = await rosterScout(app);
    expect(scout?.activity).toBe('working');
    expect(scout?.busy).toBe(true);

    const roster = await app.request('/roster', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const body = (await roster.json()) as RosterResponse;
    const alice = body.connected.find((p) => p.name === 'alice');
    // Never reported → idle → both fields absent.
    expect(alice?.activity).toBeUndefined();
    expect(alice?.busy).toBeFalsy();
  });

  it('surfaces blocked distinctly and as NOT busy', async () => {
    const { app } = makeApp();
    await app.request('/presence/activity', authBearer(AGENT_TOKEN, { state: 'blocked' }));
    const scout = await rosterScout(app);
    expect(scout?.activity).toBe('blocked');
    expect(scout?.busy).toBe(false);
  });

  it('ignores the optional busy mirror and derives busy from state', async () => {
    const { app } = makeApp();
    // Runner lies: state blocked but busy:true. Server trusts state.
    await app.request(
      '/presence/activity',
      authBearer(AGENT_TOKEN, { state: 'blocked', busy: true }),
    );
    const scout = await rosterScout(app);
    expect(scout?.activity).toBe('blocked');
    expect(scout?.busy).toBe(false);
  });

  it('clears immediately on `state: "idle"`', async () => {
    const { app } = makeApp();
    await app.request('/presence/activity', authBearer(AGENT_TOKEN, { state: 'working' }));
    await app.request('/presence/activity', authBearer(AGENT_TOKEN, { state: 'idle' }));

    const scout = await rosterScout(app);
    expect(scout?.activity).toBeUndefined();
    expect(scout?.busy).toBeFalsy();
  });

  it('rejects a session-cookie caller with 403 (runner-only)', async () => {
    const { app, sessions } = makeApp();
    const session = sessions.create('alice', null);
    const res = await app.request('/presence/activity', {
      method: 'POST',
      headers: {
        Cookie: `csuite_session=${session.id}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state: 'working' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/runner-only/i);
  });

  it('rejects unauthenticated callers with 401', async () => {
    const { app } = makeApp();
    const res = await app.request('/presence/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'working' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed payload with 400', async () => {
    const { app } = makeApp();
    // Missing `state`.
    const missing = await app.request(
      '/presence/activity',
      authBearer(AGENT_TOKEN, { busy: true }),
    );
    expect(missing.status).toBe(400);
    // Unknown state value.
    const bogus = await app.request(
      '/presence/activity',
      authBearer(AGENT_TOKEN, { state: 'spinning' }),
    );
    expect(bogus.status).toBe(400);
  });

  it('TTL resolves stale entries to idle on the next roster read', async () => {
    const { app, advance } = makeApp();
    await app.request('/presence/activity', authBearer(AGENT_TOKEN, { state: 'working' }));

    // Advance past the TTL without a heartbeat.
    advance(ACTIVITY_TTL_MS + 1);

    const scout = await rosterScout(app);
    expect(scout?.activity).toBeUndefined();
    expect(scout?.busy).toBeFalsy();
  });

  it('member delete forgets any pending activity entry', async () => {
    const { app } = makeApp();
    // scout (the agent) reports working.
    await app.request('/presence/activity', authBearer(AGENT_TOKEN, { state: 'working' }));
    // alice deletes scout.
    const del = await app.request('/members/scout', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(del.status).toBe(204);

    const scout = await rosterScout(app);
    expect(scout?.activity).toBeUndefined();
    expect(scout?.busy).toBeFalsy();
  });
});
