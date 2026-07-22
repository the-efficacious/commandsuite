/**
 * End-to-end tests for the device-code enrollment endpoints.
 *
 * Wires `createApp` with a real `TokenStore` + `EnrollmentStore` on
 * an in-memory SQLite, then drives the full flow through HTTP:
 *
 *   POST /enroll                     — anonymous, mints user/device codes
 *   POST /enroll/poll                — anonymous, RFC 8628 outcomes
 *   GET  /enroll/pending             — director scope
 *   POST /enroll/approve             — director scope, bind/create
 *   POST /enroll/reject              — director scope
 *
 * Coverage focus: RFC 8628 wire shape, permission-based gating, single-use
 * consume on approval, expired_token / access_denied / slow_down
 * surface correctness, multi-token semantics after approval.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type {
  DeviceAuthorizationResponse,
  PendingEnrollment,
  Team,
  TokenInfo,
} from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { EnrollmentStore } from '../src/enrollments.js';
import { createMemberStore } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN_TOKEN = 'csuite_enroll_admin_token';
const NON_ADMIN_TOKEN = 'csuite_enroll_engineer_token';

const TEAM: Team = {
  name: 'enroll-team',
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
    operator: ['objectives.create'],
  },
};

interface Harness {
  app: ReturnType<typeof createApp>['app'];
  enrollments: EnrollmentStore;
  tokens: ReturnType<typeof createTokenStoreFromMembers>;
  persistMembers: ReturnType<typeof vi.fn>;
}

function makeApp(options: { now?: () => number } = {}): Harness {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const members = createMemberStore([
    {
      name: 'admin-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
      token: ADMIN_TOKEN,
    },
    {
      name: 'engineer-1',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: NON_ADMIN_TOKEN,
    },
  ]);
  broker.seedMembers(members.members());
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db, options.now !== undefined ? { now: options.now } : {});
  const tokens = createTokenStoreFromMembers(
    db,
    members,
    options.now !== undefined ? { now: options.now } : {},
  );
  const enrollments = new EnrollmentStore(
    db,
    options.now !== undefined ? { now: options.now } : {},
  );
  const persistMembers = vi.fn();
  const { app } = createApp({
    broker,
    members,
    tokens,
    enrollments,
    sessions,
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    persistMembers,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { app, enrollments, tokens, persistMembers };
}

function bearer(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

describe('POST /enroll', () => {
  it('mints (deviceCode, userCode) without auth', async () => {
    const { app } = makeApp();
    const res = await app.request('/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelHint: 'prod-vm' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeviceAuthorizationResponse;
    expect(body.deviceCode).toMatch(/^csuite-dc_/);
    expect(body.userCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(body.verificationUri).toBe('/enroll');
    expect(body.verificationUriComplete).toContain('?code=');
    expect(body.expiresIn).toBeGreaterThan(0);
    expect(body.interval).toBeGreaterThan(0);
  });

  it('rejects malformed payload', async () => {
    const { app } = makeApp();
    const res = await app.request('/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelHint: 'x'.repeat(100) }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /enroll/poll', () => {
  it('returns authorization_pending while waiting', async () => {
    const { app } = makeApp();
    const mintRes = await app.request('/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const mint = (await mintRes.json()) as DeviceAuthorizationResponse;
    const pollRes = await app.request('/enroll/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: mint.deviceCode }),
    });
    expect(pollRes.status).toBe(400);
    const body = (await pollRes.json()) as { error: string };
    expect(body.error).toBe('authorization_pending');
  });

  it('returns expired_token for unknown device codes (no existence leak)', async () => {
    const { app } = makeApp();
    // 43 base64url chars — same length the server mints, but no row exists.
    const fakeCode = `csuite-dc_${'A'.repeat(43)}`;
    const res = await app.request('/enroll/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: fakeCode }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('expired_token');
  });
});

describe('POST /enroll/approve', () => {
  it('requires members.manage', async () => {
    const { app } = makeApp();
    const mintRes = await app.request('/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const mint = (await mintRes.json()) as DeviceAuthorizationResponse;
    const res = await app.request('/enroll/approve', {
      method: 'POST',
      headers: bearer(NON_ADMIN_TOKEN),
      body: JSON.stringify({
        userCode: mint.userCode,
        mode: 'bind',
        memberName: 'admin-1',
      }),
    });
    expect(res.status).toBe(403);
  });

  it('approves a bind request, then a poll resolves with the token', async () => {
    const { app, tokens } = makeApp();
    const mintRes = await app.request('/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelHint: 'eng-laptop' }),
    });
    const mint = (await mintRes.json()) as DeviceAuthorizationResponse;
    const approveRes = await app.request('/enroll/approve', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({
        userCode: mint.userCode,
        mode: 'bind',
        memberName: 'engineer-1',
        label: 'eng-laptop',
      }),
    });
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as {
      tokenInfo: TokenInfo;
      member: { name: string };
    };
    expect(approveBody.member.name).toBe('engineer-1');
    expect(approveBody.tokenInfo.label).toBe('eng-laptop');
    expect(approveBody.tokenInfo.origin).toBe('enroll');

    // Engineer-1's token list now has TWO tokens — the legacy
    // bootstrap one plus the freshly-issued enrollment one.
    expect(tokens.listForMember('engineer-1')).toHaveLength(2);

    const pollRes = await app.request('/enroll/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: mint.deviceCode }),
    });
    expect(pollRes.status).toBe(200);
    const pollBody = (await pollRes.json()) as {
      token: string;
      tokenId: string;
      member: { name: string };
    };
    expect(pollBody.token).toMatch(/^csuite_/);
    expect(pollBody.tokenId).toBe(approveBody.tokenInfo.id);
    expect(pollBody.member.name).toBe('engineer-1');

    // The token works for actual auth.
    const rosterRes = await app.request('/roster', {
      headers: { Authorization: `Bearer ${pollBody.token}` },
    });
    expect(rosterRes.status).toBe(200);

    // Replay the poll → expired_token (row consumed).
    const replayRes = await app.request('/enroll/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: mint.deviceCode }),
    });
    expect(replayRes.status).toBe(400);
  });

  it('approves a create request, instantiating a new member', async () => {
    const { app, persistMembers } = makeApp();
    const mintRes = await app.request('/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const mint = (await mintRes.json()) as DeviceAuthorizationResponse;
    const approveRes = await app.request('/enroll/approve', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({
        userCode: mint.userCode,
        mode: 'create',
        memberName: 'newcomer',
        role: { title: 'engineer', description: 'fresh' },
        instructions: 'welcome to the team',
        permissions: ['operator'],
      }),
    });
    expect(approveRes.status).toBe(200);
    expect(persistMembers).toHaveBeenCalledTimes(1);

    const pollRes = await app.request('/enroll/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: mint.deviceCode }),
    });
    const pollBody = (await pollRes.json()) as {
      token: string;
      member: { name: string };
    };
    expect(pollBody.member.name).toBe('newcomer');

    const briefingRes = await app.request('/briefing', {
      headers: { Authorization: `Bearer ${pollBody.token}` },
    });
    expect(briefingRes.status).toBe(200);
  });

  it('rejects a create request that collides with an existing member', async () => {
    const { app } = makeApp();
    const mintRes = await app.request('/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const mint = (await mintRes.json()) as DeviceAuthorizationResponse;
    const res = await app.request('/enroll/approve', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({
        userCode: mint.userCode,
        mode: 'create',
        memberName: 'engineer-1',
        role: { title: 'engineer', description: '' },
        permissions: [],
      }),
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /enroll/reject', () => {
  it('marks rejected, poll resolves with access_denied + reason', async () => {
    const { app } = makeApp();
    const mintRes = await app.request('/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const mint = (await mintRes.json()) as DeviceAuthorizationResponse;
    const rejectRes = await app.request('/enroll/reject', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({
        userCode: mint.userCode,
        reason: 'unrecognized device',
      }),
    });
    expect(rejectRes.status).toBe(204);
    const pollRes = await app.request('/enroll/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: mint.deviceCode }),
    });
    expect(pollRes.status).toBe(400);
    const body = (await pollRes.json()) as { error: string; errorDescription?: string };
    expect(body.error).toBe('access_denied');
    expect(body.errorDescription).toBe('unrecognized device');
  });
});

describe('GET /enroll/pending', () => {
  it('lists pending rows for admins, denies non-admins', async () => {
    const { app } = makeApp();
    await app.request('/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelHint: 'first' }),
    });
    await app.request('/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelHint: 'second' }),
    });
    const adminRes = await app.request('/enroll/pending', {
      headers: bearer(ADMIN_TOKEN),
    });
    expect(adminRes.status).toBe(200);
    const adminBody = (await adminRes.json()) as { enrollments: PendingEnrollment[] };
    expect(adminBody.enrollments).toHaveLength(2);
    const nonAdminRes = await app.request('/enroll/pending', {
      headers: bearer(NON_ADMIN_TOKEN),
    });
    expect(nonAdminRes.status).toBe(403);
  });
});

describe('member CRUD ↔ token store', () => {
  it('member create issues a SQLite token row for the new bearer', async () => {
    const { app, tokens } = makeApp();
    const res = await app.request('/members', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({
        name: 'fresh',
        role: { title: 'engineer', description: '' },
        permissions: [],
      }),
    });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    // The freshly-created token authenticates immediately.
    expect(tokens.resolve(token)).not.toBeNull();
    const briefing = await app.request('/briefing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(briefing.status).toBe(200);
  });

  it('member delete revokes every active token', async () => {
    const { app, tokens } = makeApp();
    // Issue a second token via device-code so engineer-1 has 2 tokens.
    const mintRes = await app.request('/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const mint = (await mintRes.json()) as DeviceAuthorizationResponse;
    await app.request('/enroll/approve', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({
        userCode: mint.userCode,
        mode: 'bind',
        memberName: 'engineer-1',
      }),
    });
    expect(tokens.listForMember('engineer-1').length).toBeGreaterThanOrEqual(1);

    await app.request('/members/engineer-1', {
      method: 'DELETE',
      headers: bearer(ADMIN_TOKEN),
    });
    expect(tokens.listForMember('engineer-1')).toHaveLength(0);

    // Original bearer no longer authenticates.
    const res = await app.request('/roster', {
      headers: { Authorization: `Bearer ${NON_ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('rotate-token nukes all peer tokens and issues a fresh one', async () => {
    const { app, tokens } = makeApp();
    // Add a peer token via enrollment first.
    const mintRes = await app.request('/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const mint = (await mintRes.json()) as DeviceAuthorizationResponse;
    await app.request('/enroll/approve', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({
        userCode: mint.userCode,
        mode: 'bind',
        memberName: 'engineer-1',
      }),
    });
    const beforeCount = tokens.listForMember('engineer-1').length;
    expect(beforeCount).toBeGreaterThanOrEqual(2);

    const rotateRes = await app.request('/members/engineer-1/rotate-token', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
    });
    expect(rotateRes.status).toBe(200);
    const { token: newToken } = (await rotateRes.json()) as { token: string };

    // After rotation, engineer-1 has exactly one token (the new one).
    expect(tokens.listForMember('engineer-1')).toHaveLength(1);
    expect(tokens.resolve(newToken)).not.toBeNull();
    expect(tokens.resolve(NON_ADMIN_TOKEN)).toBeNull();
  });
});
