/**
 * Objectives REST endpoint tests.
 *
 * Drives the `/objectives*` surface through the Hono request client
 * with five test members covering the relevant permission gates:
 *
 *   alice   — `members.manage` + all four objective leaves
 *   bob     — all four objective leaves
 *   carol   — no permissions (baseline member)
 *   dave    — no permissions (second baseline member)
 *   mgr     — `members.manage` and nothing else: on every objective's
 *             thread without holding a single objective leaf
 *
 * Store-level state-machine semantics live in objectives.test.ts;
 * here we verify auth gates, scoping, validation, payload shapes,
 * and the audit-log surfacing through `GET /objectives/:id`.
 */

import {
  Broker,
  createApp,
  createSqliteObjectivesStore,
  createTokenStoreFromMembers,
  generateBearerToken,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import type {
  GetObjectiveResponse,
  ListObjectivesResponse,
  Objective,
  Team,
} from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { silentLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ALICE = 'csuite_test_alice_secret_token';
const BOB = 'csuite_test_bob_secret_token';
const CAROL = 'csuite_test_carol_secret_token';
const DAVE = 'csuite_test_dave_secret_token';
const MGR = 'csuite_test_mgr_secret_token';

const TEAM: Team = {
  name: 'demo-team',
  context: '',
  permissionPresets: {},
};

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
      name: 'alice',
      role: { title: 'coordinator', description: '' },
      permissions: [
        'members.manage',
        'objectives.create',
        'objectives.cancel',
        'objectives.reassign',
        'objectives.watch',
      ],
      token: ALICE,
    },
    {
      name: 'bob',
      role: { title: 'planner', description: '' },
      permissions: [
        'objectives.create',
        'objectives.cancel',
        'objectives.reassign',
        'objectives.watch',
      ],
      token: BOB,
    },
    {
      name: 'carol',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: CAROL,
    },
    {
      name: 'dave',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: DAVE,
    },
    {
      // The roster administrator: `members.manage` and no objective
      // leaf at all. Every other manage-holding fixture in this file
      // pairs the leaf with an objective leaf, which hides the read
      // gate's audience behind `objectives.create`.
      name: 'mgr',
      role: { title: 'roster admin', description: '' },
      permissions: ['members.manage'],
      token: MGR,
    },
  ]);
  for (const name of ['alice', 'bob', 'carol', 'dave', 'mgr']) {
    void broker.register(name);
  }
  const db = openDatabase(':memory:');
  const sessions = new SqliteSessionStore(db);
  const tokens = await createTokenStoreFromMembers(db, members);
  const objectives = createSqliteObjectivesStore(db);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore(TEAM),
    objectives,
    version: '0.0.0',
    logger: silentLogger(),
  });
  return { app, broker, members, objectives };
}

function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  const resolvedMethod = method ?? (body !== undefined ? 'POST' : 'GET');
  init.method = resolvedMethod;
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return init;
}

async function createOne(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  token: string,
  payload: Partial<{
    title: string;
    outcome: string;
    body: string;
    assignee: string;
    watchers: string[];
  }> = {},
): Promise<Objective> {
  const res = await app.request(
    '/objectives',
    authed(token, {
      title: payload.title ?? 'Ship the thing',
      outcome: payload.outcome ?? 'PR merged to main',
      body: payload.body ?? '',
      assignee: payload.assignee ?? 'carol',
      ...(payload.watchers ? { watchers: payload.watchers } : {}),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Objective;
}

// ─── POST /objectives ────────────────────────────────────────────────

describe('POST /objectives', () => {
  it('creates an objective when caller has objectives.create', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    expect(obj.id).toMatch(/^obj-/);
    expect(obj.assignee).toBe('carol');
    expect(obj.originator).toBe('alice');
    expect(obj.status).toBe('active');
  });

  it('creation with watchers lands as ONE push, naming them all', async () => {
    const { app, broker } = await makeApp();
    const received: string[] = [];
    broker.subscribe('carol', async (m) => {
      received.push(m.body);
    });
    await createOne(app, ALICE, { assignee: 'carol', watchers: ['bob', 'dave'] });
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));

    // One `assigned` push carries the whole creation. Before this,
    // each initial watcher re-broadcast the full contract to every
    // thread member — four near-identical payloads on a live team's
    // 4-watcher objective before any work happened.
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('[objective assigned]');
    expect(received[0]).toContain('outcome:');
  });

  it('rejects callers without objectives.create with 403', async () => {
    const { app } = await makeApp();
    const res = await app.request(
      '/objectives',
      authed(CAROL, {
        title: 't',
        outcome: 'o',
        assignee: 'carol',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated requests', async () => {
    const { app } = await makeApp();
    const res = await app.request('/objectives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', outcome: 'o', assignee: 'carol' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown assignee with 400', async () => {
    const { app } = await makeApp();
    const res = await app.request(
      '/objectives',
      authed(ALICE, { title: 't', outcome: 'o', assignee: 'ghost' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown assignee/i);
  });

  it('rejects an unknown initial watcher with 400', async () => {
    const { app } = await makeApp();
    const res = await app.request(
      '/objectives',
      authed(ALICE, {
        title: 't',
        outcome: 'o',
        assignee: 'carol',
        watchers: ['bob', 'ghost'],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown watcher/i);
  });

  it('rejects a malformed payload with 400', async () => {
    const { app } = await makeApp();
    const res = await app.request('/objectives', authed(ALICE, { title: 't' }));
    expect(res.status).toBe(400);
  });
});

// ─── GET /objectives ─────────────────────────────────────────────────

describe('GET /objectives', () => {
  it('returns team-wide list for callers with objectives.create', async () => {
    const { app } = await makeApp();
    await createOne(app, ALICE, { assignee: 'carol' });
    await createOne(app, BOB, { assignee: 'dave' });
    const res = await app.request('/objectives', authed(ALICE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListObjectivesResponse;
    expect(body.objectives).toHaveLength(2);
  });

  it('scopes plain members to objectives where they participate', async () => {
    const { app } = await makeApp();
    // carol is the assignee of one, irrelevant to the other.
    await createOne(app, ALICE, { assignee: 'carol' });
    await createOne(app, ALICE, { assignee: 'dave' });
    const res = await app.request('/objectives', authed(CAROL));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListObjectivesResponse;
    expect(body.objectives).toHaveLength(1);
    expect(body.objectives[0]?.assignee).toBe('carol');
  });

  it('includes objectives where a plain member is a watcher', async () => {
    const { app } = await makeApp();
    await createOne(app, ALICE, { assignee: 'dave', watchers: ['carol'] });
    const res = await app.request('/objectives', authed(CAROL));
    const body = (await res.json()) as ListObjectivesResponse;
    expect(body.objectives).toHaveLength(1);
  });

  it('rejects a plain member fishing with assignee filter for someone else', async () => {
    const { app } = await makeApp();
    await createOne(app, ALICE, { assignee: 'dave' });
    const res = await app.request('/objectives?assignee=dave', authed(CAROL));
    expect(res.status).toBe(403);
  });

  it('accepts a self-scoped assignee filter from a plain member', async () => {
    const { app } = await makeApp();
    await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request('/objectives?assignee=carol', authed(CAROL));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListObjectivesResponse;
    expect(body.objectives).toHaveLength(1);
  });

  it('rejects an invalid status filter with 400', async () => {
    const { app } = await makeApp();
    const res = await app.request('/objectives?status=garbage', authed(ALICE));
    expect(res.status).toBe(400);
  });

  // `related` — the relationship union for callers who hold
  // `objectives.create`. The plain-member branch has always applied it;
  // a privileged caller got assignee-only, so the permission that grants
  // more authority was what removed the capability. The fixture must be
  // PRIVILEGED and assigned NOTHING — a plain-member fixture passes
  // against the bug, because the union already covers that path.
  it('related returns originated and watched objectives for a privileged caller assigned none', async () => {
    const { app } = await makeApp();
    // alice originates both and is the assignee of neither.
    const originatedA = await createOne(app, ALICE, { assignee: 'carol' });
    const originatedB = await createOne(app, ALICE, { assignee: 'dave' });
    // ...and watches a third she neither originated nor was assigned.
    const watched = await createOne(app, BOB, { assignee: 'dave', watchers: ['alice'] });
    // A fourth alice has NO relationship with. Without this the team-wide
    // count and the related count are both 3, and the test would pass
    // against a route that ignores `related` entirely — the exact
    // "returns some of the right answer" failure this suite exists to catch.
    const unrelated = await createOne(app, BOB, { assignee: 'dave' });

    // The old query shape: assignee-only. Alice is assigned nothing, so
    // this is the empty plate that made the recovery path lie.
    const assigneeOnly = await app.request('/objectives?assignee=alice', authed(ALICE));
    const assigneeBody = (await assigneeOnly.json()) as ListObjectivesResponse;
    expect(assigneeBody.objectives).toHaveLength(0);

    const res = await app.request('/objectives?related=alice', authed(ALICE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListObjectivesResponse;
    // Assert the exact identities, not the cardinality: a route that
    // returned the unrelated fourth in place of one related objective
    // has the right count and the wrong answer.
    expect(new Set(body.objectives.map((o) => o.id))).toEqual(
      new Set([originatedA.id, originatedB.id, watched.id]),
    );
    expect(body.objectives.map((o) => o.id)).not.toContain(unrelated.id);
  });

  it('related composes with a status filter', async () => {
    const { app } = await makeApp();
    await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request('/objectives?related=alice&status=active', authed(ALICE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListObjectivesResponse;
    expect(body.objectives).toHaveLength(1);
  });

  // Guards the director dashboard: `web-ui/src/lib/objectives.ts` calls
  // listObjectives() with no arguments and relies on a privileged caller
  // seeing team-wide. Folding the union in as the default would regress it.
  it('a privileged caller without related still sees team-wide', async () => {
    const { app } = await makeApp();
    await createOne(app, BOB, { assignee: 'carol' });
    await createOne(app, BOB, { assignee: 'dave' });
    const res = await app.request('/objectives', authed(ALICE));
    const body = (await res.json()) as ListObjectivesResponse;
    // alice originates neither and watches neither.
    expect(body.objectives).toHaveLength(2);
  });

  it('rejects a plain member passing related for someone else', async () => {
    const { app } = await makeApp();
    await createOne(app, ALICE, { assignee: 'dave' });
    const res = await app.request('/objectives?related=dave', authed(CAROL));
    expect(res.status).toBe(403);
  });

  it('accepts a self-scoped related filter from a plain member', async () => {
    const { app } = await makeApp();
    await createOne(app, ALICE, { assignee: 'dave', watchers: ['carol'] });
    const res = await app.request('/objectives?related=carol', authed(CAROL));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListObjectivesResponse;
    expect(body.objectives).toHaveLength(1);
  });
});

// ─── GET /objectives/:id ─────────────────────────────────────────────

describe('GET /objectives/:id', () => {
  it('returns the objective + event log to a thread participant', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(`/objectives/${obj.id}`, authed(CAROL));
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetObjectiveResponse;
    expect(body.objective.id).toBe(obj.id);
    expect(body.events.map((e) => e.kind)).toContain('assigned');
  });

  it('returns the objective to anyone with objectives.create', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    // bob is not a thread participant (alice originated, carol is
    // the assignee). bob has objectives.create so the gate passes.
    const res = await app.request(`/objectives/${obj.id}`, authed(BOB));
    expect(res.status).toBe(200);
  });

  it('rejects a member off the thread holding neither leaf, naming the real gate', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    // dave is not on the thread and holds neither objectives.create
    // nor members.manage.
    const res = await app.request(`/objectives/${obj.id}`, authed(DAVE));
    expect(res.status).toBe(403);
    // The message names the predicate the gate actually tests — the
    // whole of it, and nothing it does not test.
    expect(await res.json()).toEqual({
      error:
        'viewing this objective requires being on its thread (assignee, originator, watcher, or members.manage) or holding objectives.create',
    });
  });

  it('returns 404 for unknown ids', async () => {
    const { app } = await makeApp();
    const res = await app.request('/objectives/obj-nope', authed(ALICE));
    expect(res.status).toBe(404);
  });
});

// ─── the objective read audience ─────────────────────────────────────
//
// `members.manage` puts a member on every objective's thread: the
// lifecycle fan-out pushes them every event, `/discuss` accepts their
// posts, and `/team/status` lists every open objective for them. These
// tests hold the two read routes to that same audience — `mgr` holds
// `members.manage` and not one objective leaf, so nothing here can be
// satisfied by `objectives.create`.

describe('objective reads for a members.manage holder without objectives.create', () => {
  it('returns the whole objective and its whole event log', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, BOB, { assignee: 'dave', watchers: ['carol'] });
    // mgr is neither assignee, originator, nor watcher.
    const res = await app.request(`/objectives/${obj.id}`, authed(MGR));
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetObjectiveResponse;
    // The full record, field for field — not an id/title projection
    // of the kind `/team/status` already hands this member.
    expect(body.objective).toEqual(obj);
    // And the complete log, not its first row.
    expect(body.events.map((e) => e.kind)).toEqual(['assigned']);
  });

  it('lists every objective on the team, not only its own related set', async () => {
    const { app } = await makeApp();
    const a = await createOne(app, BOB, { assignee: 'carol', title: 'A' });
    const b = await createOne(app, BOB, { assignee: 'dave', title: 'B' });
    const c = await createOne(app, ALICE, { assignee: 'carol', title: 'C' });
    const res = await app.request('/objectives', authed(MGR));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListObjectivesResponse;
    // mgr is party to none of the three; all three come back.
    expect(body.objectives.map((o) => o.id).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('answers related= for another member', async () => {
    const { app } = await makeApp();
    const daves = await createOne(app, BOB, { assignee: 'dave' });
    await createOne(app, BOB, { assignee: 'carol' });
    const res = await app.request('/objectives?related=dave', authed(MGR));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListObjectivesResponse;
    expect(body.objectives.map((o) => o.id)).toEqual([daves.id]);
  });

  it('reads the thread it is allowed to post into', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, BOB, { assignee: 'dave' });
    const discuss = await app.request(
      `/objectives/${obj.id}/discuss`,
      authed(MGR, { body: 'admin chime-in' }),
    );
    const view = await app.request(`/objectives/${obj.id}`, authed(MGR));
    // One member cannot be inside the thread for writes and outside
    // it for reads: whatever the audience rule is, these agree.
    expect(view.status).toBe(discuss.status);
    expect(view.status).toBe(200);
  });

  it('is pushed the lifecycle event it can then open', async () => {
    const { app, broker } = await makeApp();
    const received: string[] = [];
    broker.subscribe('mgr', async (m) => {
      const data = m.data as { kind?: string; objective_id?: string } | undefined;
      if (data?.kind === 'objective' && data.objective_id) received.push(data.objective_id);
    });
    const obj = await createOne(app, BOB, { assignee: 'dave' });
    // The push audience and the read gate name the same member.
    await vi.waitFor(() => expect(received).toEqual([obj.id]));
    const res = await app.request(`/objectives/${obj.id}`, authed(MGR));
    expect(res.status).toBe(200);
  });
});

describe('objective reads for a member holding neither leaf', () => {
  it('scopes the list to its own related objectives', async () => {
    const { app } = await makeApp();
    const mine = await createOne(app, ALICE, { assignee: 'dave' });
    await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request('/objectives', authed(DAVE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListObjectivesResponse;
    expect(body.objectives.map((o) => o.id)).toEqual([mine.id]);
  });

  it('refuses related= for someone else, naming both leaves that would allow it', async () => {
    const { app } = await makeApp();
    await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request('/objectives?related=carol', authed(DAVE));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "listing another member's objectives requires objectives.create or members.manage",
    });
  });
});

// ─── PATCH /objectives/:id ───────────────────────────────────────────

describe('PATCH /objectives/:id', () => {
  it('lets the assignee transition active → blocked with a reason', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(CAROL, { status: 'blocked', blockReason: 'waiting' }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Objective;
    expect(updated.status).toBe('blocked');
    expect(updated.blockReason).toBe('waiting');
  });

  it('lets a member with objectives.cancel update someone else’s', async () => {
    const { app, members } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'dave' });
    members.updateMember('bob', {
      rawPermissions: ['objectives.cancel'],
      permissions: ['objectives.cancel'],
    });
    // Bob has only objectives.cancel and isn't the assignee.
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(BOB, { status: 'blocked', blockReason: 'standdown' }, 'PATCH'),
    );
    expect(res.status).toBe(200);
  });

  it('rejects non-assignee, non-cancel members with 403', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'dave' });
    // carol has no permissions and isn't the assignee.
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(CAROL, { status: 'blocked', blockReason: 'no' }, 'PATCH'),
    );
    expect(res.status).toBe(403);
  });

  it('blocks without a reason — the reason is a nudge, not a gate', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(CAROL, { status: 'blocked' }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Objective;
    expect(body.status).toBe('blocked');
    expect(body.blockReason).toBeNull();
  });

  it('returns 409 (terminal) when patching a done objective', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    await app.request(`/objectives/${obj.id}/complete`, authed(CAROL, { result: 'shipped' }));
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(CAROL, { status: 'blocked', blockReason: 'late' }, 'PATCH'),
    );
    expect(res.status).toBe(409);
  });

  it('returns 404 for unknown ids', async () => {
    const { app } = await makeApp();
    const res = await app.request(
      '/objectives/obj-nope',
      authed(ALICE, { status: 'active' }, 'PATCH'),
    );
    expect(res.status).toBe(404);
  });
});

// ─── POST /objectives/:id/complete ───────────────────────────────────

describe('POST /objectives/:id/complete', () => {
  it('lets the assignee complete with a result', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}/complete`,
      authed(CAROL, { result: 'shipped' }),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Objective;
    expect(updated.status).toBe('done');
    expect(updated.result).toBe('shipped');
  });

  it('rejects non-assignee with 403, even an admin', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}/complete`,
      authed(ALICE, { result: 'on her behalf' }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects a missing result with 400', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(`/objectives/${obj.id}/complete`, authed(CAROL, {}));
    expect(res.status).toBe(400);
  });

  it('returns 409 on double-complete', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    await app.request(`/objectives/${obj.id}/complete`, authed(CAROL, { result: 'r' }));
    const res = await app.request(
      `/objectives/${obj.id}/complete`,
      authed(CAROL, { result: 'r2' }),
    );
    expect(res.status).toBe(409);
  });
});

// ─── POST /objectives/:id/cancel ─────────────────────────────────────

describe('POST /objectives/:id/cancel', () => {
  it('lets the originator cancel their own objective', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, BOB, { assignee: 'dave' });
    const res = await app.request(
      `/objectives/${obj.id}/cancel`,
      authed(BOB, { reason: 'scope changed' }),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Objective;
    expect(updated.status).toBe('cancelled');
  });

  it('lets a member with objectives.cancel cancel someone else’s', async () => {
    const { app, members } = await makeApp();
    const obj = await createOne(app, BOB, { assignee: 'dave' });
    members.updateMember('alice', {
      rawPermissions: ['members.manage', 'objectives.cancel'],
      permissions: ['members.manage', 'objectives.cancel'],
    });
    const res = await app.request(
      `/objectives/${obj.id}/cancel`,
      authed(ALICE, { reason: 'admin override' }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects assignee-without-permission cancelling not-their-own', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    // carol is the assignee but has no objectives.cancel permission
    // and is not the originator (alice is).
    const res = await app.request(
      `/objectives/${obj.id}/cancel`,
      authed(CAROL, { reason: 'unauthorized' }),
    );
    expect(res.status).toBe(403);
  });

  it('accepts an empty body (reason is optional)', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, BOB, { assignee: 'dave' });
    const res = await app.request(`/objectives/${obj.id}/cancel`, authed(BOB, {}));
    expect(res.status).toBe(200);
  });

  it('returns 409 on cancelling a done objective', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    await app.request(`/objectives/${obj.id}/complete`, authed(CAROL, { result: 'r' }));
    const res = await app.request(`/objectives/${obj.id}/cancel`, authed(ALICE, {}));
    expect(res.status).toBe(409);
  });
});

// ─── PATCH /objectives/:id — assignee changes ────────────────────────

describe('PATCH assignee (reassignment)', () => {
  it('reassigns to a different member when caller has objectives.reassign', async () => {
    const { app, members } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    members.updateMember('alice', {
      rawPermissions: ['members.manage', 'objectives.reassign'],
      permissions: ['members.manage', 'objectives.reassign'],
    });
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(ALICE, { assignee: 'dave', note: 'context shift' }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Objective;
    expect(updated.assignee).toBe('dave');
  });

  it('rejects callers without objectives.reassign with 403 — even the assignee', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    // carol is the assignee but holds no objectives.reassign; she may
    // update her own status, not hand the work to someone else.
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(CAROL, { assignee: 'dave' }, 'PATCH'),
    );
    expect(res.status).toBe(403);
  });

  it('rejects an unknown target assignee with 400', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(ALICE, { assignee: 'ghost' }, 'PATCH'),
    );
    expect(res.status).toBe(400);
  });

  it('setting the assignee to the current assignee is an idempotent no-op', async () => {
    const { app, broker } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const received: string[] = [];
    broker.subscribe('carol', async (m) => {
      received.push(m.body);
    });
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(ALICE, { assignee: 'carol' }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Objective;
    expect(updated.assignee).toBe('carol');
    // No event, no push — nothing happened, so nothing is broadcast.
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toEqual([]);
  });
});

// ─── POST /objectives/:id/reassign ───────────────────────────────────

describe('POST /objectives/:id/reassign', () => {
  it('moves the assignee, keeps the outgoing one on the thread, and records both events', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}/reassign`,
      authed(ALICE, { to: 'dave', note: 'carol is on leave' }),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Objective;
    expect(updated.assignee).toBe('dave');
    expect(updated.watchers).toEqual(['carol']);
    const detail = await app.request(`/objectives/${obj.id}`, authed(ALICE));
    const body = (await detail.json()) as GetObjectiveResponse;
    expect(body.events.map((e) => e.kind)).toEqual(['assigned', 'reassigned', 'watcher_added']);
    expect(body.events[1]?.payload).toEqual({
      from: 'carol',
      to: 'dave',
      note: 'carol is on leave',
    });
    expect(body.events[2]?.payload).toEqual({ name: 'carol', reason: 'reassigned-from' });
  });

  // Two spellings of one act. The route is the first-class verb; the
  // `assignee` field group on PATCH is the older spelling the web UI
  // and existing agents still use. Anything the route does differently
  // is a new confound, so compare the whole objective and the whole
  // event stream rather than the assignee alone.
  it('is the same act as the PATCH assignee field group, field for field and event for event', async () => {
    const { app } = await makeApp();
    const viaRoute = await createOne(app, ALICE, { assignee: 'carol' });
    const viaPatch = await createOne(app, ALICE, { assignee: 'carol' });
    const a = await app.request(
      `/objectives/${viaRoute.id}/reassign`,
      authed(ALICE, { to: 'dave', note: 'handover' }),
    );
    const b = await app.request(
      `/objectives/${viaPatch.id}`,
      authed(ALICE, { assignee: 'dave', note: 'handover' }, 'PATCH'),
    );
    expect(a.status).toBe(200);
    expect(a.status).toBe(b.status);
    const strip = (o: Objective) => ({ ...o, id: '', createdAt: 0, updatedAt: 0 });
    expect(strip((await a.json()) as Objective)).toEqual(strip((await b.json()) as Objective));
    const events = async (id: string) => {
      const detail = await app.request(`/objectives/${id}`, authed(ALICE));
      return ((await detail.json()) as GetObjectiveResponse).events.map((e) => ({
        kind: e.kind,
        actor: e.actor,
        payload: e.payload,
      }));
    };
    // Positive control: two spellings that both did nothing would
    // compare equal. Pin what the route side actually produced first.
    const routeEvents = await events(viaRoute.id);
    expect(routeEvents.map((ev) => ev.kind)).toEqual(['assigned', 'reassigned', 'watcher_added']);
    expect(routeEvents).toEqual(await events(viaPatch.id));
  });

  it('rejects a caller without objectives.reassign with 403 — even the assignee', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(`/objectives/${obj.id}/reassign`, authed(CAROL, { to: 'dave' }));
    expect(res.status).toBe(403);
  });

  it('rejects an unknown target and a missing `to` with 400', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const unknown = await app.request(
      `/objectives/${obj.id}/reassign`,
      authed(ALICE, { to: 'ghost' }),
    );
    expect(unknown.status).toBe(400);
    const missing = await app.request(`/objectives/${obj.id}/reassign`, authed(ALICE, {}));
    expect(missing.status).toBe(400);
  });

  it('reassigning to the current assignee is an idempotent no-op', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(`/objectives/${obj.id}/reassign`, authed(ALICE, { to: 'carol' }));
    expect(res.status).toBe(200);
    const detail = await app.request(`/objectives/${obj.id}`, authed(ALICE));
    const body = (await detail.json()) as GetObjectiveResponse;
    expect(body.events.map((e) => e.kind)).toEqual(['assigned']);
  });

  it('409s once the objective is terminal', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    await app.request(`/objectives/${obj.id}/complete`, authed(CAROL, { result: 'shipped' }));
    const res = await app.request(`/objectives/${obj.id}/reassign`, authed(ALICE, { to: 'dave' }));
    expect(res.status).toBe(409);
  });

  it('404s for an objective that does not exist', async () => {
    const { app } = await makeApp();
    const res = await app.request('/objectives/obj-nope/reassign', authed(ALICE, { to: 'dave' }));
    expect(res.status).toBe(404);
  });
});

// ─── PATCH /objectives/:id — watcher changes ─────────────────────────

describe('PATCH watchers', () => {
  it('a later watcher add pushes the name, not the whole contract', async () => {
    const { app, broker } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const received: string[] = [];
    broker.subscribe('carol', async (m) => {
      received.push(m.body);
    });
    await app.request(`/objectives/${obj.id}`, authed(ALICE, { addWatchers: ['dave'] }, 'PATCH'));
    await vi.waitFor(() =>
      expect(received.some((b) => b.includes('[objective watcher_added]'))).toBe(true),
    );

    const push = received.find((b) => b.includes('[objective watcher_added]'));
    // The joiner is named and can pull the contract with
    // `objectives_view`; the full outcome is NOT re-broadcast to every
    // thread member on each watcher change.
    expect(push).toContain('watcher:  dave');
    expect(push).toContain('title:');
    expect(push).not.toContain('PR merged to main');
  });

  it('lets the originator add a watcher to their own objective', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(ALICE, { addWatchers: ['dave'] }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Objective;
    expect(updated.watchers).toContain('dave');
  });

  it('lets a member with objectives.watch add themselves', async () => {
    const { app, members } = await makeApp();
    const obj = await createOne(app, BOB, { assignee: 'dave' });
    members.updateMember('alice', {
      rawPermissions: ['members.manage', 'objectives.watch'],
      permissions: ['members.manage', 'objectives.watch'],
    });
    // Alice has only objectives.watch from the objective family and is neither originator nor assignee.
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(ALICE, { addWatchers: ['alice'] }, 'PATCH'),
    );
    expect(res.status).toBe(200);
  });

  it('rejects callers without watch permission and not the originator', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'dave' });
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(CAROL, { addWatchers: ['carol'] }, 'PATCH'),
    );
    expect(res.status).toBe(403);
  });

  it('rejects unknown names in add or remove with 400', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(ALICE, { addWatchers: ['ghost'] }, 'PATCH'),
    );
    expect(res.status).toBe(400);
  });

  it('combined add + remove returns the new watcher list', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol', watchers: ['bob'] });
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(ALICE, { addWatchers: ['dave'], removeWatchers: ['bob'] }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Objective;
    expect(updated.watchers).toEqual(['dave']);
  });
});

// ─── POST /objectives/:id/discuss ────────────────────────────────────

describe('POST /objectives/:id/discuss', () => {
  it('lets a thread member post discussion', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}/discuss`,
      authed(CAROL, { body: 'making progress' }),
    );
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { id: string; body: string };
    expect(msg.body).toBe('making progress');
    expect(msg.id).toMatch(/^msg-/);
  });

  it('lets an admin post even if not an explicit watcher', async () => {
    const { app } = await makeApp();
    // alice has members.manage so is an implicit thread participant
    // by way of `objectiveThreadMembers`.
    const obj = await createOne(app, BOB, { assignee: 'dave' });
    const res = await app.request(
      `/objectives/${obj.id}/discuss`,
      authed(ALICE, { body: 'admin chime-in' }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects a non-thread-member with 403', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, BOB, { assignee: 'dave' });
    // carol is neither originator, assignee, watcher, nor admin.
    const res = await app.request(
      `/objectives/${obj.id}/discuss`,
      authed(CAROL, { body: 'wedge' }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects an empty body with 400', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(`/objectives/${obj.id}/discuss`, authed(CAROL, { body: '' }));
    expect(res.status).toBe(400);
  });

  it('refuses a credential-shaped discussion body without echoing it', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const token = generateBearerToken();
    const res = await app.request(
      `/objectives/${obj.id}/discuss`,
      authed(CAROL, { body: `credential ${token}` }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('credential-shaped body');
    expect(body.error).not.toContain(token);
  });

  // Thread membership is COMPUTED from assignee + originator + watchers
  // + admins, so a reassignment used to drop the previous assignee out
  // of the thread the moment the objective left their plate — exactly
  // when they need to hand over. `reassign` now promotes them to
  // watcher, which is the only durable grant the model can express.
  it('lets the previous assignee post after a reassignment', async () => {
    const { app } = await makeApp();
    // bob originates, carol is assigned. carol is NOT the originator and
    // NOT an admin, so her only claim on the thread is being assignee.
    const obj = await createOne(app, BOB, { assignee: 'carol' });
    const before = await app.request(
      `/objectives/${obj.id}/discuss`,
      authed(CAROL, { body: 'mid-work' }),
    );
    expect(before.status).toBe(200);

    const re = await app.request(
      `/objectives/${obj.id}`,
      authed(ALICE, { assignee: 'dave' }, 'PATCH'),
    );
    expect(re.status).toBe(200);

    // The handover post — the whole point of the objective.
    const after = await app.request(
      `/objectives/${obj.id}/discuss`,
      authed(CAROL, { body: 'handover: here is where I got to' }),
    );
    expect(after.status).toBe(200);
  });

  it('records the promoted watcher in the objective and its audit log', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, BOB, { assignee: 'carol' });
    await app.request(`/objectives/${obj.id}`, authed(ALICE, { assignee: 'dave' }, 'PATCH'));

    const view = await app.request(`/objectives/${obj.id}`, authed(ALICE));
    const body = (await view.json()) as {
      objective: { assignee: string; watchers: string[] };
      events: Array<{ kind: string; payload: Record<string, unknown> }>;
    };
    expect(body.objective.assignee).toBe('dave');
    expect(body.objective.watchers).toContain('carol');
    // The grant is visible AND explained — a watcher nobody can account
    // for is worse than no watcher.
    const added = body.events.find((e) => e.kind === 'watcher_added' && e.payload.name === 'carol');
    expect(added?.payload.reason).toBe('reassigned-from');
  });

  // Turner's mirror case: a fix that grants the ex-assignee access while
  // quietly revoking someone else's would pass the test above.
  it('reassignment strips nobody else from the thread', async () => {
    const { app } = await makeApp();
    // alice originates (and is admin), bob is assigned, carol watches.
    const obj = await createOne(app, ALICE, { assignee: 'bob', watchers: ['carol'] });
    await app.request(`/objectives/${obj.id}`, authed(ALICE, { assignee: 'dave' }, 'PATCH'));

    for (const [token, who] of [
      [DAVE, 'new assignee'],
      [ALICE, 'originator/admin'],
      [CAROL, 'pre-existing watcher'],
    ] as const) {
      const res = await app.request(
        `/objectives/${obj.id}/discuss`,
        authed(token, { body: `still here: ${who}` }),
      );
      expect(res.status, `${who} lost thread access`).toBe(200);
    }

    const view = await app.request(`/objectives/${obj.id}`, authed(ALICE));
    const body = (await view.json()) as { objective: { watchers: string[] } };
    // The pre-existing watcher survives alongside the promoted one.
    expect(body.objective.watchers).toContain('carol');
    expect(body.objective.watchers).toContain('bob');
  });

  // The discriminating test: is membership a union of grants, or does
  // something actively revoke? A former assignee who was INDEPENDENTLY a
  // watcher keeps access either way — which proves nothing is revoked,
  // and that the old 403 was a derivation that stopped deriving.
  it('a former assignee who was already a watcher is unaffected and not double-added', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, BOB, { assignee: 'carol', watchers: ['dave'] });
    // Hand it to dave, who is both the incoming assignee and a watcher.
    await app.request(`/objectives/${obj.id}`, authed(ALICE, { assignee: 'dave' }, 'PATCH'));
    // Then hand it back off dave — he is now the FORMER assignee and was
    // a watcher before he ever held it.
    await app.request(`/objectives/${obj.id}`, authed(ALICE, { assignee: 'carol' }, 'PATCH'));

    const res = await app.request(
      `/objectives/${obj.id}/discuss`,
      authed(DAVE, { body: 'still a watcher' }),
    );
    expect(res.status).toBe(200);

    const view = await app.request(`/objectives/${obj.id}`, authed(ALICE));
    const body = (await view.json()) as { objective: { watchers: string[] } };
    expect(body.objective.watchers.filter((w) => w === 'dave')).toHaveLength(1);
  });

  it('returns 404 for unknown ids', async () => {
    const { app } = await makeApp();
    const res = await app.request('/objectives/obj-nope/discuss', authed(ALICE, { body: 'hi' }));
    expect(res.status).toBe(404);
  });

  it('posts one message to the whole thread, not one per member', async () => {
    const { app, broker } = await makeApp();
    // Thread members: carol (assignee), alice (originator + admin),
    // dave (watcher) — three connected members.
    const obj = await createOne(app, ALICE, { assignee: 'carol', watchers: ['dave'] });
    const pushSpy = vi.spyOn(broker, 'push');
    const res = await app.request(
      `/objectives/${obj.id}/discuss`,
      authed(CAROL, { body: 'one and only' }),
    );
    expect(res.status).toBe(200);
    // A per-member fanout loop would call push (and mint a message id)
    // once per thread member, which the web client rendered as one
    // duplicate per connected member. One multi-recipient push instead.
    expect(pushSpy).toHaveBeenCalledTimes(1);
    const [payload, context] = pushSpy.mock.calls[0] ?? [];
    expect(payload?.to).toBeUndefined();
    expect(context?.recipients).toEqual(expect.arrayContaining(['alice', 'carol', 'dave']));
  });
});

// ─── full-lifecycle audit log ────────────────────────────────────────

describe('end-to-end audit log via GET /objectives/:id', () => {
  it('records every transition, watcher mutation, and reassignment', async () => {
    const { app } = await makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    await app.request(
      `/objectives/${obj.id}`,
      authed(CAROL, { status: 'blocked', blockReason: 'waiting' }, 'PATCH'),
    );
    await app.request(`/objectives/${obj.id}`, authed(CAROL, { status: 'active' }, 'PATCH'));
    await app.request(`/objectives/${obj.id}`, authed(ALICE, { addWatchers: ['dave'] }, 'PATCH'));
    await app.request(`/objectives/${obj.id}`, authed(ALICE, { assignee: 'bob' }, 'PATCH'));
    await app.request(`/objectives/${obj.id}/complete`, authed(BOB, { result: 'shipped' }));
    const detail = await app.request(`/objectives/${obj.id}`, authed(ALICE));
    const body = (await detail.json()) as GetObjectiveResponse;
    expect(body.objective.status).toBe('done');
    // The second `watcher_added` is the reassignment promoting the
    // outgoing assignee (carol) to watcher, so she keeps thread access
    // to hand over. It follows `reassigned` in the same transaction.
    expect(body.events.map((e) => e.kind)).toEqual([
      'assigned',
      'blocked',
      'unblocked',
      'watcher_added',
      'reassigned',
      'watcher_added',
      'completed',
    ]);
  });
});
