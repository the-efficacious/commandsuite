import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Channel, ChannelSummary, GetChannelResponse, Team } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createSqliteChannelStore } from '../src/channels.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ALICE = 'csuite_test_alice_secret';
const BOB = 'csuite_test_bob_secret';
const CAROL = 'csuite_test_carol_secret';

const TEAM: Team = {
  name: 'demo-team',
  directive: 'Ship the thing.',
  context: '',
  permissionPresets: {},
};

function makeApp() {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: (() => {
      let n = 0;
      return () => `msg-${++n}`;
    })(),
  });
  const members = createMemberStore([
    {
      name: 'alice',
      role: { title: 'admin', description: '' },
      permissions: ['members.manage'],
      token: ALICE,
    },
    {
      name: 'bob',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: BOB,
    },
    {
      name: 'carol',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: CAROL,
    },
  ]);
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const channels = createSqliteChannelStore(db);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore(TEAM),
    channels,
    version: '0.0.0',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
  return { app, broker, members, sessions, db, channels, tokens };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  // Default: GET when no body+method, POST when only body, otherwise
  // the explicit method. Tests pass `method='DELETE'` for empty-body
  // delete calls, `method='PATCH'` for patches, and rely on the
  // body-only short-form for POST.
  const resolvedMethod = method ?? (body !== undefined ? 'POST' : 'GET');
  init.method = resolvedMethod;
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return init;
}

describe('GET /channels', () => {
  it('lists the synthetic general channel for any caller', async () => {
    const { app } = makeApp();
    const res = await app.request('/channels', authed(ALICE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: ChannelSummary[] };
    expect(body.channels.some((c) => c.id === 'general' && c.joined)).toBe(true);
  });

  it('marks `joined: false` for channels the caller is not in', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    const res = await app.request('/channels', authed(BOB));
    const body = (await res.json()) as { channels: ChannelSummary[] };
    const ops = body.channels.find((c) => c.slug === 'ops');
    expect(ops).toBeDefined();
    expect(ops?.joined).toBe(false);
    expect(ops?.myRole).toBeNull();
  });
});

describe('POST /channels', () => {
  it('creates a channel; caller becomes admin', async () => {
    const { app } = makeApp();
    const res = await app.request('/channels', authed(ALICE, { slug: 'eng' }));
    expect(res.status).toBe(201);
    const ch = (await res.json()) as Channel;
    expect(ch.slug).toBe('eng');
    const detailRes = await app.request(`/channels/${ch.slug}`, authed(ALICE));
    const detail = (await detailRes.json()) as GetChannelResponse;
    expect(detail.channel.myRole).toBe('admin');
    expect(detail.members.find((m) => m.memberName === 'alice')?.role).toBe('admin');
  });

  it('rejects an invalid slug', async () => {
    const { app } = makeApp();
    const res = await app.request('/channels', authed(ALICE, { slug: 'BAD UPPER' }));
    expect(res.status).toBe(400);
  });

  it('409s on slug collision', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    const res = await app.request('/channels', authed(BOB, { slug: 'ops' }));
    expect(res.status).toBe(409);
  });

  it('refuses to create with the reserved general slug', async () => {
    const { app } = makeApp();
    const res = await app.request('/channels', authed(ALICE, { slug: 'general' }));
    expect(res.status).toBe(403);
  });
});

describe('PATCH /channels/:slug', () => {
  it('admin can rename', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    const res = await app.request('/channels/ops', authed(ALICE, { slug: 'ops-team' }, 'PATCH'));
    expect(res.status).toBe(200);
    const ch = (await res.json()) as Channel;
    expect(ch.slug).toBe('ops-team');
  });

  it('non-admin gets 403', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    await app.request('/channels/ops/members', authed(BOB, undefined, 'POST')); // bob self-joins
    const res = await app.request('/channels/ops', authed(BOB, { slug: 'ops-team' }, 'PATCH'));
    expect(res.status).toBe(403);
  });
});

describe('DELETE /channels/:slug (archive)', () => {
  it('admin can archive; channel disappears from list', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    const res = await app.request('/channels/ops', authed(ALICE, undefined, 'DELETE'));
    expect(res.status).toBe(200);
    const listRes = await app.request('/channels', authed(ALICE));
    const list = (await listRes.json()) as { channels: ChannelSummary[] };
    expect(list.channels.find((c) => c.slug === 'ops')).toBeUndefined();
  });

  it('refuses to archive general', async () => {
    const { app } = makeApp();
    const res = await app.request('/channels/general', authed(ALICE, undefined, 'DELETE'));
    expect(res.status).toBe(403);
  });
});

describe('POST /channels/:slug/members (self-join + admin-add)', () => {
  it('self-join with empty body', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    const res = await app.request('/channels/ops/members', authed(BOB, undefined, 'POST'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetChannelResponse;
    expect(body.members.some((m) => m.memberName === 'bob')).toBe(true);
  });

  it('admin can add a different member', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    const res = await app.request('/channels/ops/members', authed(ALICE, { member: 'bob' }));
    expect(res.status).toBe(200);
  });

  it('non-admin cannot add a different member', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    await app.request('/channels/ops/members', authed(BOB, undefined, 'POST')); // bob joins as member
    const res = await app.request('/channels/ops/members', authed(BOB, { member: 'carol' }));
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown team member', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    const res = await app.request('/channels/ops/members', authed(ALICE, { member: 'ghost' }));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /channels/:slug/members/:name (leave / remove)', () => {
  it('member can self-leave', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    await app.request('/channels/ops/members', authed(BOB, undefined, 'POST'));
    const res = await app.request('/channels/ops/members/bob', authed(BOB, undefined, 'DELETE'));
    expect(res.status).toBe(200);
  });

  it('non-admin cannot remove others', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    await app.request('/channels/ops/members', authed(BOB, undefined, 'POST'));
    await app.request('/channels/ops/members', authed(CAROL, undefined, 'POST'));
    const res = await app.request('/channels/ops/members/carol', authed(BOB, undefined, 'DELETE'));
    expect(res.status).toBe(403);
  });

  it('refuses to remove the last admin while members remain', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    await app.request('/channels/ops/members', authed(BOB, undefined, 'POST'));
    const res = await app.request(
      '/channels/ops/members/alice',
      authed(ALICE, undefined, 'DELETE'),
    );
    // alice is the sole admin; bob is a regular member — refused.
    expect(res.status).toBe(403);
  });
});

describe('GET /history?channel=...', () => {
  it('filters to channel-tagged messages for members', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    const listRes = await app.request('/channels', authed(ALICE));
    const list = (await listRes.json()) as { channels: ChannelSummary[] };
    const ops = list.channels.find((c) => c.slug === 'ops');
    expect(ops).toBeDefined();
    // Tag a push for the ops channel.
    await app.request(
      '/push',
      authed(ALICE, { body: 'hello ops', data: { thread: `chan:${ops?.id}` } }),
    );
    // And a different message that isn't channel-tagged.
    await app.request('/push', authed(ALICE, { body: 'broadcast' }));

    const res = await app.request('/history?channel=ops', authed(ALICE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ body: string }> };
    expect(body.messages.map((m) => m.body)).toEqual(['hello ops']);
  });

  it('403s for non-members on non-general channel', async () => {
    const { app } = makeApp();
    await app.request('/channels', authed(ALICE, { slug: 'ops' }));
    const res = await app.request('/history?channel=ops', authed(BOB));
    expect(res.status).toBe(403);
  });

  it('general is reachable without explicit membership', async () => {
    const { app } = makeApp();
    await app.request('/push', authed(ALICE, { body: 'hi everyone' }));
    const res = await app.request('/history?channel=general', authed(BOB));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ body: string }> };
    expect(body.messages.find((m) => m.body === 'hi everyone')).toBeDefined();
  });
});
