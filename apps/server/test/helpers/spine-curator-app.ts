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
import { vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/db.js';
import { createMemberStore } from '../../src/members.js';
import { SessionStore } from '../../src/sessions.js';
import { createSqliteAnnexStore, createSqliteCuratorStore } from '../../src/spine/index.js';
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
  const spine = createSqliteAnnexStore(db);
  const curatorStore = createSqliteCuratorStore(db);
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
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    spine,
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
