/**
 * `GET /members/:name/telemetry`.
 *
 * The store was write-only for its entire life: `append` ran on every
 * OTLP ingest and `list` had no production caller anywhere — no route,
 * no SDK method, no UI. Every cost, token and lifecycle record an agent
 * exported went into SQLite and could only be read by opening the
 * database file by hand, while the docs advertised cost and token
 * telemetry as a feature of the product.
 *
 * The permission matrix is asserted in both directions, because a route
 * that refuses everyone satisfies every 403 assertion on its own.
 */

import {
  Broker,
  createApp,
  createTelemetryStore,
  createTokenStoreFromMembers,
  InMemoryEventLog,
  SqliteSessionStore,
  type TelemetryStore,
} from 'csuite-core';
import { MEMBER_PATHS } from 'csuite-sdk/protocol';
import type { Team } from 'csuite-sdk/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMemberStore } from '../src/members.js';
import { silentLogger } from './helpers/logger.js';
import { mockTeamStore } from './helpers/test-stores.js';

const READER = 'csuite_reader_token';
const SELF = 'csuite_self_token';
const STRANGER = 'csuite_stranger_token';
const TEAM: Team = { name: 'demo', context: 'ctx', permissionPresets: {} };

let app: ReturnType<typeof createApp>['app'];
let store: TelemetryStore;

function record(name: string, tsMs: number, attributes: Record<string, unknown> = {}) {
  return {
    signal: 'log' as const,
    name,
    tsUnixNano: tsMs * 1_000_000,
    tsMs,
    attributes,
    resource: {},
    scope: null,
    payload: {},
  };
}

beforeEach(async () => {
  const db = openDatabase(':memory:');
  store = createTelemetryStore(db, { logger: silentLogger() });
  const members = createMemberStore([
    {
      name: 'director',
      role: { title: 'director', description: '' },
      permissions: ['activity.read'],
      token: READER,
    },
    {
      name: 'worker',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: SELF,
    },
    {
      name: 'other',
      role: { title: 'engineer', description: '' },
      permissions: [],
      token: STRANGER,
    },
  ]);
  const created = createApp({
    broker: new Broker({ eventLog: new InMemoryEventLog() }),
    members,
    tokens: await createTokenStoreFromMembers(db, members),
    sessions: new SqliteSessionStore(db),
    teamStore: mockTeamStore(TEAM),
    telemetryStore: store,
    version: '0.0.0',
    logger: silentLogger(),
  });
  app = created.app;
});

function authed(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

async function get(path: string, token: string) {
  const resp = await app.request(path, authed(token));
  return { status: resp.status, body: (await resp.json()) as { telemetry?: unknown[] } };
}

describe('the records are readable at all', () => {
  it('serves what the OTLP ingest stored', async () => {
    store.append('worker', [
      record('api_request', 1_000, { model: 'claude-sonnet-4-6', cost_usd: 0.004 }),
    ]);

    const { status, body } = await get(MEMBER_PATHS.telemetry('worker'), SELF);

    expect(status).toBe(200);
    expect(body.telemetry).toHaveLength(1);
    // The attributes are the whole point — the cost and token numbers
    // live there, and a route that served rows without them would be
    // as useless as no route.
    expect(body.telemetry?.[0]).toMatchObject({
      signal: 'log',
      name: 'api_request',
      tsMs: 1_000,
      attributes: { model: 'claude-sonnet-4-6', cost_usd: 0.004 },
    });
  });

  it('returns an empty list for a member with no telemetry', async () => {
    const { status, body } = await get(MEMBER_PATHS.telemetry('worker'), SELF);
    expect(status).toBe(200);
    expect(body.telemetry).toEqual([]);
  });
});

describe('filters and paging', () => {
  beforeEach(() => {
    store.append('worker', [
      record('api_request', 1_000),
      record('api_error', 2_000),
      record('api_request', 3_000),
    ]);
  });

  it('bounds by from/to inclusively', async () => {
    const { body } = await get(`${MEMBER_PATHS.telemetry('worker')}?from=2000&to=3000`, SELF);
    expect(body.telemetry).toHaveLength(2);
  });

  it('filters by record name', async () => {
    const { body } = await get(`${MEMBER_PATHS.telemetry('worker')}?event=api_error`, SELF);
    expect(body.telemetry).toHaveLength(1);
    expect(body.telemetry?.[0]).toMatchObject({ name: 'api_error' });
  });

  it('pages forward with a composite cursor without repeating a row', async () => {
    const first = await get(`${MEMBER_PATHS.telemetry('worker')}?limit=2`, SELF);
    expect(first.body.telemetry).toHaveLength(2);
    const last = first.body.telemetry?.[1] as { id: number; tsMs: number };

    const second = await get(
      `${MEMBER_PATHS.telemetry('worker')}?cursor_ts=${last.tsMs}&cursor_id=${last.id}`,
      SELF,
    );
    expect(second.body.telemetry).toHaveLength(1);
    const next = second.body.telemetry?.[0] as { id: number } | undefined;
    expect(next?.id).toBeDefined();
    expect(next?.id).not.toBe(last.id);
  });

  it('rejects a half-supplied cursor rather than silently reading from the start', async () => {
    const resp = await app.request(
      `${MEMBER_PATHS.telemetry('worker')}?cursor_ts=1000`,
      authed(SELF),
    );
    expect(resp.status).toBe(400);
  });

  it('rejects a non-numeric bound', async () => {
    const resp = await app.request(`${MEMBER_PATHS.telemetry('worker')}?from=soon`, authed(SELF));
    expect(resp.status).toBe(400);
  });

  it('accepts a valid signal filter and refuses an invalid one', async () => {
    // Positive control beside the negative: a validator that rejected
    // everything would satisfy the 400 on its own.
    const ok = await app.request(`${MEMBER_PATHS.telemetry('worker')}?signal=log`, authed(SELF));
    expect(ok.status).toBe(200);
    const bad = await app.request(`${MEMBER_PATHS.telemetry('worker')}?signal=trace`, authed(SELF));
    expect(bad.status).toBe(400);
  });
});

describe('who can read it', () => {
  beforeEach(() => {
    store.append('worker', [record('api_request', 1_000)]);
  });

  it('a member reads their own', async () => {
    expect((await get(MEMBER_PATHS.telemetry('worker'), SELF)).status).toBe(200);
  });

  it('activity.read reads anyone', async () => {
    expect((await get(MEMBER_PATHS.telemetry('worker'), READER)).status).toBe(200);
  });

  it("a member without activity.read cannot read someone else's", async () => {
    const resp = await app.request(MEMBER_PATHS.telemetry('worker'), authed(STRANGER));
    expect(resp.status).toBe(403);
  });

  it('an unauthenticated request is refused', async () => {
    const resp = await app.request(MEMBER_PATHS.telemetry('worker'));
    expect(resp.status).toBe(401);
  });
});
