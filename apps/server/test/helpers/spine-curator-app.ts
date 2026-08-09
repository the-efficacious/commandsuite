/**
 * One broker wired with a spine AND a curator, plus a fake delivery
 * sink, shared by the floor-only suite and the signals suite.
 *
 * WHY THE TWO SUITES SHARE THIS. The whole claim of phase 3 is that
 * floor signals change WHEN a member is re-oriented and never WHETHER.
 * A signals suite built on its own fixture cannot make that
 * comparison: any difference it found could be a difference between
 * two harnesses. Sharing the wiring is what makes "same scenario, same
 * end state, earlier" a measurement rather than a claim.
 *
 * THE CLOCK IS A VARIABLE. `clock.ms` is read on every curator call,
 * so a test moves four hours by assigning to it. No `vi.useFakeTimers`,
 * no sleeps, no interval to wait out — the sweep is called directly.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Message, Permission } from 'csuite-sdk/types';
import { PERMISSIONS } from 'csuite-sdk/types';
import { expect, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/db.js';
import { createMemberStore } from '../../src/members.js';
import { SessionStore } from '../../src/sessions.js';
import type { CuratorStore } from '../../src/spine/index.js';
import { createAnnexWritePath, createSqliteCuratorStore } from '../../src/spine/index.js';
import { createTokenStoreFromMembers } from '../../src/tokens.js';
import { mockTeamStore } from './test-stores.js';

export const LEA = 'csuite_curator_lea_token';
export const RUNE = 'csuite_curator_rune_token';
export const ANDREWJON = 'csuite_curator_andrewjon_token';
export const CORA = 'csuite_curator_cora_token';

export const TOKENS: Record<string, string> = {
  lea: LEA,
  rune: RUNE,
  andrewjon: ANDREWJON,
  cora: CORA,
};

const EVERY_OTHER_LEAF: Permission[] = PERMISSIONS.filter((p) => p !== 'spine.author');

export const T0 = 1_700_000_000_000;

/** One member's live sink — the fake broker subscriber every push is measured at. */
export interface Sink {
  name: string;
  messages: Message[];
  /** Only the curator's own injections, which is what every assertion here is about. */
  injections: Message[];
  close: () => void;
}

export function makeCuratorApp() {
  const clock = { ms: T0 };
  const broker = new Broker({ eventLog: new InMemoryEventLog(), now: () => clock.ms });
  const members = createMemberStore([
    {
      name: 'lea',
      role: { title: 'lead', description: '' },
      permissions: ['spine.author'],
      token: LEA,
    },
    { name: 'rune', role: { title: 'engineer', description: '' }, permissions: [], token: RUNE },
    {
      name: 'andrewjon',
      role: { title: 'director', description: '' },
      permissions: EVERY_OTHER_LEAF,
      token: ANDREWJON,
    },
    { name: 'cora', role: { title: 'engineer', description: '' }, permissions: [], token: CORA },
  ]);
  broker.seedMembers(members.members());
  const db = openDatabase(':memory:');
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const spine = createAnnexWritePath({ db, logger });

  /**
   * The curator store, WRAPPED so the floor-only suite can assert
   * behaviourally that no signal was ever acted on.
   *
   * `invalidateLeases` is the only thing `onSignal` does, so counting
   * calls to it is a true spy on the signal path — and unlike a source
   * grep for the string `onSignal`, it cannot be defeated by a rename,
   * by a helper, or by a route that reaches the curator some other
   * way. The name check that shipped first was defeated in review by
   * calling `curatorStore.invalidateLeases` through a harness helper:
   * thirty tests green, guard silent.
   */
  const signalActions: Array<{ member: string; by: string }> = [];
  const baseCuratorStore = createSqliteCuratorStore(db);
  const curatorStore = new Proxy(baseCuratorStore, {
    get(target, prop, receiver) {
      if (prop === 'invalidateLeases') {
        return (member: string, by: string, now: number, ttlMs: number): number => {
          signalActions.push({ member, by });
          return target.invalidateLeases(member, by, now, ttlMs);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as CuratorStore;
  // Exposed because the floor signals route is RUNNER-auth, and the
  // only way to prove that is to drive it with the other auth plane —
  // a browser session, which must be refused.
  const sessions = new SessionStore(db);
  const created = createApp({
    broker,
    members,
    tokens: createTokenStoreFromMembers(db, members),
    sessions,
    teamStore: mockTeamStore({ name: 'curator-team', context: '', permissionPresets: {} }),
    spine,
    spineCurator: curatorStore,
    now: () => clock.ms,
    version: '0.0.0',
    logger,
  });
  if (created.curator === undefined) {
    throw new Error('fixture wired a curator store but createApp built no curator');
  }
  const curator = created.curator;

  /**
   * Attach a live subscriber for `name`.
   *
   * Leases are granted on CONFIRMED delivery (`delivery.live > 0`), so
   * a member with no sink is a member nothing is confirmed to. That is
   * not a fixture detail to route around — it is the floor, and tests
   * that want a lease have to make delivery real.
   */
  const sinkFor = (name: string): Sink => {
    const messages: Message[] = [];
    const close = broker.subscribe(
      name,
      async (message) => {
        messages.push(message);
      },
      { name },
    );
    return {
      name,
      messages,
      get injections() {
        return messages.filter(
          (m) => (m.data as { kind?: string } | undefined)?.kind === 'spine_injection',
        );
      },
      close,
    };
  };

  return {
    app: created.app,
    curator,
    curatorStore,
    /** Every lease invalidation, i.e. every signal the curator acted on. */
    signalActions,
    spine,
    annex: spine.store,
    broker,
    members,
    sessions,
    db,
    clock,
    sinkFor,
  };
}

export type CuratorApp = ReturnType<typeof makeCuratorApp>;

export function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

export async function post(
  app: CuratorApp['app'],
  path: string,
  token: string,
  body: unknown,
  expected = 201,
): Promise<Record<string, unknown>> {
  const res = await app.request(path, authed(token, body));
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status !== expected) {
    throw new Error(
      `${path} returned ${res.status}, expected ${expected}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

export async function get(
  app: CuratorApp['app'],
  path: string,
  token: string,
  expected = 200,
): Promise<Record<string, unknown>> {
  const res = await app.request(path, authed(token));
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status !== expected) {
    throw new Error(
      `GET ${path} returned ${res.status}, expected ${expected}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

/** Bodies of every curator injection a sink received, joined for substring assertions. */
export function injectionText(sink: Sink): string {
  return sink.injections.map((m) => m.body).join('\n');
}

/**
 * THE FLOOR PROPERTY, ASSERTED BEHAVIOURALLY.
 *
 * Call this from the floor-only suite's `afterEach`. It makes two
 * claims no rename can defeat:
 *
 *   1. the curator never acted on a signal — `invalidateLeases`, the
 *      only thing `onSignal` does, was never called;
 *   2. no lease in the database carries an invalidation, which is the
 *      same fact read off the state rather than off the calls.
 *
 * Both, because they fail differently: a refactor that invalidates
 * through some other method defeats (1) and is caught by (2), and a
 * test that reaches into the DB to plant a row defeats (2) and is
 * caught by (1).
 */
export function assertNoSignalsWereUsed(harness: CuratorApp): void {
  expect(
    harness.signalActions,
    'the floor-only suite acted on a floor signal — its whole claim is that it does not',
  ).toEqual([]);
  expect(
    harness.curatorStore.leases().filter((lease) => lease.invalidatedAt !== null),
    'a lease was invalidated, which only a floor signal does',
  ).toEqual([]);
}
