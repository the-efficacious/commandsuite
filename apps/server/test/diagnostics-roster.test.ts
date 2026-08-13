/**
 * The agent-readable surface — criterion 2.
 *
 * This is the criterion that separates a diagnostic store from a log
 * table, and it is the one that was dropped from an earlier version of
 * the contract while compressing it to fit a length cap. Without it a
 * compliant deliverable is a retained, bounded, attributed log that no
 * agent can read: eight criteria satisfied, premise failed.
 *
 * The premise being: the product knew and nobody could find out. An
 * agent has to be able to learn that its OWN capture failed, from a
 * surface it already reads, without being told to go looking.
 *
 * `roster` is that surface, and `captureHealth` is the precedent.
 */

import {
  Broker,
  createApp,
  createDiagnosticStore,
  createTokenStoreFromMembers,
  type DiagnosticStore,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import type { RosterResponse, Team } from 'csuite-sdk/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { mockTeamStore } from './helpers/test-stores.js';

const TOKEN = 'csuite_test_member_secret';
const TEAM: Team = { name: 't', context: '', permissionPresets: {} };
const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

async function makeApp(withDiagnostics = true) {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const diagnostics: DiagnosticStore | undefined = withDiagnostics
    ? createDiagnosticStore(db)
    : undefined;
  const members = createMemberStore([
    { name: 'turner', role: { title: 'e', description: '' }, permissions: [], token: TOKEN },
  ]);
  const broker = new Broker({
    eventLog: new InMemoryEventLog(),
    now: () => 1,
    idFactory: () => 'm',
  });
  await broker.register('turner');
  const { app } = createApp({
    broker,
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    logger: quiet,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  });
  return { app, diagnostics };
}

async function roster(app: Awaited<Awaited<ReturnType<typeof makeApp>>>['app']) {
  const res = await app.request('/roster', { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200); // the precondition this test's meaning rests on
  return (await res.json()) as RosterResponse;
}

function turner(r: RosterResponse) {
  return r.connected.find((p) => p.name === 'turner');
}

describe('diagnostics on the roster', () => {
  it('an agent learns from an unmodified roster that its own capture failed', async () => {
    // No flag, no query parameter, no second endpoint. This is the
    // whole criterion: the surface an agent already reads carries it.
    const { app, diagnostics } = await makeApp();
    diagnostics?.emit.correlatorRawCaptureFailed('turner', new Error('x'));

    expect(turner(await roster(app))?.diagnosticsUnresolved).toBe(1);
  });

  it('reports zero EXPLICITLY rather than by omission', async () => {
    // The absence rule is the load-bearing part, and it is the OPPOSITE
    // of `activity`'s: absent means "this broker retains nothing and
    // has no opinion", never "clean". A broker that can answer says so.
    const { app } = await makeApp();
    const p = turner(await roster(app));

    expect(p?.diagnosticsUnresolved).toBe(0);
    expect(Object.hasOwn(p ?? {}, 'diagnosticsUnresolved')).toBe(true);
  });

  it('omits the fields entirely when no diagnostic store is wired', async () => {
    // The only case where absence is correct. A reader must not be able
    // to confuse "retains nothing" with "found nothing".
    const { app } = await makeApp(false);
    const p = turner(await roster(app));

    expect(p).toBeDefined();
    expect(Object.hasOwn(p ?? {}, 'diagnosticsUnresolved')).toBe(false);
    expect(Object.hasOwn(p ?? {}, 'diagnosticsRetention')).toBe(false);
  });

  it('an observed recovery clears the count on the surface', async () => {
    // Criterion 4 reaching the agent: healthy now, history still in the
    // store. Without this the surface would show permanent false
    // sickness, which is the worst possible debut for a signal whose
    // whole claim is that it tells the truth about health.
    const { app, diagnostics } = await makeApp();
    diagnostics?.emit.activityAppendFailed('turner', 2);
    expect(turner(await roster(app))?.diagnosticsUnresolved).toBe(1);

    diagnostics?.emit.activityAppended('turner');

    expect(turner(await roster(app))?.diagnosticsUnresolved).toBe(0);
    expect(diagnostics?.query({ member: 'turner', from: 0, to: Date.now() + 1000 }).count).toBe(1);
  });

  it('surfaces retention health, including unknown', async () => {
    // Criterion 8 reaching the agent. A store that cannot describe
    // itself must say so on the surface, not silently report from the
    // thing that broke.
    const { app, diagnostics } = await makeApp();
    expect(turner(await roster(app))?.diagnosticsRetention).toBe('healthy');

    // Break retention underneath a live broker.
    dbs[0]?.exec('DROP TABLE diagnostic_event');
    diagnostics?.emit.activityAppendFailed('turner', 1); // this write fails

    expect(turner(await roster(app))?.diagnosticsRetention).toBe('unknown');
  });

  it('a point-cause failure does not make a member permanently unresolved', async () => {
    // Point causes are history the moment they happen. If they created
    // unresolved state, every member would accumulate a permanent count
    // from their first malformed row — false sickness as the surface's
    // steady state.
    const { app, diagnostics } = await makeApp();
    diagnostics?.emit.genaistoreMalformedRowSkipped(1);

    expect(turner(await roster(app))?.diagnosticsUnresolved).toBe(0);
  });
});
