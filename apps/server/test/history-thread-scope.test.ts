/**
 * `/history` must agree with delivery about who a message was for.
 *
 * Both cases below were live: the scoped endpoints answered 403 while
 * the default feed returned the same content to the same caller. The
 * live WebSocket fan-out was correct throughout, which is what kept it
 * out of sight — only the durable read disagreed.
 */

import {
  Broker,
  createApp,
  createSqliteChannelStore,
  createSqliteObjectivesStore,
  createTokenStoreFromMembers,
  SqliteEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import type { Team } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { silentLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ALICE = 'csuite_test_alice_secret';
const BOB = 'csuite_test_bob_secret';
const CAROL = 'csuite_test_carol_secret';
const TEAM: Team = { name: 'scope-team', context: '', permissionPresets: {} };
const ENG = { title: 'engineer', description: '' };

async function makeApp() {
  const db = openDatabase(':memory:');
  const broker = new Broker({ eventLog: new SqliteEventLog(db) });
  const members = createMemberStore([
    {
      name: 'alice',
      role: ENG,
      permissions: ['objectives.create', 'channels.manage'],
      token: ALICE,
    },
    { name: 'bob', role: ENG, permissions: [], token: BOB },
    { name: 'carol', role: ENG, permissions: [], token: CAROL },
  ]);
  broker.seedMembers(members.members());
  const { app } = createApp({
    broker,
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore(TEAM),
    channels: createSqliteChannelStore(db),
    objectives: createSqliteObjectivesStore(db),
    version: '0.0.0',
    logger: silentLogger(),
  });
  return app;
}

type App = Awaited<ReturnType<typeof makeApp>>;

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

async function feedBodies(app: App, token: string): Promise<string[]> {
  const res = await app.request('/history', authed(token));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { messages: Array<{ body: string }> };
  return body.messages.map((m) => m.body);
}

describe('GET /history — channel scope', () => {
  it('keeps a private channel out of a non-member’s feed', async () => {
    const app = await makeApp();
    const created = await app.request('/channels', authed(ALICE, { slug: 'secret-room' }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const added = await app.request(
      `/channels/secret-room/members`,
      authed(ALICE, { member: 'bob' }),
    );
    expect(added.status).toBeLessThan(300);

    const pushed = await app.request(
      '/push',
      authed(ALICE, { body: 'merger closes friday', data: { thread: `chan:${id}` } }),
    );
    expect(pushed.status).toBe(200);

    // The scoped read was always right; the feed is what leaked.
    const scoped = await app.request(`/history?channel=${id}`, authed(CAROL));
    expect(scoped.status).toBe(403);
    expect(await feedBodies(app, CAROL)).not.toContain('merger closes friday');

    // Members still have their channel.
    expect(await feedBodies(app, BOB)).toContain('merger closes friday');
    expect(await feedBodies(app, ALICE)).toContain('merger closes friday');
  });

  it('still lets a new member read the channel back', async () => {
    // The promise in docs/concepts/channels.mdx: join a channel and
    // read into context rather than reconstructing it. The feed shows
    // what was delivered TO YOU; the channel view shows the CHANNEL,
    // gated on membership as it stands now. Scoping the feed must not
    // quietly cost the second one.
    const app = await makeApp();
    const created = await app.request('/channels', authed(ALICE, { slug: 'backlog' }));
    const { id } = (await created.json()) as { id: string };
    const pushed = await app.request(
      '/push',
      authed(ALICE, { body: 'context from before you joined', data: { thread: `chan:${id}` } }),
    );
    expect(pushed.status).toBe(200);

    // Carol joins after the fact.
    expect(
      (await app.request('/channels/backlog/members', authed(ALICE, { member: 'carol' }))).status,
    ).toBeLessThan(300);

    const back = await app.request(`/history?channel=${id}`, authed(CAROL));
    expect(back.status).toBe(200);
    const { messages } = (await back.json()) as { messages: Array<{ body: string }> };
    expect(messages.map((m) => m.body)).toContain('context from before you joined');
  });

  it('still shows the general channel to everyone', async () => {
    const app = await makeApp();
    const pushed = await app.request(
      '/push',
      authed(ALICE, { body: 'standup in five', data: { thread: 'chan:general' } }),
    );
    expect(pushed.status).toBe(200);
    expect(await feedBodies(app, CAROL)).toContain('standup in five');
  });

  it('still shows an ordinary broadcast to everyone', async () => {
    const app = await makeApp();
    expect((await app.request('/push', authed(ALICE, { body: 'deploy done' }))).status).toBe(200);
    expect(await feedBodies(app, CAROL)).toContain('deploy done');
  });
});

describe('GET /history — objective scope', () => {
  it('keeps an objective thread out of a non-participant’s feed', async () => {
    const app = await makeApp();
    const created = await app.request(
      '/objectives',
      authed(ALICE, { title: 'ship it', outcome: 'shipped', assignee: 'bob' }),
    );
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    const discussed = await app.request(
      `/objectives/${id}/discuss`,
      authed(ALICE, { body: 'the acquisition target is Acme' }),
    );
    expect(discussed.status).toBe(200);

    expect((await app.request(`/objectives/${id}`, authed(CAROL))).status).toBe(403);
    const carolFeed = await feedBodies(app, CAROL);
    expect(carolFeed.some((b) => b.includes('Acme'))).toBe(false);
    // The lifecycle event carries the objective's outcome — same leak,
    // different row.
    expect(carolFeed.some((b) => b.includes('ship it'))).toBe(false);

    // The assignee's own plate is untouched.
    const bobFeed = await feedBodies(app, BOB);
    expect(bobFeed.some((b) => b.includes('Acme'))).toBe(true);
  });
});
