/**
 * Capture health on the roster surface.
 *
 * The detector being correct is not the deliverable — a gap nobody sees
 * is the defect this objective exists to remove. These tests are about
 * the SURFACE: that an unmodified `roster` call carries the state, that
 * every state is distinguishable from every other, and that adding the
 * field did not break a client compiled before it existed.
 *
 * `roster` is deliberately the carrier. It is the surface an agent
 * already reads without being told to, which is the whole point: a
 * signal you have to know to go looking for is the thing that failed
 * here in the first place.
 */

import type { CaptureHealth, CaptureHealthStore } from 'csuite-core';
import {
  Broker,
  createApp,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import type { RosterResponse, Team } from 'csuite-sdk/types';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { mockTeamStore } from './helpers/test-stores.js';

const TOKEN = 'csuite_test_member_secret';
const TEAM: Team = { name: 'demo-team', context: '', permissionPresets: {} };

/** A store that answers from a fixed map — the detector has its own tests. */
function fixedHealth(byMember: Record<string, CaptureHealth>): CaptureHealthStore {
  return { forMember: (name) => byMember[name] ?? { state: 'ok' } };
}

async function makeApp(captureHealth?: CaptureHealthStore) {
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1_700_000_000_000,
    idFactory: () => 'msg-fixed',
  });
  const members = createMemberStore([
    { name: 'turner', role: { title: 'engineer', description: '' }, permissions: [], token: TOKEN },
    {
      name: 'seamus',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: 'csuite_test_other_secret',
    },
  ]);
  const db = openDatabase(':memory:');
  const sessions = new SqliteSessionStore(db);
  const tokens = await createTokenStoreFromMembers(db, members);
  const { app } = createApp({
    broker,
    members,
    tokens,
    sessions,
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    ...(captureHealth !== undefined ? { captureHealth } : {}),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { app, broker, db };
}

/** Presence only appears once a member is registered. */
async function withPresence(captureHealth?: CaptureHealthStore) {
  const made = await makeApp(captureHealth);
  await made.broker.register('turner');
  await made.broker.register('seamus');
  return made;
}

async function roster(app: Awaited<ReturnType<typeof makeApp>>['app']): Promise<RosterResponse> {
  const res = await app.request('/roster', { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as RosterResponse;
}

/** Presences live under `connected` on the roster response. */
function find(r: RosterResponse, name: string) {
  return r.connected.find((p) => p.name === name);
}

describe('capture health on the roster', () => {
  it('an unmodified roster call shows a member in a definitive gap', async () => {
    // No flag, no query parameter, no second endpoint. The agent-facing
    // surface carries it by default or it does not close the objective.
    const { app } = await withPresence(
      fixedHealth({ turner: { state: 'gap', unmatchedMarkers: 323, since: 1 } }),
    );

    expect(find(await roster(app), 'turner')?.captureHealth).toBe('gap');
  });

  it('reports a healthy member EXPLICITLY rather than by omission', async () => {
    // The absence rule is the load-bearing part: absence must mean "old
    // broker, no opinion". A broker that can evaluate says so.
    const { app } = await withPresence(fixedHealth({ turner: { state: 'ok' } }));
    const p = find(await roster(app), 'turner');

    expect(p?.captureHealth).toBe('ok');
    expect(Object.hasOwn(p ?? {}, 'captureHealth')).toBe(true);
  });

  it('distinguishes unevaluated from healthy on the wire', async () => {
    // A Codex member is not assessed by the exact-match join at all.
    // Collapsing this to `ok` would make the surface claim a property
    // no code evaluated — which is the defect, not the fix.
    const { app } = await withPresence(
      fixedHealth({
        turner: { state: 'ok' },
        seamus: { state: 'unevaluated', reason: 'no-exact-match-adapter' },
      }),
    );
    const r = await roster(app);

    expect(find(r, 'seamus')?.captureHealth).toBe('unevaluated');
    expect(find(r, 'turner')?.captureHealth).toBe('ok');
  });

  it('omits the field entirely when the broker cannot evaluate at all', async () => {
    // No store wired: the broker has no opinion and must not manufacture
    // one. This is the ONLY case where the field is absent.
    const { app } = await withPresence(undefined);
    const p = find(await roster(app), 'turner');

    expect(p).toBeDefined();
    expect(Object.hasOwn(p ?? {}, 'captureHealth')).toBe(false);
  });

  it('does not surface the internal pending state', async () => {
    // Healthy correlation lag (p50 ~4.2s) leaves every normal turn
    // briefly unmatched. `pending` is evidence not yet earned, so it
    // reads as `ok` — no gap has been established.
    const { app } = await withPresence(fixedHealth({ turner: { state: 'pending' } }));
    const r = await roster(app);

    expect(find(r, 'turner')?.captureHealth).toBe('ok');
    expect(JSON.stringify(r)).not.toContain('pending');
  });

  it('a client compiled before this field still parses the roster', async () => {
    // The pre-change Presence shape, reconstructed. Adding a field is
    // only safe if an older client's schema tolerates it — if this ever
    // becomes `.strict()`, every deployed agent breaks on upgrade and
    // this test is the one that says so.
    const OldPresence = z.object({
      name: z.string(),
      connected: z.number(),
      createdAt: z.number(),
      lastSeen: z.number(),
      activity: z.string().optional(),
      busy: z.boolean().optional(),
    });
    const OldRoster = z.object({ connected: z.array(OldPresence) });

    const { app } = await withPresence(
      fixedHealth({ turner: { state: 'gap', unmatchedMarkers: 1, since: 1 } }),
    );
    const parsed = OldRoster.safeParse(await roster(app));

    expect(parsed.success).toBe(true);
  });
});
