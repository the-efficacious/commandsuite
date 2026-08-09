/**
 * One broker wired with a spine, shared by the endpoint and acceptance
 * suites.
 *
 * Shared rather than copied because the two suites must exercise the
 * SAME wiring: an acceptance test that passes against a fixture with a
 * different permission layout than the endpoint suite proves something
 * about a broker nobody runs.
 *
 * The cast of four is the one from issue #155, with the permission
 * layout the leaf actually needs tested:
 *
 *   lea        holds `spine.author`, and nothing else. Verifier.
 *   rune       holds nothing. Assignee, and a full participant —
 *              attempts, asks, discussion, completion.
 *   andrewjon  holds every OTHER leaf. The gate is this leaf, not
 *              seniority, and that is only provable with someone
 *              senior who does not hold it.
 *   cora       holds nothing. An independent third member.
 */

import { Broker, InMemoryEventLog } from 'csuite-core';
import type { Permission } from 'csuite-sdk/types';
import { PERMISSIONS } from 'csuite-sdk/types';
import { vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/db.js';
import { createMemberStore } from '../../src/members.js';
import { SessionStore } from '../../src/sessions.js';
import { createAnnexWritePath } from '../../src/spine/index.js';
import { createTokenStoreFromMembers } from '../../src/tokens.js';
import { mockTeamStore } from './test-stores.js';

export const LEA = 'csuite_test_spine_lea_token';
export const RUNE = 'csuite_test_spine_rune_token';
export const ANDREWJON = 'csuite_test_spine_andrewjon_token';
export const CORA = 'csuite_test_spine_cora_token';

/** Everything except the leaf under test — derived, so a new leaf joins it. */
export const EVERY_OTHER_LEAF: Permission[] = PERMISSIONS.filter((p) => p !== 'spine.author');

export function makeSpineApp() {
  const broker = new Broker({ eventLog: new InMemoryEventLog(), now: () => 1_700_000_000_000 });
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
  const db = openDatabase(':memory:');
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const spine = createAnnexWritePath({ db, logger });
  const { app } = createApp({
    broker,
    members,
    tokens: createTokenStoreFromMembers(db, members),
    sessions: new SessionStore(db),
    teamStore: mockTeamStore({ name: 'spine-team', context: '', permissionPresets: {} }),
    spine,
    version: '0.0.0',
    logger,
  });
  return { app, spine, annex: spine.store, members, db };
}

export type SpineApp = ReturnType<typeof makeSpineApp>['app'];

export function authed(token: string, body?: unknown, method?: string): RequestInit {
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  init.method = method ?? (body !== undefined ? 'POST' : 'GET');
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

/**
 * POST an event and assert the status before reading the effect.
 *
 * A fixture that 404s on an unwired store looks exactly like one whose
 * write succeeded and whose effect is being checked, so the status
 * comes first, every time.
 */
export async function post(
  app: SpineApp,
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
  app: SpineApp,
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
