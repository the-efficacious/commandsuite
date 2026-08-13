/**
 * Asserts that every authenticated member can read the primary
 * channel's history, regardless of channel membership.
 *
 * WHY THIS IS A TEST AND NOT AN ASSUMPTION. Universal readability of
 * the primary channel is what would make a citation to it resolvable
 * for every reader — a property a process-provenance design depends on,
 * and one that no test stated.
 *
 * TWO INDEPENDENT GUARANTEES, found by mutation rather than by reading.
 * Removing either one alone leaves readability intact:
 *
 *   route   app.ts — `channelRaw === GENERAL_CHANNEL_ID` short-circuits
 *           before `channels` is consulted at all
 *   store   channels.ts — `isMember()` returns true for general
 *           regardless of any membership row
 *
 * The route one is explicitly a convenience, not an access decision:
 *
 *   "Allow the sentinel 'general' through unconditionally so callers
 *    don't need to special-case it client-side."
 *
 * So the outcome is defended in depth, which is better than assumed —
 * but it also means an outcome-only test cannot warn you when one of
 * the two is removed. Measured:
 *
 *   route removed alone    readability PASSES   (store still holds)
 *   store removed alone    readability PASSES   (route still holds)
 *   both removed           readability FAILS
 *
 * Hence one test per mechanism plus one for the outcome. Before the
 * per-mechanism tests, removing the store guarantee left every test in
 * this repo green.
 *
 * The failure mode is silent and in the reassuring direction. The day
 * `general` becomes a real channel with a membership list — a guest, a
 * contractor, an agent scoped to one project — the sentinel goes away,
 * nothing turns red, and readability quietly becomes conditional for
 * exactly the members least able to notice.
 *
 * With this test, that change fails here instead, at the moment it is
 * made and next to the reason it matters.
 *
 * NOT ASSERTED HERE: that the primary channel *should* be universally
 * readable. That is a product decision. This only ensures the decision
 * gets made deliberately rather than by a caller-ergonomics shortcut
 * quietly changing meaning.
 */

import {
  Broker,
  createApp,
  createSqliteChannelStore,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import type { Team } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN = 'csuite_test_admin_general_secret';
const PLAIN = 'csuite_test_plain_general_secret';

const TEAM: Team = { name: 'demo-team', context: '', permissionPresets: {} };

async function makeApp() {
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
      name: 'admin',
      role: { title: 'admin', description: '' },
      permissions: ['members.manage'],
      token: ADMIN,
    },
    // Holds nothing. Joins no channels. This is the reader a
    // provenance citation has to resolve for.
    {
      name: 'plain',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: PLAIN,
    },
  ]);
  const db = openDatabase(':memory:');
  const channels = createSqliteChannelStore(db);
  const { app } = createApp({
    broker,
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore(TEAM),
    channels,
    version: '0.0.0',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { app, channels };
}

function authed(token: string, body?: unknown): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = body !== undefined ? 'POST' : 'GET';
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

describe('the primary channel is readable by every member, with no membership gate', () => {
  it('serves general history to a member holding no permissions and no channel membership', async () => {
    const { app } = await makeApp();
    await app.request('/push', authed(ADMIN, { body: 'a decision stated to the team' }));

    const res = await app.request('/history?channel=general', authed(PLAIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ body: string }> };
    expect(body.messages.map((m) => m.body)).toContain('a decision stated to the team');
  });

  /**
   * The positive control for the assertion above. If named channels did
   * not 403 a non-member, the previous test would pass on a server with
   * no channel access control at all, and would be evidence of nothing.
   */
  it('still refuses a named channel to a non-member, so the test above means something', async () => {
    const { app } = await makeApp();
    const created = await app.request(
      '/channels',
      authed(ADMIN, { slug: 'private-thing', description: '' }),
    );
    expect(created.status).toBe(201);

    const res = await app.request('/history?channel=private-thing', authed(PLAIN));
    expect(res.status).toBe(403);
  });

  /**
   * MECHANISM 1 — the route sentinel. Membership is irrelevant to the
   * primary channel, not merely satisfied by everyone: nothing consults
   * `channels` on this path, so no membership list can drift out from
   * under the guarantee.
   */
  it('does not consult the channel store for the primary channel', async () => {
    const { app, channels } = await makeApp();
    const isMember = vi.spyOn(channels, 'isMember');
    await app.request('/push', authed(ADMIN, { body: 'hello' }));

    const res = await app.request('/history?channel=general', authed(PLAIN));
    expect(res.status).toBe(200);
    expect(isMember).not.toHaveBeenCalled();
  });

  /**
   * MECHANISM 2 — the store's own short-circuit, which the route
   * currently makes unreachable for this path.
   *
   * This is here because removing it broke nothing. Every test in the
   * repo stayed green while `isMember('general', …)` became a real
   * membership lookup, because the route never calls it. That is a
   * guarantee with no assertion behind it, and it is the half that
   * would be load-bearing the moment the route stopped short-circuiting.
   */
  it('treats every member as a member of the primary channel at the store', async () => {
    const { channels } = await makeApp();
    expect(channels.isMember('general', 'plain')).toBe(true);
    expect(channels.isMember('general', 'admin')).toBe(true);
    // Not a member of the team at all — general membership is not a
    // lookup that can miss, it is unconditional.
    expect(channels.isMember('general', 'nobody-by-that-name')).toBe(true);
  });
});
