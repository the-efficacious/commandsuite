/**
 * `POST /members/:name/context` — the broker-originated compact/clear
 * verb.
 *
 * Two contracts are under test, and the second is the one most likely
 * to rot:
 *
 *  1. THE AUTHORITY SPLIT. Reaching into a teammate's running
 *     conversation needs `members.context`; asking your OWN runner does
 *     not, because an agent compacting itself is doing what it could
 *     already do by typing the slash command. A suite that only
 *     asserted "403 without the permission" would pass against an
 *     implementation that also refused self.
 *  2. THE RESPONSE MEANS PUSHED, NOT DONE. The endpoint answers when
 *     the control has been fanned out, and the payload it stamps is
 *     what the runner correlates its outcome against. A response
 *     missing `requestId`, or a push missing it, would leave every
 *     request permanently unresolvable.
 */

import {
  Broker,
  createDiagnosticStore,
  createGenAiStore,
  createTelemetryStore,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import type { Message, Permission, Team } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { createRawBodyStore } from '../src/raw-body-store.js';
import { mockTeamStore } from './helpers/test-stores.js';

const TEAM: Team = { name: 'demo-team', context: '', permissionPresets: {} };
const DIRECTOR_TOKEN = 'csuite_test_director';
const WORKER_TOKEN = 'csuite_test_worker';

async function makeApp(directorPermissions: Permission[] = ['members.context']) {
  const broker = new Broker({ eventLog: new InMemoryEventLog() });
  const members = createMemberStore([
    {
      name: 'director',
      role: { title: 'director', description: '' },
      permissions: directorPermissions,
      token: DIRECTOR_TOKEN,
    },
    {
      name: 'worker',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: WORKER_TOKEN,
    },
  ]);
  const db = openDatabase(':memory:');
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const tokens = await createTokenStoreFromMembers(db, members);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions: new SqliteSessionStore(db),
    genaiStore: createGenAiStore(db, { logger }),
    rawBodyStore: createRawBodyStore(db, { logger }),
    telemetryStore: createTelemetryStore(db, { logger }),
    diagnostics: createDiagnosticStore(db),
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    logger,
  });
  return { app, broker };
}

function post(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  target: string,
  body: unknown,
  token: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/members/${target}/context`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Capture what the broker fans out to a name while `fn` runs. */
async function capturePush(
  broker: Broker,
  name: string,
  fn: () => Promise<Response>,
): Promise<{ res: Response; messages: Message[] }> {
  const messages: Message[] = [];
  // The core Broker is callback-based (the async-iterable `subscribe`
  // is the SDK client's wrapper over the wire), and registering a
  // subscriber is also what makes this member count as connected —
  // which is what `delivered` reads.
  const unsubscribe = broker.subscribe(name, (m) => {
    messages.push(m);
  });
  try {
    const res = await fn();
    return { res, messages };
  } finally {
    unsubscribe();
  }
}

describe('authority', () => {
  it('lets a member control its OWN context with no permission at all', async () => {
    const { app } = await makeApp();
    // The positive control for the 403 below. Self-care must not be a
    // privilege — this is the case a permission-only suite loses.
    const res = await post(app, 'worker', { verb: 'compact' }, WORKER_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target).toBe('worker');
    expect(body.verb).toBe('compact');
  });

  it('refuses a member reaching into someone ELSE without members.context', async () => {
    const { app } = await makeApp();
    const res = await post(app, 'director', { verb: 'clear' }, WORKER_TOKEN);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('members.context');
  });

  it('allows the cross-member control once members.context is held', async () => {
    const { app } = await makeApp(['members.context']);
    const res = await post(app, 'worker', { verb: 'clear' }, DIRECTOR_TOKEN);
    expect(res.status).toBe(200);
  });

  it('does NOT accept members.manage as a substitute', async () => {
    // The roster-and-credential authority is a different power over a
    // different object. If this ever starts passing, the dedicated leaf
    // has been quietly collapsed into the general admin one.
    const { app } = await makeApp(['members.manage']);
    const res = await post(app, 'worker', { verb: 'compact' }, DIRECTOR_TOKEN);
    expect(res.status).toBe(403);
  });

  it('401s without auth and 404s for an unknown member', async () => {
    const { app } = await makeApp();
    const unauthed = await app.request('/members/worker/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verb: 'compact' }),
    });
    expect(unauthed.status).toBe(401);

    const missing = await post(app, 'nobody', { verb: 'compact' }, DIRECTOR_TOKEN);
    expect(missing.status).toBe(404);
  });
});

describe('validation', () => {
  it('rejects an unknown verb but accepts both real ones', async () => {
    const { app } = await makeApp();
    const bad = await post(app, 'worker', { verb: 'shutdown' }, WORKER_TOKEN);
    expect(bad.status).toBe(400);

    // Positive control: the validity check must still admit the
    // nearest valid things.
    for (const verb of ['compact', 'clear']) {
      const ok = await post(app, 'worker', { verb }, WORKER_TOKEN);
      expect(ok.status, verb).toBe(200);
      expect((await ok.json()).verb).toBe(verb);
    }
  });

  it('rejects a missing body and an over-long reason, but accepts a normal one', async () => {
    const { app } = await makeApp();
    expect((await post(app, 'worker', {}, WORKER_TOKEN)).status).toBe(400);
    expect(
      (await post(app, 'worker', { verb: 'compact', reason: 'x'.repeat(501) }, WORKER_TOKEN))
        .status,
    ).toBe(400);
    expect(
      (await post(app, 'worker', { verb: 'compact', reason: 'context is full' }, WORKER_TOKEN))
        .status,
    ).toBe(200);
  });
});

describe('the push the runner acts on', () => {
  it('fans out a correlatable control carrying every field the ack needs', async () => {
    const { app, broker } = await makeApp(['members.context']);
    const { res, messages } = await capturePush(broker, 'worker', () =>
      post(app, 'worker', { verb: 'clear', reason: 'stuck for two hours' }, DIRECTOR_TOKEN),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    const control = messages.find(
      (m) => (m.data as Record<string, unknown>)?.kind === 'context_control',
    );
    expect(control, 'the control never reached the member stream').toBeDefined();
    // Assert the whole data block, not that a field appeared: a
    // partially-stamped control is executable but not correlatable,
    // which is worse than one that never arrived.
    expect(control?.data).toEqual({
      kind: 'context_control',
      requestId: body.requestId,
      verb: 'clear',
      target: 'worker',
      requestedBy: 'director',
      reason: 'stuck for two hours',
    });
    // The sender is broker-stamped, never taken from the payload.
    expect(control?.from).toBe('csuite');
  });

  it('names the target IN THE PAYLOAD, because the envelope does not', async () => {
    // A recipient-list push leaves `to` null, so `data.target` is the
    // only statement of who a control is for. The runner checks it
    // before executing; this asserts the broker actually supplies it.
    const { app, broker } = await makeApp(['members.context']);
    const { messages } = await capturePush(broker, 'worker', () =>
      post(app, 'worker', { verb: 'compact' }, DIRECTOR_TOKEN),
    );
    const control = messages.find(
      (m) => (m.data as Record<string, unknown>)?.kind === 'context_control',
    );
    expect(control, 'the control never reached the member stream').toBeDefined();
    expect(control?.to).toBeNull();
    expect((control?.data as Record<string, unknown>)?.target).toBe('worker');
  });

  it('does not copy the control to the requester', async () => {
    // The recipient path also delivers to the sender, but `from` here
    // is the synthetic `csuite` identity rather than the director, so
    // the director's own runner never sees it. Asserted because the
    // alternative — a director's agent executing the control it issued
    // against a teammate — is silent and severe, and because this is
    // the property the runner's target check is a backstop for.
    const { app, broker } = await makeApp(['members.context']);
    const { messages } = await capturePush(broker, 'director', () =>
      post(app, 'worker', { verb: 'compact' }, DIRECTOR_TOKEN),
    );
    expect(
      messages.filter((m) => (m.data as Record<string, unknown>)?.kind === 'context_control'),
    ).toEqual([]);
  });

  it('omits `reason` from the push rather than stamping it undefined', async () => {
    const { app, broker } = await makeApp(['members.context']);
    const { messages } = await capturePush(broker, 'worker', () =>
      post(app, 'worker', { verb: 'compact' }, DIRECTOR_TOKEN),
    );
    const control = messages.find(
      (m) => (m.data as Record<string, unknown>)?.kind === 'context_control',
    );
    expect(control?.data).not.toHaveProperty('reason');
  });

  it('issues a distinct requestId per control', async () => {
    const { app } = await makeApp();
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = await post(app, 'worker', { verb: 'compact' }, WORKER_TOKEN);
      seen.add((await res.json()).requestId);
    }
    // A reused id would let one outcome close out a different request.
    expect(seen.size).toBe(3);
  });

  it('reports delivered=false when nothing is subscribed, true when something is', async () => {
    const { app, broker } = await makeApp(['members.context']);

    const offline = await post(app, 'worker', { verb: 'compact' }, DIRECTOR_TOKEN);
    expect((await offline.json()).delivered).toBe(false);

    const { res } = await capturePush(broker, 'worker', () =>
      post(app, 'worker', { verb: 'compact' }, DIRECTOR_TOKEN),
    );
    // Both directions asserted: a field hardcoded either way passes
    // only one of these.
    expect((await res.json()).delivered).toBe(true);
  });
});
