/**
 * `GET /members` returns one shape, whichever branch serves it.
 *
 * One URL, two projection functions, chosen by permission. They emitted
 * different, non-nested field sets: the `members.manage` branch carried
 * `instructions` and no `kind`, the public branch carried `kind` and no
 * `instructions`. Neither was a subset of the other, so a caller WITH
 * the permission was served strictly less about a person than a caller
 * without it — and the consumer rule for an absent `kind` is "render
 * the neutral (agent) treatment", so the member-management panel would
 * have drawn every human on the team as an agent had it trusted its own
 * fetch. `Member extends Teammate`: the subtype cannot carry less.
 *
 * `identityId` is absent from both, now by declaration rather than by
 * accident — no wire type declares it, so these key sets are the
 * whole story.
 *
 * The assertions are exact key sets and a field-for-field superset
 * check. A `toMatchObject` here would pass against exactly the response
 * that had the bug.
 */

import {
  Broker,
  createApp,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
} from 'csuite-core';
import { PATHS } from 'csuite-sdk/protocol';
import { ListMembersResponseSchema } from 'csuite-sdk/schemas';
import type { Member, Team, Teammate } from 'csuite-sdk/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { silentLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const ADMIN_TOKEN = 'csuite_projection_test_admin_token';
const AGENT_TOKEN = 'csuite_projection_test_agent_token';
const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const TEAM: Team = { name: 'projection', context: '', permissionPresets: {} };

/** `alice` is TOTP-enrolled, so she is the member `kind` has an answer about. */
const MANAGE_KEYS = ['instructions', 'kind', 'name', 'permissions', 'role'];
const PUBLIC_KEYS = ['kind', 'name', 'permissions', 'role'];

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

async function makeApp() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const members = createMemberStore([
    {
      name: 'alice',
      role: { title: 'lead', description: 'runs the team' },
      permissions: ['members.manage'],
      token: ADMIN_TOKEN,
      // The fixture members in the existing member tests have no TOTP
      // secret, so a test that DID look at `kind` would have seen it
      // absent on every branch and proved nothing. This one enrolls.
      totpSecret: TEST_TOTP_SECRET,
    },
    {
      name: 'scout',
      role: { title: 'engineer', description: 'builds' },
      permissions: [],
      token: AGENT_TOKEN,
      instructions: 'stay on task',
    },
  ]);
  const { app } = createApp({
    broker: new Broker({ eventLog: new InMemoryEventLog(), now: () => 1, idFactory: () => 'm' }),
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore(TEAM),
    version: '0.0.0',
    persistMembers: vi.fn(),
    logger: silentLogger(),
  });
  return app;
}

async function listMembers(app: Awaited<ReturnType<typeof makeApp>>, token: string) {
  const res = await app.request(PATHS.members, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { members: Array<Member | Teammate> };
  return new Map(body.members.map((row) => [row.name, row as unknown as Record<string, unknown>]));
}

describe('GET /members projection parity', () => {
  it('serves the members.manage caller a superset of the public row', async () => {
    const app = await makeApp();

    const manage = await listMembers(app, ADMIN_TOKEN);
    const publicRows = await listMembers(app, AGENT_TOKEN);

    expect([...publicRows.keys()].sort()).toEqual([...manage.keys()].sort());
    for (const [name, pub] of publicRows) {
      for (const key of Object.keys(pub)) {
        expect(
          manage.get(name),
          `${name}.${key} missing from the manage projection`,
        ).toHaveProperty(key);
      }
    }
  });

  it('pins the exact key set each branch emits', async () => {
    const app = await makeApp();

    const manage = await listMembers(app, ADMIN_TOKEN);
    const publicRows = await listMembers(app, AGENT_TOKEN);

    expect(Object.keys(manage.get('alice') ?? {}).sort()).toEqual(MANAGE_KEYS);
    expect(Object.keys(publicRows.get('alice') ?? {}).sort()).toEqual(PUBLIC_KEYS);
    // `scout` is token-only: `kind` is OMITTED, not `'agent'`.
    expect(Object.keys(manage.get('scout') ?? {}).sort()).toEqual(
      MANAGE_KEYS.filter((k) => k !== 'kind'),
    );
    expect(Object.keys(publicRows.get('scout') ?? {}).sort()).toEqual(
      PUBLIC_KEYS.filter((k) => k !== 'kind'),
    );
  });

  it('reports a TOTP-enrolled human as a person to the administrator too', async () => {
    const app = await makeApp();

    const manage = await listMembers(app, ADMIN_TOKEN);

    expect(manage.get('alice')?.kind).toBe('person');
    expect(manage.get('alice')?.instructions).toBe('');
    expect(manage.get('scout')?.instructions).toBe('stay on task');
  });

  it('never emits identityId on either branch, and the schema does not declare one', async () => {
    const app = await makeApp();

    const manage = await listMembers(app, ADMIN_TOKEN);
    const publicRows = await listMembers(app, AGENT_TOKEN);

    for (const row of [...manage.values(), ...publicRows.values()]) {
      expect(Object.hasOwn(row, 'identityId')).toBe(false);
    }
    // And it does not reappear through the published schema either.
    const parsed = ListMembersResponseSchema.parse({ members: [...manage.values()] });
    for (const row of parsed.members) expect(Object.hasOwn(row, 'identityId')).toBe(false);
  });

  it('carries kind on the PATCH /members/:name response as well', async () => {
    const app = await makeApp();

    const res = await app.request(`${PATHS.members}/alice`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ instructions: 'ship it' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(MANAGE_KEYS);
    expect(body.kind).toBe('person');
  });
});
