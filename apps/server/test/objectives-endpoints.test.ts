/**
 * Objectives REST endpoint tests.
 *
 * Drives the `/objectives*` surface through the Hono request client
 * with three test members covering the relevant permission gates:
 *
 *   alice   — `members.manage` + `objectives.create` + `objectives.cancel` +
 *             `objectives.reassign` + `objectives.watch` (full admin)
 *   bob     — `objectives.create` + `objectives.cancel` (operator-ish)
 *   carol   — no permissions (baseline member)
 *
 * Store-level state-machine semantics live in objectives.test.ts;
 * here we verify auth gates, scoping, validation, payload shapes,
 * and the audit-log surfacing through `GET /objectives/:id`.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type {
  GetObjectiveResponse,
  ListObjectivesResponse,
  Objective,
  Team,
} from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { createSqliteObjectivesStore } from '../src/objectives.js';
import { SessionStore } from '../src/sessions.js';
import { createTokenStoreFromMembers } from '../src/tokens.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ALICE = 'csuite_test_alice_secret_token';
const BOB = 'csuite_test_bob_secret_token';
const CAROL = 'csuite_test_carol_secret_token';
const DAVE = 'csuite_test_dave_secret_token';

const TEAM: Team = {
  name: 'demo-team',
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
      role: { title: 'operator', description: '' },
      permissions: ['objectives.create', 'objectives.cancel'],
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
  ]);
  for (const name of ['alice', 'bob', 'carol', 'dave']) {
    void broker.register(name);
  }
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const tokens = createTokenStoreFromMembers(db, members);
  const objectives = createSqliteObjectivesStore(db);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore(TEAM),
    objectives,
    version: '0.0.0',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
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
  app: ReturnType<typeof makeApp>['app'],
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
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    expect(obj.id).toMatch(/^obj-/);
    expect(obj.assignee).toBe('carol');
    expect(obj.originator).toBe('alice');
    expect(obj.status).toBe('active');
  });

  it('rejects callers without objectives.create with 403', async () => {
    const { app } = makeApp();
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
    const { app } = makeApp();
    const res = await app.request('/objectives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', outcome: 'o', assignee: 'carol' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown assignee with 400', async () => {
    const { app } = makeApp();
    const res = await app.request(
      '/objectives',
      authed(ALICE, { title: 't', outcome: 'o', assignee: 'ghost' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown assignee/i);
  });

  it('rejects an unknown initial watcher with 400', async () => {
    const { app } = makeApp();
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
    const { app } = makeApp();
    const res = await app.request('/objectives', authed(ALICE, { title: 't' }));
    expect(res.status).toBe(400);
  });
});

// ─── GET /objectives ─────────────────────────────────────────────────

describe('GET /objectives', () => {
  it('returns team-wide list for callers with objectives.create', async () => {
    const { app } = makeApp();
    await createOne(app, ALICE, { assignee: 'carol' });
    await createOne(app, BOB, { assignee: 'dave' });
    const res = await app.request('/objectives', authed(ALICE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListObjectivesResponse;
    expect(body.objectives).toHaveLength(2);
  });

  it('scopes plain members to objectives where they participate', async () => {
    const { app } = makeApp();
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
    const { app } = makeApp();
    await createOne(app, ALICE, { assignee: 'dave', watchers: ['carol'] });
    const res = await app.request('/objectives', authed(CAROL));
    const body = (await res.json()) as ListObjectivesResponse;
    expect(body.objectives).toHaveLength(1);
  });

  it('rejects a plain member fishing with assignee filter for someone else', async () => {
    const { app } = makeApp();
    await createOne(app, ALICE, { assignee: 'dave' });
    const res = await app.request('/objectives?assignee=dave', authed(CAROL));
    expect(res.status).toBe(403);
  });

  it('accepts a self-scoped assignee filter from a plain member', async () => {
    const { app } = makeApp();
    await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request('/objectives?assignee=carol', authed(CAROL));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListObjectivesResponse;
    expect(body.objectives).toHaveLength(1);
  });

  it('rejects an invalid status filter with 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/objectives?status=garbage', authed(ALICE));
    expect(res.status).toBe(400);
  });
});

// ─── GET /objectives/:id ─────────────────────────────────────────────

describe('GET /objectives/:id', () => {
  it('returns the objective + event log to a thread participant', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(`/objectives/${obj.id}`, authed(CAROL));
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetObjectiveResponse;
    expect(body.objective.id).toBe(obj.id);
    expect(body.events.map((e) => e.kind)).toContain('assigned');
  });

  it('returns the objective to anyone with objectives.create', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    // bob is not a thread participant (alice originated, carol is
    // the assignee). bob has objectives.create so the gate passes.
    const res = await app.request(`/objectives/${obj.id}`, authed(BOB));
    expect(res.status).toBe(200);
  });

  it('rejects a non-participant without objectives.create with 403', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    // dave is not a participant and has no objectives.create.
    const res = await app.request(`/objectives/${obj.id}`, authed(DAVE));
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown ids', async () => {
    const { app } = makeApp();
    const res = await app.request('/objectives/obj-nope', authed(ALICE));
    expect(res.status).toBe(404);
  });
});

// ─── PATCH /objectives/:id ───────────────────────────────────────────

describe('PATCH /objectives/:id', () => {
  it('lets the assignee transition active → blocked with a reason', async () => {
    const { app } = makeApp();
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
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'dave' });
    // bob has objectives.cancel, isn't the assignee.
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(BOB, { status: 'blocked', blockReason: 'standdown' }, 'PATCH'),
    );
    expect(res.status).toBe(200);
  });

  it('rejects non-assignee, non-cancel members with 403', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'dave' });
    // carol has no permissions and isn't the assignee.
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(CAROL, { status: 'blocked', blockReason: 'no' }, 'PATCH'),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when blocking without a reason', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(CAROL, { status: 'blocked' }, 'PATCH'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 409 (terminal) when patching a done objective', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    await app.request(`/objectives/${obj.id}/complete`, authed(CAROL, { result: 'shipped' }));
    const res = await app.request(
      `/objectives/${obj.id}`,
      authed(CAROL, { status: 'blocked', blockReason: 'late' }, 'PATCH'),
    );
    expect(res.status).toBe(409);
  });

  it('returns 404 for unknown ids', async () => {
    const { app } = makeApp();
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
    const { app } = makeApp();
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
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}/complete`,
      authed(ALICE, { result: 'on her behalf' }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects a missing result with 400', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(`/objectives/${obj.id}/complete`, authed(CAROL, {}));
    expect(res.status).toBe(400);
  });

  it('returns 409 on double-complete', async () => {
    const { app } = makeApp();
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
    const { app } = makeApp();
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
    const { app } = makeApp();
    const obj = await createOne(app, BOB, { assignee: 'dave' });
    const res = await app.request(
      `/objectives/${obj.id}/cancel`,
      authed(ALICE, { reason: 'admin override' }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects assignee-without-permission cancelling not-their-own', async () => {
    const { app } = makeApp();
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
    const { app } = makeApp();
    const obj = await createOne(app, BOB, { assignee: 'dave' });
    const res = await app.request(`/objectives/${obj.id}/cancel`, authed(BOB, {}));
    expect(res.status).toBe(200);
  });

  it('returns 409 on cancelling a done objective', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    await app.request(`/objectives/${obj.id}/complete`, authed(CAROL, { result: 'r' }));
    const res = await app.request(`/objectives/${obj.id}/cancel`, authed(ALICE, {}));
    expect(res.status).toBe(409);
  });
});

// ─── POST /objectives/:id/reassign ───────────────────────────────────

describe('POST /objectives/:id/reassign', () => {
  it('reassigns to a different member when caller has objectives.reassign', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}/reassign`,
      authed(ALICE, { to: 'dave', note: 'context shift' }),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Objective;
    expect(updated.assignee).toBe('dave');
  });

  it('rejects callers without objectives.reassign with 403', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    // bob has objectives.cancel but not objectives.reassign.
    const res = await app.request(`/objectives/${obj.id}/reassign`, authed(BOB, { to: 'dave' }));
    expect(res.status).toBe(403);
  });

  it('rejects an unknown target assignee with 400', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(`/objectives/${obj.id}/reassign`, authed(ALICE, { to: 'ghost' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when reassigning to current assignee', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(`/objectives/${obj.id}/reassign`, authed(ALICE, { to: 'carol' }));
    expect(res.status).toBe(400);
  });
});

// ─── POST /objectives/:id/watchers ───────────────────────────────────

describe('POST /objectives/:id/watchers', () => {
  it('lets the originator add a watcher to their own objective', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}/watchers`,
      authed(ALICE, { add: ['dave'] }),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Objective;
    expect(updated.watchers).toContain('dave');
  });

  it('lets a member with objectives.watch add themselves', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, BOB, { assignee: 'dave' });
    // alice has objectives.watch, neither originator nor assignee.
    const res = await app.request(
      `/objectives/${obj.id}/watchers`,
      authed(ALICE, { add: ['alice'] }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects callers without watch permission and not the originator', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'dave' });
    const res = await app.request(
      `/objectives/${obj.id}/watchers`,
      authed(CAROL, { add: ['carol'] }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects unknown names in add or remove with 400', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(
      `/objectives/${obj.id}/watchers`,
      authed(ALICE, { add: ['ghost'] }),
    );
    expect(res.status).toBe(400);
  });

  it('combined add + remove returns the new watcher list', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol', watchers: ['bob'] });
    const res = await app.request(
      `/objectives/${obj.id}/watchers`,
      authed(ALICE, { add: ['dave'], remove: ['bob'] }),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Objective;
    expect(updated.watchers).toEqual(['dave']);
  });
});

// ─── POST /objectives/:id/discuss ────────────────────────────────────

describe('POST /objectives/:id/discuss', () => {
  it('lets a thread member post discussion', async () => {
    const { app } = makeApp();
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
    const { app } = makeApp();
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
    const { app } = makeApp();
    const obj = await createOne(app, BOB, { assignee: 'dave' });
    // carol is neither originator, assignee, watcher, nor admin.
    const res = await app.request(
      `/objectives/${obj.id}/discuss`,
      authed(CAROL, { body: 'wedge' }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects an empty body with 400', async () => {
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    const res = await app.request(`/objectives/${obj.id}/discuss`, authed(CAROL, { body: '' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown ids', async () => {
    const { app } = makeApp();
    const res = await app.request('/objectives/obj-nope/discuss', authed(ALICE, { body: 'hi' }));
    expect(res.status).toBe(404);
  });

  it('posts one message to the whole thread, not one per member', async () => {
    const { app, broker } = makeApp();
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
    const { app } = makeApp();
    const obj = await createOne(app, ALICE, { assignee: 'carol' });
    await app.request(
      `/objectives/${obj.id}`,
      authed(CAROL, { status: 'blocked', blockReason: 'waiting' }, 'PATCH'),
    );
    await app.request(`/objectives/${obj.id}`, authed(CAROL, { status: 'active' }, 'PATCH'));
    await app.request(`/objectives/${obj.id}/watchers`, authed(ALICE, { add: ['dave'] }));
    await app.request(`/objectives/${obj.id}/reassign`, authed(ALICE, { to: 'bob' }));
    await app.request(`/objectives/${obj.id}/complete`, authed(BOB, { result: 'shipped' }));
    const detail = await app.request(`/objectives/${obj.id}`, authed(ALICE));
    const body = (await detail.json()) as GetObjectiveResponse;
    expect(body.objective.status).toBe('done');
    expect(body.events.map((e) => e.kind)).toEqual([
      'assigned',
      'blocked',
      'unblocked',
      'watcher_added',
      'reassigned',
      'completed',
    ]);
  });
});
