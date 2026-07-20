/**
 * End-to-end tests for the `/members/*` admin CRUD surface.
 *
 * Every test wires a fresh in-memory SQLite + stub `persistMembers`
 * through `createApp` so the full auth + schema + in-memory mutation
 * path runs. `persistMembers` is a vi.fn() so we can assert it fires
 * exactly once per successful mutation and never on 4xx/5xx.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Member, Team, Teammate } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN_TOKEN = 'csuite_members_test_admin_token';
const OPERATOR_TOKEN = 'csuite_members_test_operator_token';
const AGENT_TOKEN = 'csuite_members_test_agent_token';

const TEAM: Team = {
  name: 'members-team',
  directive: 'Exercise member CRUD.',
  context: '',
  permissionPresets: {
    admin: [
      'team.manage',
      'members.manage',
      'objectives.create',
      'objectives.cancel',
      'objectives.reassign',
      'objectives.watch',
      'activity.read',
    ],
    operator: ['objectives.create', 'objectives.cancel', 'objectives.reassign'],
  },
};

interface Harness {
  app: ReturnType<typeof createApp>['app'];
  persistMembers: ReturnType<typeof vi.fn>;
  broker: Broker;
  tokens: ReturnType<typeof createTokenStoreFromMembers>;
}

function makeApp(): Harness {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const members = createMemberStore([
    {
      name: 'alice',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      token: ADMIN_TOKEN,
    },
    {
      name: 'bob',
      role: { title: 'manager', description: '' },
      permissions: ['objectives.create', 'objectives.cancel', 'objectives.reassign'],
      token: OPERATOR_TOKEN,
    },
    {
      name: 'scout',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: AGENT_TOKEN,
    },
  ]);
  broker.seedMembers(members.members());
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
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { app, persistMembers, broker, tokens };
}

function authed(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /members', () => {
  it('returns a Member[] (with instructions) when the caller has members.manage', async () => {
    const { app } = makeApp();
    const res = await app.request('/members', { headers: authed(ADMIN_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Member[] };
    expect(body.members.map((m) => m.name).sort()).toEqual(['alice', 'bob', 'scout']);
    expect(body.members.find((m) => m.name === 'alice')?.permissions).toContain('members.manage');
  });

  it('returns the public Teammate[] projection for non-admins', async () => {
    const { app } = makeApp();
    const res = await app.request('/members', { headers: authed(AGENT_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Teammate[] };
    expect(body.members.map((m) => m.name).sort()).toEqual(['alice', 'bob', 'scout']);
  });

  it('401s without auth', async () => {
    const { app } = makeApp();
    const res = await app.request('/members');
    expect(res.status).toBe(401);
  });
});

describe('POST /members', () => {
  it('creates a member and returns the plaintext token (admin only)', async () => {
    const { app, persistMembers, broker } = makeApp();
    const res = await app.request('/members', {
      method: 'POST',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'newbie',
        role: { title: 'engineer', description: '' },
        permissions: [],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { member: Teammate; token: string };
    expect(body.member.name).toBe('newbie');
    expect(body.token).toMatch(/^csuite_/);
    expect(persistMembers).toHaveBeenCalledTimes(1);
    expect(broker.hasMember('newbie')).toBe(true);
  });

  it('rejects non-admins', async () => {
    const { app, persistMembers } = makeApp();
    const res = await app.request('/members', {
      method: 'POST',
      headers: { ...authed(OPERATOR_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'nope',
        role: { title: 'engineer', description: '' },
        permissions: [],
      }),
    });
    expect(res.status).toBe(403);
    expect(persistMembers).not.toHaveBeenCalled();
  });

  it('resolves preset names in the permissions field', async () => {
    const { app } = makeApp();
    const res = await app.request('/members', {
      method: 'POST',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'helper',
        role: { title: 'manager', description: '' },
        permissions: ['operator'],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { member: Teammate; token: string };
    expect(body.member.permissions).toContain('objectives.create');
  });

  it('rejects unknown preset names', async () => {
    const { app } = makeApp();
    const res = await app.request('/members', {
      method: 'POST',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'broken',
        role: { title: 'engineer', description: '' },
        permissions: ['nonexistent-preset'],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /members/:name', () => {
  it('updates role title and description', async () => {
    const { app, persistMembers } = makeApp();
    const res = await app.request('/members/scout', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: { title: 'senior engineer', description: 'leads scouting' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Member;
    expect(body.role.title).toBe('senior engineer');
    expect(body.role.description).toBe('leads scouting');
    expect(persistMembers).toHaveBeenCalledTimes(1);
  });

  it('updates instructions', async () => {
    const { app, persistMembers } = makeApp();
    const res = await app.request('/members/scout', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions: 'pin this guidance into the system prompt' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Member;
    expect(body.instructions).toBe('pin this guidance into the system prompt');
    expect(persistMembers).toHaveBeenCalledTimes(1);
  });

  it('updates permissions via preset names', async () => {
    const { app } = makeApp();
    const res = await app.request('/members/scout', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: ['operator'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Member;
    expect(body.permissions).toContain('objectives.create');
    expect(body.permissions).toContain('objectives.cancel');
  });

  it('rejects callers without members.manage', async () => {
    const { app, persistMembers } = makeApp();
    const res = await app.request('/members/scout', {
      method: 'PATCH',
      headers: { ...authed(OPERATOR_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions: 'no go' }),
    });
    expect(res.status).toBe(403);
    expect(persistMembers).not.toHaveBeenCalled();
  });

  it('rejects an unknown preset name with 400', async () => {
    const { app, persistMembers } = makeApp();
    const res = await app.request('/members/scout', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: ['ghost-preset'] }),
    });
    expect(res.status).toBe(400);
    expect(persistMembers).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown member', async () => {
    const { app, persistMembers } = makeApp();
    const res = await app.request('/members/ghost', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions: 'x' }),
    });
    expect(res.status).toBe(404);
    expect(persistMembers).not.toHaveBeenCalled();
  });

  it('returns 400 on a malformed payload', async () => {
    const { app } = makeApp();
    const res = await app.request('/members/scout', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: { title: 123 } }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses to strip members.manage from the last admin (409)', async () => {
    const { app, persistMembers } = makeApp();
    const res = await app.request('/members/alice', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: [] }),
    });
    expect(res.status).toBe(409);
    expect(persistMembers).not.toHaveBeenCalled();
  });

  it('allows stripping members.manage when another admin exists', async () => {
    const { app } = makeApp();
    // Promote bob to admin first.
    await app.request('/members/bob', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: ['admin'] }),
    });
    // Now safely demote alice.
    const res = await app.request('/members/alice', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: [] }),
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /members/:name', () => {
  it('refuses to delete the last admin', async () => {
    const { app } = makeApp();
    const res = await app.request('/members/alice', {
      method: 'DELETE',
      headers: authed(ADMIN_TOKEN),
    });
    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown member', async () => {
    const { app, persistMembers } = makeApp();
    const res = await app.request('/members/ghost', {
      method: 'DELETE',
      headers: authed(ADMIN_TOKEN),
    });
    expect(res.status).toBe(404);
    expect(persistMembers).not.toHaveBeenCalled();
  });

  it('rejects callers without members.manage', async () => {
    const { app, persistMembers } = makeApp();
    const res = await app.request('/members/scout', {
      method: 'DELETE',
      headers: authed(OPERATOR_TOKEN),
    });
    expect(res.status).toBe(403);
    expect(persistMembers).not.toHaveBeenCalled();
  });

  it('deletes a non-admin and revokes their tokens (cascade)', async () => {
    const { app, persistMembers, tokens } = makeApp();
    expect(tokens.listForMember('scout').length).toBe(1);
    const res = await app.request('/members/scout', {
      method: 'DELETE',
      headers: authed(ADMIN_TOKEN),
    });
    expect(res.status).toBe(204);
    expect(persistMembers).toHaveBeenCalledTimes(1);
    expect(tokens.listForMember('scout')).toEqual([]);
    // Their old bearer token is now unusable end-to-end.
    const followup = await app.request('/roster', { headers: authed(AGENT_TOKEN) });
    expect(followup.status).toBe(401);
  });

  it('lets a non-last admin be deleted', async () => {
    const { app } = makeApp();
    // Promote bob to admin so alice → admin → 2 admins.
    await app.request('/members/bob', {
      method: 'PATCH',
      headers: { ...authed(ADMIN_TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: ['admin'] }),
    });
    const res = await app.request('/members/bob', {
      method: 'DELETE',
      headers: authed(ADMIN_TOKEN),
    });
    expect(res.status).toBe(204);
  });
});
